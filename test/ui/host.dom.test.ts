// @vitest-environment jsdom
/**
 * The host, driven through its real wires.
 *
 * Everything below is the shipping `ReceiverHost` talking to the shipping
 * `PlaybackEngine` and, where the sheet is what is being asserted, the shipping
 * register's real DOM. The only things replaced are the four things that live
 * outside the renderer — the preload bridge, the media element, WebAudio, and
 * the frame clock — and none of them decides anything: they report what a test
 * says the world is doing and the host derives the rest, which is the only way
 * an assertion about Law 2 can mean anything.
 *
 * Three defects are pinned here:
 *
 *   · RECONNECT's candidate walk *clamped* instead of rotating, so on a
 *     three-mount PLS every press after the third retried the same dead mount;
 *   · a scope changed while a fetch was in flight let that fetch's rows be
 *     published as the answer to the new scope — 5 933 POP rows printed under
 *     ON AIR NOW · MOST LISTENED with an exact-looking count and CUT BAND live;
 *   · `DebouncedWriter.flush()` dropped the pending value when a write was
 *     already in flight, which is every `pagehide` that lands mid-write.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReceiverHost, rotateCandidates } from '../../src/renderer/host/host';
import { DebouncedWriter } from '../../src/renderer/host/persist';
import { createRegister, type RegisterHandle } from '../../src/renderer/ui/components/register';
import { createLid, type LidHandle } from '../../src/renderer/ui/components/lid';
import { supersetKey } from '../../src/renderer/ui/register/facets';
import {
  DEFAULT_SETTINGS,
  EMPTY_SCOPE,
  INITIAL_PLAYBACK_STATE,
  emptyScope,
  type Band,
  type BandSlot,
  type Cut,
  type GenreTag,
  type PlaybackState,
  type Preset,
  type RegisterIndex,
  type RegisterScope,
  type ResolveFailure,
  type Settings,
  type StationRef,
} from '../../src/shared/contracts';
import type { BrowseResults, FaceplateHandle, PanelNotice } from '../../src/renderer/ui/types';
import { createReadout } from '../../src/renderer/ui/components/readout';
import { FakeAudioElement, installWebAudio } from '../helpers/fakeDeck';
import type { ProxyEvent, ProxyMetadata, ProxySessionStats } from '../../src/main/proxy/types';

// ---------------------------------------------------------------------------
// The world outside the renderer
// ---------------------------------------------------------------------------

class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** Every media element the engine builds, so a test can drive the current one. */
const elements: FakeAudioElement[] = [];

/**
 * The preload bridge, as a set of dials a test turns.
 *
 * Nothing here has an opinion: the directory answers when the test lets it, the
 * proxy mints or refuses when the test says so, and the stats it broadcasts are
 * whatever the test declares the session to be doing.
 */
class FakeBridge {
  index: RegisterIndex | null = null;

  /** Rows to answer with, chosen from the query. Set by each test. */
  answer: (query: { genre?: string; countryCode?: string; language?: string; text?: string }) => StationRef[] =
    () => [];

  /** Held searches, newest last: call one to let its answer through. */
  readonly gates: Array<() => void> = [];
  /** Queries seen, in order. */
  readonly queries: Array<Record<string, unknown>> = [];
  /** Set to hold every search until the test releases it. */
  hold = false;

  /** Streams the resolver offers, in preference order. */
  streams: string[] = ['http://mount/0'];
  /**
   * A resolve that fails instead. The whole point is that the *raw* message rides
   * along untouched: the assertion is about what the panel does with it.
   */
  resolveFailure: ResolveFailure | null = null;
  /** Settings on disk. A relaunch is `mount()` with these already written. */
  onDisk: Settings = { ...DEFAULT_SETTINGS, scope: emptyScope() };
  /** The directory is unreachable — a fault, not an empty answer. */
  searchFails = false;
  /** Upstream URLs the engine actually asked the proxy to open, in order. */
  readonly minted: string[] = [];
  /**
   * Which mounts refuse to open. A refused mint is how a tune reaches a terminal
   * fault, and per-URL because a PLS with one dead entry and one live one is the
   * whole reason the candidate walk exists.
   */
  refuse: (url: string) => boolean = () => false;

  readonly savedSettings: Settings[] = [];

  private seq = 0;
  private statsSubs = new Set<(s: ProxySessionStats) => void>();
  private metaSubs = new Set<(m: ProxyMetadata) => void>();
  private eventSubs = new Set<(e: ProxyEvent) => void>();
  private current?: string;

  stats(patch: Partial<ProxySessionStats> = {}): void {
    const sessionId = this.current;
    if (!sessionId) return;
    const full: ProxySessionStats = {
      sessionId,
      bytesReceived: 0,
      bytesUpstream: 0,
      connected: true,
      stalled: false,
      prerollSeconds: 2,
      prerollHeldBytes: 0,
      prerollComplete: true,
      pipelineSeconds: 4,
      startedAt: Date.now(),
      ...patch,
    };
    for (const cb of this.statsSubs) cb(full);
  }

  install(): void {
    const noop = async (): Promise<void> => {};
    const bridge = {
      api: 1,
      proxy: {
        start: async (upstreamUrl: string) => {
          this.minted.push(upstreamUrl);
          if (this.refuse(upstreamUrl)) throw new Error('EPERM: the proxy could not bind a port');
          const sessionId = `s${++this.seq}`;
          this.current = sessionId;
          return { url: `http://127.0.0.1:9/stream?s=${sessionId}`, sessionId, port: 9, prerollSeconds: 2 };
        },
        stop: noop,
        stopAll: noop,
        onStats: (cb: (s: ProxySessionStats) => void) => {
          this.statsSubs.add(cb);
          return () => this.statsSubs.delete(cb);
        },
        onMetadata: (cb: (m: ProxyMetadata) => void) => {
          this.metaSubs.add(cb);
          return () => this.metaSubs.delete(cb);
        },
        onEvent: (cb: (e: ProxyEvent) => void) => {
          this.eventSubs.add(cb);
          return () => this.eventSubs.delete(cb);
        },
      },
      settings: {
        load: async () => this.onDisk,
        save: async (value: Settings) => {
          this.savedSettings.push(value);
          // A real settings file: the next launch reads what the last one wrote.
          this.onDisk = value;
        },
      },
      memory: { load: async () => ({ presets: [] as Preset[] }), save: noop },
      directory: {
        listGenres: async () => ({ ok: true, value: [] }),
        listIndex: async () =>
          this.index ? { ok: true, value: this.index } : { ok: false, failure: { kind: 'network', message: 'no' } },
        search: async (query: Record<string, unknown>) => {
          this.queries.push(query);
          const rows = this.answer(query);
          if (this.hold) await new Promise<void>((resolve) => this.gates.push(resolve));
          // A directory that cannot be reached, which is a different thing from
          // one that answers with nothing: only the first is a fault the panel's
          // recovery control has any business retrying.
          if (this.searchFails) {
            return { ok: false, failure: { kind: 'network', message: 'no route to the mirror' } };
          }
          return { ok: true, value: rows };
        },
        reportListening: noop,
      },
      resolver: {
        resolve: async () =>
          this.resolveFailure
            ? { ok: false, failure: this.resolveFailure }
            : {
                ok: true,
                streams: this.streams.map((url) => ({
                  url,
                  contentType: 'audio/mpeg',
                  supportsIcyMetadata: false,
                  origin: 'direct',
                })),
              },
      },
      app: { info: async () => ({}), capturePage: async () => '' },
      reportPlaybackState: () => {},
    };
    (window as unknown as Record<string, unknown>).psppcpr = bridge;
  }
}

/**
 * A faceplate that records instead of painting — except for the register, which
 * is the real component, mounted, because the sheet is what several of these
 * tests read.
 */
interface Rig {
  host: ReceiverHost;
  bridge: FakeBridge;
  register: RegisterHandle;
  browse: BrowseResults[];
  states: PlaybackState[];
  /** Every reading pushed down the needle's fast path, in order. */
  levels: number[];
  /** Every band the host pushed to the faceplate, in order. */
  bands: Band[];
  /** Every annunciator message, in order. The panel's whole voice. */
  notices: Array<PanelNotice | null>;
  /** Every `setCut` the host made, in order. */
  cuts: Array<{ cut: Cut | null; index: number; struck: boolean }>;
  element(): FakeAudioElement;
  /** Everything a 25 ms poll of the sheet reads, in one frame. */
  frame(): { scope: string; count: string; cut: string; cutDead: boolean };
  destroy(): void;
}

function tag(name: string, stationCount: number, spellings = [name]): GenreTag {
  return { name, stationCount, spellings };
}

function station(over: Partial<StationRef> & { id: string }): StationRef {
  return {
    name: over.id.toUpperCase(),
    url: `http://example.invalid/${over.id}`,
    tags: [],
    popularity: 0.5,
    clickCount: 1,
    ...over,
  };
}

const index: RegisterIndex = {
  source: 'fixture',
  pulledAt: 1,
  totals: { stations: 12000, tags: 2477, countries: 241, languages: 600 },
  subjects: [tag('pop', 5629), tag('jazz', 1402)],
  origins: [{ code: 'FR', name: 'France', stationCount: 771 }],
  tongues: [{ name: 'french', stationCount: 700 }],
};

function rows(prefix: string, n: number, over: Partial<StationRef> = {}): StationRef[] {
  const out: StationRef[] = [];
  for (let i = 0; i < n; i++) out.push(station({ id: `${prefix}-${i}`, clickCount: n - i, ...over }));
  return out;
}

let audio: ReturnType<typeof installWebAudio>;
let rig: Rig | null = null;

function mount(configureBridge: (bridge: FakeBridge) => void = () => {}): Rig {
  const bridge = new FakeBridge();
  bridge.index = index;
  configureBridge(bridge);
  bridge.install();

  const register = createRegister({
    onScope: () => {},
    onSelect: () => {},
    onCut: () => {},
    onReprint: () => {},
    onClose: () => {},
  });
  document.body.append(register.root);

  const browse: BrowseResults[] = [];
  const states: PlaybackState[] = [];
  const bands: Band[] = [];
  const notices: Array<PanelNotice | null> = [];
  const cuts: Array<{ cut: Cut | null; index: number; struck: boolean }> = [];
  let cut: Cut | null = null;

  /** Levels pushed down the needle's fast path, in order. */
  const levels: number[] = [];

  const handle: FaceplateHandle = {
    render: (state: PlaybackState, band: Band) => {
      states.push(state);
      if (bands.at(-1) !== band) bands.push(band);
    },
    renderLevel: (level: number) => {
      levels.push(level);
    },
    setIndex: (i, fault) => register.setIndex(i, fault),
    setBrowseResults: (results) => {
      browse.push(results);
      // Exactly the wire the shipping faceplate is: rows plus what the host says
      // about them, nothing added and nothing dropped.
      register.setRows(results.stations, {
        loading: results.loading,
        key: results.key,
        fault: results.error,
        warning: results.warning,
      });
    },
    setScope: (scope) => register.setScope(scope),
    setCut: (next, index, struck) => {
      cut = next;
      cuts.push({ cut: next, index, struck });
    },
    setPresets: () => {},
    setNotice: (notice: PanelNotice | null) => {
      notices.push(notice);
    },
    setLog: () => {},
    setLidOpen: () => {},
    isLidOpen: () => false,
    destroy: () => {},
  };

  const host = new ReceiverHost();
  host.attach(handle);

  const text = (sel: string): string => (register.root.querySelector(sel)?.textContent ?? '').trim();
  return {
    host,
    bridge,
    register,
    browse,
    states,
    levels,
    bands,
    notices,
    cuts,
    element: () => elements[elements.length - 1]!,
    frame: () => ({
      scope: text('.sheet__scope'),
      count: text('.sheet__count'),
      cut: text('.cut__sub'),
      cutDead: !!register.root.querySelector('.cut.is-dead'),
    }),
    destroy: () => {
      host.dispose();
      register.destroy();
      register.root.remove();
      void cut;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
  });
  elements.length = 0;
  audio = installWebAudio();
  vi.stubGlobal(
    'Audio',
    class extends FakeAudioElement {
      constructor() {
        super();
        elements.push(this);
      }
    },
  );
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  // jsdom implements no media queries. The panel asks exactly one question of
  // them — prefers-reduced-motion — and the honest answer for a test box is no.
  if (!window.matchMedia) {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
  }
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => setTimeout(() => fn(0), 16) as unknown as number);
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = function noop(): void {};
});

afterEach(() => {
  rig?.destroy();
  rig = null;
  delete (window as unknown as Record<string, unknown>).psppcpr;
  audio.restore();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/**
 * Let boot() run: settings, memory, index, first scope fetch.
 *
 * `configure` runs *after* the host is constructed, which is right for anything
 * boot merely reads later. Anything boot reads immediately — the settings file —
 * has to be on disk before `attach`, which is what `preconfigure` is for.
 */
async function booted(
  configure: (bridge: FakeBridge) => void = () => {},
  preconfigure: (bridge: FakeBridge) => void = () => {},
): Promise<Rig> {
  const r = mount(preconfigure);
  configure(r.bridge);
  await vi.advanceTimersByTimeAsync(50);
  return r;
}

// ---------------------------------------------------------------------------
// RECONNECT's candidate walk
// ---------------------------------------------------------------------------

describe('the candidate rotation', () => {
  it('is modular, so the walk laps instead of sticking on the last mount', () => {
    const mounts = ['a', 'b', 'c'];
    const walk = [0, 1, 2, 3, 4, 5, 6].map((start) => rotateCandidates(mounts, start)[0]);
    expect(walk).toEqual(['a', 'b', 'c', 'a', 'b', 'c', 'a']);
  });

  it('keeps the whole list, in order, from wherever it starts', () => {
    expect(rotateCandidates(['a', 'b', 'c'], 1)).toEqual(['b', 'c', 'a']);
    expect(rotateCandidates(['a', 'b', 'c'], 4)).toEqual(['b', 'c', 'a']);
    expect(rotateCandidates([], 3)).toEqual([]);
    expect(rotateCandidates(['a'], 9)).toEqual(['a']);
  });

  it('presses RECONNECT past the end of a 3-mount PLS and gets the head back', async () => {
    rig = await booted((b) => {
      b.answer = () => rows('idle', 4);
      b.streams = ['http://mount/0', 'http://mount/1', 'http://mount/2'];
      b.refuse = () => true; // every attempt ends in a terminal fault
    });
    const r = rig;

    r.host.handlers.onCut(rows('idle', 4), 'TEST', 'ANY RATE');
    await vi.advanceTimersByTimeAsync(300);
    expect(r.bridge.minted).toHaveLength(1);

    for (let press = 0; press < 5; press++) {
      r.host.handlers.onReconnect();
      await vi.advanceTimersByTimeAsync(300);
    }

    // The tune, then five presses. Clamping produced 0,1,2,2,2,2.
    expect(r.bridge.minted).toEqual([
      'http://mount/0',
      'http://mount/1',
      'http://mount/2',
      'http://mount/0',
      'http://mount/1',
      'http://mount/2',
    ]);
  });

  it('goes back to the resolver’s own preference once a mount has really played', async () => {
    // Mount 0 is dead, mount 1 works. RECONNECT walks to it; the session then
    // plays for long enough to prove itself, which retires the walk.
    const stations = rows('idle', 4);
    rig = await booted((b) => {
      b.answer = () => stations;
      b.streams = ['http://mount/0', 'http://mount/1', 'http://mount/2'];
      b.refuse = (url) => url === 'http://mount/0';
    });
    const r = rig;

    r.host.handlers.onCut(stations, 'TEST', 'ANY RATE');
    await vi.advanceTimersByTimeAsync(300);
    expect(r.bridge.minted).toEqual(['http://mount/0']);

    // Nothing below asserts a phase: the decoded level, the bytes and the
    // element's own advance are declared, and the engine derives the rest.
    audio.setLevel(0.2);
    r.host.handlers.onReconnect();
    await vi.advanceTimersByTimeAsync(200);
    expect(r.bridge.minted.at(-1)).toBe('http://mount/1');
    r.bridge.stats({ bytesReceived: 64_000 });
    r.element().ready(4);
    await vi.advanceTimersByTimeAsync(400);
    for (let i = 0; i < 26; i++) {
      r.bridge.stats({ bytesReceived: 64_000 + i * 16_000 });
      await vi.advanceTimersByTimeAsync(500);
    }
    const settled = r.states.at(-1)!;
    expect(settled.phase).toBe('playing');
    expect(settled.playingSeconds).toBeGreaterThan(10);

    // Come back to the station later. The walk is over, so the resolver's own
    // preferred mount is offered again rather than the one RECONNECT limped to
    // — which is what "keeps every candidate reachable" has to mean for a mount
    // that has since come back.
    const before = r.bridge.minted.length;
    r.host.handlers.onSelectStation(stations[1]!.id);
    await vi.advanceTimersByTimeAsync(300);
    r.host.handlers.onSelectStation(stations[0]!.id);
    await vi.advanceTimersByTimeAsync(300);
    expect(r.bridge.minted.slice(before)).toEqual(['http://mount/0', 'http://mount/0']);
  });

  it('does not retire the walk on a mount that plays for two seconds and dies', async () => {
    const stations = rows('idle', 4);
    rig = await booted((b) => {
      b.answer = () => stations;
      b.streams = ['http://mount/0', 'http://mount/1', 'http://mount/2'];
      b.refuse = (url) => url === 'http://mount/0';
    });
    const r = rig;

    r.host.handlers.onCut(stations, 'TEST', 'ANY RATE');
    await vi.advanceTimersByTimeAsync(300);
    audio.setLevel(0.2);
    r.host.handlers.onReconnect();
    await vi.advanceTimersByTimeAsync(200);
    r.bridge.stats({ bytesReceived: 64_000 });
    r.element().ready(4);
    // Two seconds of audio, then nothing. Not enough to prove anything.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(r.states.at(-1)!.phase).toBe('playing');
    expect(r.states.at(-1)!.playingSeconds).toBeLessThan(10);

    const before = r.bridge.minted.length;
    r.host.handlers.onSelectStation(stations[0]!.id);
    await vi.advanceTimersByTimeAsync(300);
    // The walk still remembers where it had got to.
    expect(r.bridge.minted.slice(before)).toEqual(['http://mount/1']);
  });
});

// ---------------------------------------------------------------------------
// A fetch that outlives the scope that asked for it
// ---------------------------------------------------------------------------

describe('a scope changed while its fetch is in flight', () => {
  /**
   * The window the reviewer named: the host bumps its generation inside
   * `refreshScope`, which is 220 ms behind the gesture, so an un-pull during the
   * debounce did not invalidate the fetch already out. The POP answer then
   * arrived with `loading: false` against the idle scope.
   */
  async function pullThenUnpull(): Promise<Rig> {
    const pop = rows('pop', 5933, { tags: ['pop'] });
    const idle = rows('idle', 2000, { tags: ['jazz'] });
    const r = await booted((b) => {
      b.answer = (query) => (query.genre === 'pop' ? pop : idle);
    });
    // Settled on the idle page first.
    expect(r.frame().count).toBe('2 000 ENTRIES');

    r.bridge.hold = true;
    r.host.handlers.onScope({ ...EMPTY_SCOPE, terms: ['pop'] });
    await vi.advanceTimersByTimeAsync(260); // the debounce fires; POP is in flight
    expect(r.bridge.gates).toHaveLength(1);

    // The un-pull, inside the next debounce window — the whole defect.
    r.host.handlers.onScope(emptyScope());
    await vi.advanceTimersByTimeAsync(60);

    r.bridge.gates.shift()!(); // the POP answer lands
    await vi.advanceTimersByTimeAsync(0);
    return r;
  }

  it('never publishes those rows as the answer to the scope that replaced it', async () => {
    rig = await pullThenUnpull();
    // A scope change invalidates the fetch already in flight *at the gesture*,
    // not 220 ms later when the debounce finally runs — so the POP answer is
    // superseded and never reaches the sheet at all.
    for (const published of rig.browse) {
      if (published.stations.length !== 5933) continue;
      // If it is published at all it must say which population it is, and that
      // is never the idle page.
      expect(published.key).toBe(supersetKey({ ...EMPTY_SCOPE, terms: ['pop'] }));
      expect(published.key).not.toBe('edition');
    }
    expect(rig.browse.filter((b) => !b.loading && b.stations.length === 5933)).toHaveLength(0);
  });

  it('shows no count but a true one, polled at 25 ms through the whole window', async () => {
    rig = await pullThenUnpull();
    const r = rig;

    const trace: Array<ReturnType<Rig['frame']>> = [];
    for (let i = 0; i < 24; i++) {
      trace.push(r.frame());
      await vi.advanceTimersByTimeAsync(25);
    }
    r.bridge.hold = false;
    for (const gate of r.bridge.gates.splice(0)) gate();
    await vi.advanceTimersByTimeAsync(500);
    trace.push(r.frame());

    for (const f of trace) {
      expect(f.scope).toBe('ON AIR NOW · MOST LISTENED');
      // The caption is the idle page, so the only numbers it may carry are the
      // idle page's own — or none at all.
      expect(f.count).not.toBe('5 933 ENTRIES');
      expect(f.cut).not.toContain('5 933');
      expect(['PRINTING…', '2 000 ENTRIES']).toContain(f.count);
      // CUT BAND may only be live over rows that answer the printed scope.
      if (!f.cutDead) expect(f.count).toBe('2 000 ENTRIES');
    }
    expect(trace.at(-1)!.count).toBe('2 000 ENTRIES');
  });

  it('stamps a completed pull with the population it really fetched', async () => {
    const pop = rows('pop', 5933, { tags: ['pop'] });
    rig = await booted((b) => {
      b.answer = (query) => (query.genre === 'pop' ? pop : rows('idle', 2000, { tags: ['jazz'] }));
    });
    const r = rig;
    r.host.handlers.onScope({ ...EMPTY_SCOPE, terms: ['pop'] });
    await vi.advanceTimersByTimeAsync(500);

    const settled = r.browse.filter((b) => !b.loading).at(-1)!;
    expect(settled.stations).toHaveLength(5933);
    // The key is `supersetKey`'s own spelling, separator and all — never a
    // string this test made up, or the assertion would drift away from the code.
    expect(settled.key).toBe(supersetKey({ ...EMPTY_SCOPE, terms: ['pop'] }));
    expect(settled.key).not.toBe(supersetKey(emptyScope()));
    expect(r.frame().count).toBe('5 933 ENTRIES');
  });

  it('still prints instantly for a scope the rows in hand already answer', async () => {
    // The other half of the fix, and the reason it is a key rather than a
    // blanket spinner: ≥128 kbps over pop's own population is answered locally.
    const pop = rows('pop', 40, { tags: ['pop'], claimedBitrate: 320 });
    rig = await booted((b) => {
      b.answer = () => pop;
    });
    const r = rig;
    r.host.handlers.onScope({ ...EMPTY_SCOPE, terms: ['pop'] });
    await vi.advanceTimersByTimeAsync(400);
    expect(r.frame().count).toBe('40 ENTRIES');

    r.host.handlers.onScope({ ...EMPTY_SCOPE, terms: ['pop'], minKbps: 128 });
    await vi.advanceTimersByTimeAsync(0);
    expect(r.frame().count).toBe('40 ENTRIES');
    expect(r.frame().cutDead).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The lid's deferred focus
// ---------------------------------------------------------------------------

describe('the lid closing before its focus timer fires', () => {
  let lid: LidHandle | null = null;
  let faceplateKey: HTMLButtonElement | null = null;

  afterEach(() => {
    lid?.destroy();
    lid?.root.remove();
    lid = null;
    faceplateKey?.remove();
    faceplateKey = null;
  });

  function openLid(): void {
    faceplateKey = document.createElement('button');
    document.body.append(faceplateKey);
    lid = createLid({
      onScope: () => {},
      onSelect: () => {},
      onCut: () => {},
      onReprint: () => {},
      onToggle: () => {},
    });
    document.body.append(lid.root);
    lid.setOpen(true);
    faceplateKey.focus();
  }

  it('does not reach into a panel that has been sealed shut', () => {
    openLid();
    // Escape, a latch, or applyCut's own setLidOpen(false) — all inside 340 ms.
    vi.advanceTimersByTime(100);
    lid!.setOpen(false);
    vi.advanceTimersByTime(600);

    expect(lid!.isOpen()).toBe(false);
    // The focus stayed where the user put it, on the faceplate.
    expect(document.activeElement).toBe(faceplateKey);
    expect(lid!.root.querySelector('.reg')?.closest('[inert]')).toBeTruthy();
  });

  it('does not touch a register that has been destroyed', () => {
    openLid();
    vi.advanceTimersByTime(100);
    expect(() => {
      lid!.destroy();
      vi.advanceTimersByTime(600);
    }).not.toThrow();
    expect(document.activeElement).toBe(faceplateKey);
  });

  it('still puts the caret in the subject index on an open that stays open', () => {
    openLid();
    vi.advanceTimersByTime(600);
    expect(document.activeElement).not.toBe(faceplateKey);
    expect((document.activeElement as HTMLElement | null)?.closest('.comb--subject')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// The last write before the window goes
// ---------------------------------------------------------------------------

describe('flushing a debounced write', () => {
  it('lands the newest value even when a write is already in flight', async () => {
    const written: string[] = [];
    let release!: () => void;
    const writer = new DebouncedWriter<string>(async (value) => {
      written.push(value);
      // The first write is slow — a real file write behind IPC.
      if (written.length === 1) await new Promise<void>((resolve) => (release = resolve));
    }, 400);

    writer.queue('first');
    await vi.advanceTimersByTimeAsync(400);
    expect(written).toEqual(['first']);

    // The knob keeps moving while that write is out; then the window closes.
    writer.queue('final');
    const flushed = writer.flush();
    release();
    await flushed;

    expect(written).toEqual(['first', 'final']);
    // And nothing is left waiting on a timer that will never run.
    await vi.advanceTimersByTimeAsync(2000);
    expect(written).toEqual(['first', 'final']);
  });

  it('is a no-op when there is nothing pending', async () => {
    const written: string[] = [];
    const writer = new DebouncedWriter<string>(async (v) => {
      written.push(v);
    }, 400);
    await writer.flush();
    expect(written).toEqual([]);
  });

  it('still coalesces a drag rather than writing every sample', async () => {
    const written: number[] = [];
    const writer = new DebouncedWriter<number>(async (v) => {
      written.push(v);
    }, 400);
    for (let i = 0; i < 50; i++) {
      writer.queue(i);
      await vi.advanceTimersByTimeAsync(5);
    }
    await vi.advanceTimersByTimeAsync(500);
    expect(written).toEqual([49]);
  });
});

// A band is only referenced through the host's own layout; this keeps the
// unused-type checker honest about the shapes this file names.
export type { Band, BandSlot, RegisterScope };

// ---------------------------------------------------------------------------
// RECONNECT is a control, and a control that is pressed does something visible
// ---------------------------------------------------------------------------

/**
 * Measured: three presses on a permanently-404 station left `/test/state`
 * unchanged and the panel byte-identical — a 240-frame capture recorded no text
 * change, no annunciator, no class change — while a fault server logged a fresh
 * request per press. The work happened and the panel denied it, which is the one
 * outcome worse than nothing happening: it teaches that the control is dead.
 */
describe('RECONNECT on a station that keeps failing', () => {
  /** A resolve that always fails the same way, as a permanently-404 mount does. */
  const gone: ResolveFailure = { kind: 'http', status: 404, message: 'HTTP 404 Not Found' };

  async function failing(): Promise<Rig> {
    const stations = rows('idle', 4);
    const r = await booted((b) => {
      b.answer = () => stations;
      b.resolveFailure = gone;
    });
    r.host.handlers.onCut(stations, 'TEST', 'ANY RATE');
    await vi.advanceTimersByTimeAsync(300);
    return r;
  }

  it('acknowledges the press before anything is awaited', async () => {
    rig = await failing();
    const r = rig;
    const before = r.notices.length;
    r.host.handlers.onReconnect();
    // No timer advance: the panel is written by the press itself, exactly as the
    // power dome's refusal is.
    expect(r.notices.length).toBeGreaterThan(before);
    expect(r.notices.at(-1)!.headline).toContain('RECONNECTING');
  });

  it('makes the tenth press look different from the ninth', async () => {
    rig = await failing();
    const r = rig;
    const seen: string[] = [];
    for (let press = 1; press <= 10; press++) {
      r.host.handlers.onReconnect();
      seen.push(r.notices.at(-1)!.headline);
      await vi.advanceTimersByTimeAsync(300);
    }
    // Every acknowledgement is distinguishable from the one before it, by its
    // words and by its sequence number.
    expect(new Set(seen).size).toBe(10);
    expect(seen.at(-1)).toContain('PRESS 10');
    const seqs = r.notices.filter((n): n is PanelNotice => !!n).map((n) => n.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('says the re-attempt failed the same way, rather than repeating itself', async () => {
    rig = await failing();
    const r = rig;
    r.host.handlers.onReconnect();
    await vi.advanceTimersByTimeAsync(400);
    r.host.handlers.onReconnect();
    await vi.advanceTimersByTimeAsync(400);

    const faults = r.notices.filter((n): n is PanelNotice => n?.tone === 'fault');
    expect(faults.length).toBeGreaterThan(0);
    const last = faults.at(-1)!;
    expect(last.headline).toMatch(/SAME FAULT AFTER \d+ TRIES/);
    // And it stops sending the listener back to a control that has now demonstrably
    // not worked twice.
    expect(last.action).toMatch(/ANOTHER STATION|REGISTER/);
  });

  it('names the fault and the remedy the first time, with RECONNECT by name', async () => {
    rig = await failing();
    const r = rig;
    const fault = r.notices.filter((n): n is PanelNotice => n?.tone === 'fault').at(-1)!;
    expect(fault).toBeTruthy();
    expect(fault.action).toContain('RECONNECT');
    // The composed sentence, not the transport's: `HTTP 404 Not Found` went in.
    expect(fault.action).toContain('MOUNT IS GONE');
  });

  it('never offers RECONNECT for a fault another mount cannot fix', async () => {
    const stations = rows('idle', 4);
    rig = await booted((b) => {
      b.answer = () => stations;
      b.resolveFailure = { kind: 'hls', message: 'HLS manifest' };
    });
    const r = rig;
    r.host.handlers.onCut(stations, 'TEST', 'ANY RATE');
    await vi.advanceTimersByTimeAsync(400);
    const fault = r.notices.filter((n): n is PanelNotice => n?.tone === 'fault').at(-1)!;
    expect(fault.action).not.toContain('RECONNECT');
    expect(fault.action).toMatch(/ANOTHER STATION/);
  });
});

// ---------------------------------------------------------------------------
// Nothing the panel prints about a fault carries the transport's own words
// ---------------------------------------------------------------------------

/**
 * The end-to-end half of FIX 3: the pure functions are swept in
 * `panel-truth.test.ts`, and this drives the same strings through the real host,
 * the real resolver hook, the real engine and the real annunciator — which is
 * the path the four leaks the critic photographed actually travelled.
 */
describe('a transport failure, driven all the way to the panel', () => {
  /**
   * The mandated pattern, anchored — see `panel-truth.test.ts` for why the word
   * boundaries are load-bearing.
   *
   * It is applied to `PlaybackError.message`, which is lower-case prose, and
   * deliberately NOT to the annunciator, which is silkscreen voice and therefore
   * upper case: `E[A-Z]{4,}` cannot tell `ENOTFOUND` from `EXIST` once the text
   * has been capitalised, and "THAT ADDRESS DOES NOT EXIST ANY MORE" is exactly
   * the sentence this fix exists to produce. The annunciator gets the stronger
   * test instead — that no machine-shaped token from the input survives at all.
   */
  const JARGON = /\bE[A-Z]{4,}\b|getaddrinfo|OPENSSL|SSL ROUTINES|\d+\.\d+\.\d+\.\d+:\d+/;
  const MACHINE_TOKEN = /\b[A-Z][A-Z_0-9]{3,}\b|\b[a-z0-9-]+\.[a-z][a-z0-9-]*\.[a-z]{2,}\b|\b\d+\.\d+\.\d+\.\d+\b|:\d{2,5}\b/g;

  const LEAKS: ResolveFailure[] = [
    { kind: 'network', message: 'getaddrinfo ENOTFOUND stream.example.invalid', cause: 'dns' },
    { kind: 'network', message: 'connect ECONNREFUSED 127.0.0.1:18799', cause: 'refused' },
    { kind: 'network', message: 'certificate has expired', cause: 'tls' },
    {
      kind: 'network',
      message: '28879379129536:error:100000F7:SSL routines:OPENSSL_internal:WRONG_VERSION_NUMBER',
      cause: 'tls',
    },
    // …and the same four with no cause attached at all, which is what an older
    // settings file, a third-party resolver or a plain thrown Error produces.
    { kind: 'network', message: 'getaddrinfo ENOTFOUND stream.example.invalid' },
    { kind: 'network', message: 'connect ECONNREFUSED 127.0.0.1:18799' },
  ];

  for (const failure of LEAKS) {
    it(`keeps "${failure.message.slice(0, 34)}…" off the panel`, async () => {
      const stations = rows('idle', 4);
      rig = await booted((b) => {
        b.answer = () => stations;
        b.resolveFailure = failure;
      });
      const r = rig;
      r.host.handlers.onCut(stations, 'TEST', 'ANY RATE');
      await vi.advanceTimersByTimeAsync(600);

      // 1. The engine's own error, which is what the readout prints.
      const state = r.states.at(-1)!;
      expect(state.phase).toBe('error');
      expect(state.error?.message).toBeTruthy();
      expect(state.error!.message).not.toMatch(JARGON);
      expect(state.error!.message).not.toContain(failure.message);

      // 2. Every word the annunciator said while it was happening. Nothing
      //    identifier-shaped from the failure may appear in any of it.
      // `certificate has expired` is the one input here with no machine tokens
      // in it at all — its defect was the *sentence* wrapped round it, which the
      // certificate case below pins separately.
      const tokens = failure.message.match(MACHINE_TOKEN) ?? [];
      for (const notice of r.notices) {
        if (!notice) continue;
        const said = `${notice.headline} ${notice.action}`;
        for (const token of tokens) expect(said, `${token} → ${said}`).not.toContain(token);
        expect(said).not.toContain(failure.message);
      }
    });
  }

  it('still says something specific for the certificate case', async () => {
    const stations = rows('idle', 4);
    rig = await booted((b) => {
      b.answer = () => stations;
      b.resolveFailure = { kind: 'network', message: 'certificate has expired', cause: 'tls' };
    });
    const r = rig;
    r.host.handlers.onCut(stations, 'TEST', 'ANY RATE');
    await vi.advanceTimersByTimeAsync(600);
    // Not "the station's host did not answer", which was the shipped text and a
    // plain lie: the host answered.
    expect(r.states.at(-1)!.error!.message).toContain('certificate');
    expect(r.states.at(-1)!.error!.message).not.toMatch(/did not answer/);
  });
});

// ---------------------------------------------------------------------------
// The cut survives a restart
// ---------------------------------------------------------------------------

/**
 * `settings.json` restored `scope.terms` and nothing else, so a relaunch brought
 * back the invisible half of the state — the cards the register was filed to —
 * and dropped the half the ritual was performed for: the faceplate returned to
 * `NO BAND CUT`, the flywheel locked, the meter band dead.
 */
describe('a band cut, then a relaunch', () => {
  const jazz = rows('jazz', 60, { tags: ['jazz'] });

  /** Cut a band, let the settings write land, and hand back what was written. */
  async function cutAndQuit(): Promise<Settings> {
    const r = await booted((b) => {
      b.answer = () => jazz;
    });
    rig = r;
    r.host.handlers.onScope({ ...EMPTY_SCOPE, terms: ['jazz'] });
    await vi.advanceTimersByTimeAsync(400);
    r.host.handlers.onCut(jazz, 'JAZZ', 'ANY RATE');
    await vi.advanceTimersByTimeAsync(600);
    expect(r.cuts.at(-1)!.cut!.bands.length).toBeGreaterThan(0);
    const written = r.bridge.onDisk;
    r.destroy();
    rig = null;
    return written;
  }

  it('writes the throw to settings, not 480 station records', async () => {
    const written = await cutAndQuit();
    expect(written.cutScope?.terms).toEqual(['jazz']);
    expect(written.scope.terms).toEqual(['jazz']);
    // The rows are re-derived, never copied: a settings file that carried them
    // would be a private snapshot free to drift from the directory.
    expect(JSON.stringify(written)).not.toContain('jazz-0');
  });

  it('puts the band back on the drum on the next launch', async () => {
    const written = await cutAndQuit();
    rig = await booted(
      (b) => {
        b.answer = () => jazz;
      },
      (b) => {
        b.onDisk = written;
      },
    );
    const r = rig;
    await vi.advanceTimersByTimeAsync(600);

    const restored = r.cuts.filter((c) => c.cut && c.cut.bands.length > 0).at(-1);
    expect(restored, 'a cut was restored').toBeTruthy();
    expect(restored!.cut!.caption).toContain('JAZZ');
    // And the drum really carries stations, which is what the flywheel's lock and
    // the meter band's detents are both functions of.
    expect(r.bands.at(-1)!.slots.length).toBeGreaterThan(0);
  });

  it('does not put anything on the air by restoring it', async () => {
    // Restoring a band is not a gesture. The browser will not start audio without
    // one, and a panel that came up claiming to play would be the lie Law 2 forbids.
    const written = await cutAndQuit();
    rig = await booted(
      (b) => {
        b.answer = () => jazz;
      },
      (b) => {
        b.onDisk = written;
      },
    );
    await vi.advanceTimersByTimeAsync(600);
    expect(rig.states.at(-1)!.phase).toBe('idle');
    expect(rig.bridge.minted).toEqual([]);
  });

  it('does not strike the plate lamp for a band nobody just threw', async () => {
    const written = await cutAndQuit();
    rig = await booted(
      (b) => {
        b.answer = () => jazz;
      },
      (b) => {
        b.onDisk = written;
      },
    );
    await vi.advanceTimersByTimeAsync(600);
    expect(rig.cuts.filter((c) => c.struck)).toEqual([]);
  });

  it('remembers which meter band of the cut was printed', async () => {
    const r = await booted((b) => {
      b.answer = () => jazz;
    });
    rig = r;
    r.host.handlers.onScope({ ...EMPTY_SCOPE, terms: ['jazz'] });
    await vi.advanceTimersByTimeAsync(400);
    r.host.handlers.onCut(jazz, 'JAZZ', 'ANY RATE');
    await vi.advanceTimersByTimeAsync(400);
    const filled = r.cuts.at(-1)!.cut!.bands.length;
    if (filled < 2) return; // one band: nothing to remember
    r.host.handlers.onSelectMeterBand(1);
    await vi.advanceTimersByTimeAsync(600);
    const written = r.bridge.onDisk;
    expect(written.cutBandIndex).toBe(1);
    r.destroy();

    rig = await booted(
      (b) => {
        b.answer = () => jazz;
      },
      (b) => {
        b.onDisk = written;
      },
    );
    await vi.advanceTimersByTimeAsync(600);
    expect(rig.cuts.filter((c) => c.cut).at(-1)!.index).toBe(1);
  });

  it('holds the restore open when the directory could not be reached', async () => {
    // An offline launch cannot restore the drum. It must not therefore *forget*
    // the band: RECONNECT re-pulls the list, and the cut comes back with it.
    const written = await cutAndQuit();
    rig = await booted(
      (b) => {
        b.answer = () => jazz;
      },
      (b) => {
        b.onDisk = written;
        b.searchFails = true;
      },
    );
    const r = rig;
    await vi.advanceTimersByTimeAsync(400);
    expect(r.cuts.filter((c) => c.cut && c.cut.bands.length > 0)).toEqual([]);

    r.bridge.searchFails = false;
    r.host.handlers.onReconnect();
    await vi.advanceTimersByTimeAsync(800);
    expect(r.cuts.filter((c) => c.cut && c.cut.bands.length > 0).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The first launch of all: a receiver that switches on to something
// ---------------------------------------------------------------------------

/**
 * "There is no play button. Anywhere."
 *
 * Three first-time users in a row, given only "it's an internet radio app" and
 * no documentation, failed to get audio out of this receiver: 40 s, 37 s, and
 * 120 s to first sound on the packaged build. All three pressed the power dome
 * first, which is right, and all three got nothing, which was also right —
 * there was nothing on the dial to switch on to.
 *
 * The remedy is not a play button. A 1977 receiver has no play button either;
 * what it has is no empty state. So an unconfigured profile comes up with a
 * band already cut from the idle sheet the register fetches anyway, and RADIO
 * ON — still the only thing that starts audio — has something to start.
 */
describe('a profile that has never cut anything', () => {
  const hot = rows('hot', 90, { tags: ['pop'] });

  it('comes up with a band already on the drum', async () => {
    rig = await booted((b) => {
      b.answer = () => hot;
    });
    await vi.advanceTimersByTimeAsync(400);
    const opened = rig.cuts.filter((c) => c.cut && c.cut.bands.length > 0).at(-1);
    expect(opened, 'a band was cut without anyone throwing CUT BAND').toBeTruthy();
    // The register's own name for the idle population, so the sheet standing
    // behind the drum and the plate in front of it say the same thing.
    expect(opened!.cut!.caption).toBe('ON AIR NOW · MOST LISTENED');
    expect(rig.bands.at(-1)!.slots.length).toBeGreaterThan(0);
  });

  it('costs no extra request — it is the sheet the register already fetched', async () => {
    rig = await booted((b) => {
      b.answer = () => hot;
    });
    await vi.advanceTimersByTimeAsync(400);
    expect(rig.bridge.queries).toHaveLength(1);
    expect(rig.bridge.queries[0]).toEqual({ limit: 2000 });
  });

  it('does not put it on the air, and does not strike the plate lamp', async () => {
    // RADIO ON stays the only thing that starts audio (Law 2), and nothing was
    // thrown by a hand, so nothing flashes as though something had been.
    rig = await booted((b) => {
      b.answer = () => hot;
    });
    await vi.advanceTimersByTimeAsync(400);
    expect(rig.states.at(-1)!.phase).toBe('idle');
    expect(rig.bridge.minted).toEqual([]);
    expect(rig.cuts.filter((c) => c.struck)).toEqual([]);
  });

  it('is not written to disk as a standing band', async () => {
    // It is what an unconfigured receiver comes up on, not a band anybody chose.
    // Persisting it would turn today's most-listened page into a decision the
    // user is stuck with, and would make it survive as a stale caption.
    rig = await booted((b) => {
      b.answer = () => hot;
    });
    await vi.advanceTimersByTimeAsync(600);
    expect(rig.bridge.onDisk.cutScope).toBeUndefined();
  });

  it('plays when the power dome is pressed, which is the whole point', async () => {
    rig = await booted((b) => {
      b.answer = () => hot;
    });
    await vi.advanceTimersByTimeAsync(400);
    rig.host.handlers.onPower(true);
    await vi.advanceTimersByTimeAsync(400);
    expect(rig.bridge.minted).toHaveLength(1);
    expect(rig.states.at(-1)!.station).toBeTruthy();
  });

  it('holds a switch-on that beat the station list, and answers it when it lands', async () => {
    // Measured on the packaged build: the dome is pressed within a couple of
    // seconds of launch, and the directory does not always answer that fast.
    // Telling the user the dial is empty is true for one more second and then
    // wrong — and it is exactly the answer that taught three of them the
    // biggest control on the panel does nothing.
    rig = await booted(
      (b) => {
        b.answer = () => hot;
      },
      (b) => {
        b.hold = true;
      },
    );
    const r = rig;
    await vi.advanceTimersByTimeAsync(100);
    r.host.handlers.onPower(true);
    await vi.advanceTimersByTimeAsync(50);
    expect(r.notices.at(-1)!.headline).toBe('WARMING UP');
    expect(r.bridge.minted).toEqual([]);

    r.bridge.hold = false;
    for (const open of r.bridge.gates.splice(0)) open();
    await vi.advanceTimersByTimeAsync(600);
    expect(r.bridge.minted).toHaveLength(1);
    // And the message that described the wait comes down with the wait.
    expect(r.notices.at(-1)).toBeNull();
  });

  it('takes the held press back when the dome is pressed again', async () => {
    rig = await booted(
      (b) => {
        b.answer = () => hot;
      },
      (b) => {
        b.hold = true;
      },
    );
    const r = rig;
    await vi.advanceTimersByTimeAsync(100);
    r.host.handlers.onPower(true);
    r.host.handlers.onPower(false);
    r.bridge.hold = false;
    for (const open of r.bridge.gates.splice(0)) open();
    await vi.advanceTimersByTimeAsync(600);
    expect(r.bridge.minted).toEqual([]);
  });

  it('stops saying WARMING UP when the list settles with nothing on it', async () => {
    rig = await booted(
      (b) => {
        b.answer = () => [];
      },
      (b) => {
        b.hold = true;
      },
    );
    const r = rig;
    await vi.advanceTimersByTimeAsync(100);
    r.host.handlers.onPower(true);
    expect(r.notices.at(-1)!.headline).toBe('WARMING UP');
    r.bridge.hold = false;
    for (const open of r.bridge.gates.splice(0)) open();
    await vi.advanceTimersByTimeAsync(600);
    expect(r.notices.at(-1)!.headline).not.toBe('WARMING UP');
    expect(r.notices.at(-1)!.action).toBeTruthy();
  });

  it('gives way for good to the first band the listener cuts', async () => {
    const r = await booted((b) => {
      b.answer = () => hot;
    });
    rig = r;
    await vi.advanceTimersByTimeAsync(400);
    r.host.handlers.onScope({ ...EMPTY_SCOPE, terms: ['pop'] });
    await vi.advanceTimersByTimeAsync(400);
    r.host.handlers.onCut(hot, 'POP', 'ANY RATE');
    await vi.advanceTimersByTimeAsync(600);
    expect(r.cuts.at(-1)!.cut!.caption).toBe('POP');
    // Persisted, so the next launch restores theirs rather than cutting another
    // opening band over the top of it.
    expect(r.bridge.onDisk.cutScope?.terms).toEqual(['pop']);
  });

  it('will not hand the drum a station it already knows it cannot play', async () => {
    // Measured on the packaged build: the most-listened page's top entry was
    // HLS, so a cold launch put it under the pointer and the first press of
    // RADIO ON reached `FAULT — HLS ONLY, WHICH THIS RECEIVER CANNOT DECODE`.
    // The register still prints those rows — struck and dated, which is Law 4 —
    // but a band the *receiver* cut is a choice it made on the listener's
    // behalf, and choosing a known-dead station is not a choice it may make.
    const bad = [
      station({ id: 'hls-1', clickCount: 9999, hls: true }),
      station({ id: 'dead-1', clickCount: 9998, lastCheckOk: false }),
    ];
    rig = await booted((b) => {
      b.answer = () => [...bad, ...hot];
    });
    await vi.advanceTimersByTimeAsync(400);
    const ids = rig.bands.at(-1)!.slots.map((slot) => slot.station.id);
    expect(ids).not.toContain('hls-1');
    expect(ids).not.toContain('dead-1');
    expect(ids.length).toBeGreaterThan(0);
  });

  it('leaves the drum alone if a card was pulled before the first rows landed', async () => {
    // Those rows answer a different question. Putting them on the drum would be
    // the receiver choosing a subject nobody asked for.
    rig = await booted(
      (b) => {
        b.answer = (q) => (q.genre === 'jazz' ? rows('jz', 50) : hot);
      },
      (b) => {
        b.hold = true;
      },
    );
    const r = rig;
    r.host.handlers.onScope({ ...EMPTY_SCOPE, terms: ['jazz'] });
    await vi.advanceTimersByTimeAsync(400);
    r.bridge.hold = false;
    for (const open of r.bridge.gates.splice(0)) open();
    await vi.advanceTimersByTimeAsync(600);
    expect(r.cuts.filter((c) => c.cut && c.cut.bands.length > 0)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A dial with nothing on it answers the hand
// ---------------------------------------------------------------------------

describe('the flywheel on an uncut dial', () => {
  it('answers a refused gesture on the annunciator', async () => {
    rig = await booted((b) => {
      b.answer = () => [];
    });
    const r = rig;
    const before = r.notices.length;
    r.host.handlers.onDialLocked();
    expect(r.notices.length).toBeGreaterThan(before);
    const said = r.notices.at(-1)!;
    expect(said.headline).toContain('NOTHING ON THE DIAL');
    expect(said.action).toContain('STATIONS');
  });

  it('re-strikes on every attempt, so a repeated push is visibly repeated', async () => {
    rig = await booted((b) => {
      b.answer = () => [];
    });
    const r = rig;
    for (let i = 0; i < 4; i++) r.host.handlers.onDialLocked();
    const seqs = r.notices.slice(-4).map((n) => n!.seq);
    expect(new Set(seqs).size).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// The frame loop: two instruments, not one
// ---------------------------------------------------------------------------

/**
 * The needle reads real RMS off the analyser every frame, and must go on doing
 * so. What it must not do is drag the whole panel's revision along behind it.
 *
 * Before this, `frame()` called `render(state, band, settings)` on every frame
 * in which the level had moved — which, with programme material on the air, is
 * every frame. Measured on the shipping build with a station playing, that ran
 * 894 `getAttribute` compares a second and 2.55% of a core of rAF JavaScript to
 * answer "the RMS moved by 0.01". The same build with the fast path: 305/s and
 * 1.66%.
 *
 * The rule these pin is the safety property, not the saving: nothing structural
 * may ever reach the screen through the fast path, because everything
 * structural sets `dirty` and takes a full render on the next frame.
 */
describe('the needle at frame rate', () => {
  /** A deck that is genuinely playing, so the analyser has something to read. */
  async function playing(): Promise<Rig> {
    const stations = rows('idle', 4);
    const r = await booted((b) => {
      b.answer = () => stations;
    });
    r.host.handlers.onCut(stations, 'TEST', 'ANY RATE');
    await vi.advanceTimersByTimeAsync(300);
    audio.setLevel(0.2);
    r.bridge.stats({ bytesReceived: 64_000 });
    r.element().ready(4);
    await vi.advanceTimersByTimeAsync(400);
    expect(r.states.at(-1)!.phase).toBe('playing');
    return r;
  }

  it('pushes the reading and nothing else while the engine has said nothing new', async () => {
    rig = await playing();
    const r = rig;
    const rendersBefore = r.states.length;
    const levelsBefore = r.levels.length;

    // Move the analyser between frames, exactly as real audio does. Nothing
    // else about the world changes.
    for (let i = 0; i < 12; i++) {
      audio.setLevel(0.1 + i * 0.05);
      await vi.advanceTimersByTimeAsync(16);
    }

    const levels = r.levels.length - levelsBefore;
    const renders = r.states.length - rendersBefore;
    expect(levels).toBeGreaterThan(0);
    // The engine still emits at 10 Hz, so a full render or two across ~190 ms
    // is expected; what may not happen any more is one per frame.
    expect(renders).toBeLessThan(levels);
  });

  it('sends the level the analyser actually reports, not a stored one (Law 2)', async () => {
    rig = await playing();
    const r = rig;
    const mark = r.levels.length;

    audio.setLevel(0.77);
    await vi.advanceTimersByTimeAsync(64);

    const pushed = r.levels.slice(mark);
    expect(pushed.length).toBeGreaterThan(0);
    // The stage maps RMS through its own deflection curve, so the exact figure
    // is the engine's to decide. What matters is that a real, non-zero reading
    // arrived, synchronously, on a frame that took no full render.
    for (const level of pushed) expect(level).toBeGreaterThan(0);
  });

  it('takes a full render the moment anything structural changes', async () => {
    rig = await playing();
    const r = rig;
    const before = r.states.length;

    // A hand on a knob is structural: the settings the faceplate renders moved.
    r.host.handlers.onSetVolume(0.31);
    await vi.advanceTimersByTimeAsync(32);

    expect(r.states.length).toBeGreaterThan(before);
  });

  it('does not push a reading for a needle that has not moved', async () => {
    rig = await playing();
    const r = rig;
    // A dead stream, a silent passage, standby: the analyser is pinned.
    audio.setLevel(0);
    await vi.advanceTimersByTimeAsync(600);
    const levels = r.levels.length;

    await vi.advanceTimersByTimeAsync(30 * 16);

    // Thirty frames, thirty analyser reads, and no work at all beyond them.
    expect(r.levels.length).toBe(levels);
  });
});

// ---------------------------------------------------------------------------
// What the fast path is not allowed to cost
// ---------------------------------------------------------------------------

/**
 * The badge and the needle are read in one glance and must agree.
 *
 * `readout.update()` times its silence guard on `signalLevel`, and it has to be
 * timed on samples taken at frame rate: the engine emits ten a second, and the
 * analyser produces a window every ~46 ms. A fast path that pushed the level to
 * the movement alone would have left the badge deciding "no audio" from a sixth
 * of the evidence the needle is using — a cheaper panel that is also a less
 * truthful one, which is not a trade Law 2 allows.
 *
 * So the reading goes to both, and this is the property that proves it: with
 * `update()` never called again, `setLevel(0)` alone must still take the badge
 * off LOCKED once the grace has elapsed.
 */
describe('the readout on the level fast path', () => {
  it('still decides "no audio" from readings the fast path alone delivered', async () => {
    const readout = createReadout();
    document.body.append(readout.root);
    const badge = (): string => readout.root.querySelector('.lcd__phase')!.textContent ?? '';

    const station: StationRef = {
      id: 'st', name: 'Station', url: 'http://a/1', tags: [], popularity: 1,
    };
    // One full render, with real audio on the air.
    readout.update({
      ...INITIAL_PLAYBACK_STATE, phase: 'playing', station, signalLevel: 0.4, bytesReceived: 90_000,
    });
    expect(badge()).toBe('LOCKED');

    // The bytes keep arriving, so the engine goes on reporting `playing` and
    // never re-renders. The analyser, meanwhile, has gone to the zero stop.
    for (let i = 0; i < 40; i++) {
      readout.setLevel(0);
      await vi.advanceTimersByTimeAsync(50);
    }

    expect(badge()).toBe('NO AUDIO');
    readout.destroy();
    readout.root.remove();
  });

  it('says nothing before the first full render, having nothing to describe', () => {
    const readout = createReadout();
    document.body.append(readout.root);
    expect(() => readout.setLevel(0.5)).not.toThrow();
    expect(readout.root.querySelector('.lcd__phase')!.textContent).toBe('STANDBY');
    readout.destroy();
    readout.root.remove();
  });

  it('comes straight back off "no audio" when the level returns', async () => {
    const readout = createReadout();
    document.body.append(readout.root);
    const badge = (): string => readout.root.querySelector('.lcd__phase')!.textContent ?? '';
    const station: StationRef = {
      id: 'st', name: 'Station', url: 'http://a/1', tags: [], popularity: 1,
    };
    readout.update({
      ...INITIAL_PLAYBACK_STATE, phase: 'playing', station, signalLevel: 0.4, bytesReceived: 90_000,
    });
    for (let i = 0; i < 40; i++) {
      readout.setLevel(0);
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(badge()).toBe('NO AUDIO');

    readout.setLevel(0.31);
    expect(badge()).toBe('LOCKED');
    readout.destroy();
    readout.root.remove();
  });
});

// ---------------------------------------------------------------------------
// A dead station is as motionless as standby, and must cost the same
// ---------------------------------------------------------------------------

/**
 * `error` is the terminal phase: a station that has given up. There is no
 * session, no reconnect in flight, no audio thread — the engine's own
 * `syncTicker` stops its 10 Hz poll and idles the stage for exactly this phase —
 * and the panel is a fixed sentence beside a steady lamp. Nothing moves.
 *
 * The frame loop did not agree. `canSettle` listed `idle` and nothing else, so a
 * station whose stream is dead left `frame` re-arming sixty times a second, for
 * as long as the window was open, presenting not one frame. Measured on the
 * shipping build under Xephyr: 7.9% of a core on a dead mount against 0.3% in
 * standby with the identical DOM, with an instrumented counter showing 60.2 Hz
 * of `requestAnimationFrame` from exactly one caller — `frame`. A directory of
 * user-submitted stream URLs produces dead mounts constantly, so this was the
 * common case, not the edge one.
 *
 * These pin both halves. Parking is worth nothing if the panel cannot come back,
 * so every wake route a fault can take is exercised: RECONNECT, a station
 * change, a hand on a control, and the return of attention.
 */
describe('the frame loop on a dead station', () => {
  /** The host's own rAF handle. 0 means the loop has parked. */
  const parked = (r: Rig): boolean => (r.host as unknown as { raf: number }).raf === 0;

  /** A station tuned to a mount that refuses, taken all the way to `error`. */
  async function faulted(): Promise<Rig> {
    const stations = rows('idle', 4);
    const r = await booted((b) => {
      b.answer = () => stations;
      b.refuse = () => true; // the mount will not open: a terminal fault
    });
    r.host.handlers.onCut(stations, 'TEST', 'ANY RATE');
    await vi.advanceTimersByTimeAsync(300);
    audio.setLevel(0);
    await vi.advanceTimersByTimeAsync(600);
    expect(r.states.at(-1)!.phase).toBe('error');
    return r;
  }

  it('parks the loop on a fault, exactly as it parks in standby', async () => {
    rig = await faulted();
    expect(parked(rig)).toBe(true);
  });

  it('stays parked: a fault that nobody touches schedules no further frames', async () => {
    rig = await faulted();
    const r = rig;
    const renders = r.states.length;
    const levels = r.levels.length;

    // Ten seconds of a dead station sitting in the corner.
    await vi.advanceTimersByTimeAsync(10_000);

    expect(parked(r)).toBe(true);
    expect(r.states.length).toBe(renders);
    expect(r.levels.length).toBe(levels);
  });

  it('wakes on RECONNECT and repaints', async () => {
    rig = await faulted();
    const r = rig;
    expect(parked(r)).toBe(true);
    const renders = r.states.length;

    r.host.handlers.onReconnect();

    // Synchronously armed — the press must not wait for a timer to be noticed.
    expect(parked(r)).toBe(false);
    await vi.advanceTimersByTimeAsync(300);
    expect(r.states.length).toBeGreaterThan(renders);
    // And the press said so on the panel.
    expect(r.notices.at(-1)).not.toBeNull();
  });

  it('wakes when the listener tunes somewhere else', async () => {
    rig = await faulted();
    const r = rig;
    expect(parked(r)).toBe(true);
    const renders = r.states.length;

    r.host.handlers.onSelectStation('idle-2');

    expect(parked(r)).toBe(false);
    await vi.advanceTimersByTimeAsync(300);
    expect(r.states.length).toBeGreaterThan(renders);
  });

  it('wakes for a hand on a control', async () => {
    rig = await faulted();
    const r = rig;
    expect(parked(r)).toBe(true);

    r.host.handlers.onSetVolume(0.42);

    expect(parked(r)).toBe(false);
    await vi.advanceTimersByTimeAsync(64);
    expect(r.states.at(-1)!.phase).toBe('error');
  });

  it('wakes when attention comes back, with the fault still on the panel', async () => {
    rig = await faulted();
    const r = rig;
    expect(parked(r)).toBe(true);

    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));

    await vi.advanceTimersByTimeAsync(64);
    expect(r.states.at(-1)!.phase).toBe('error');
  });

  it('takes the needle to the zero stop before it parks, never on a stale reading', async () => {
    // The level gate is unchanged and still governs: the loop may only stop
    // sampling a needle that is already at rest, whatever the phase says. A
    // station that dies mid-programme is the case that proves it — the needle is
    // deflected at the instant the fault arrives.
    const stations = rows('idle', 4);
    rig = await booted((b) => {
      b.answer = () => stations;
    });
    const r = rig;
    r.host.handlers.onCut(stations, 'TEST', 'ANY RATE');
    await vi.advanceTimersByTimeAsync(300);
    audio.setLevel(0.3);
    r.bridge.stats({ bytesReceived: 64_000 });
    r.element().ready(4);
    await vi.advanceTimersByTimeAsync(400);
    expect(r.states.at(-1)!.phase).toBe('playing');
    expect(parked(r)).toBe(false);
    expect(r.levels.at(-1)).toBeGreaterThan(0);

    // The decoder gives up on the source: not retryable, so it is terminal.
    r.element().fail(4, 'MEDIA_ELEMENT_ERROR: format not supported');
    await vi.advanceTimersByTimeAsync(600);

    expect(r.states.at(-1)!.phase).toBe('error');
    expect(parked(r)).toBe(true);
    // The reading that parked the loop is the reading the panel is showing: the
    // last frame the loop ran carried the needle down to the stop before it
    // stopped sampling, so nothing is left deflected against a dead station.
    expect(r.states.at(-1)!.signalLevel).toBe(0);
  });

  it('leaves every live phase running at frame rate', async () => {
    // `buffering` is a phase whose reading changes on its own, so it may never
    // park however still the needle happens to be at this instant.
    const stations = rows('idle', 4);
    rig = await booted((b) => {
      b.answer = () => stations;
    });
    const r = rig;
    r.host.handlers.onCut(stations, 'TEST', 'ANY RATE');
    await vi.advanceTimersByTimeAsync(300);
    r.bridge.stats({ bytesReceived: 4_000 });
    audio.setLevel(0);
    await vi.advanceTimersByTimeAsync(600);

    expect(r.states.at(-1)!.phase).toBe('buffering');
    expect(parked(r)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A throw the directory can no longer satisfy
// ---------------------------------------------------------------------------

describe('a standing band whose scope now matches nothing', () => {
  const jazzScope = { ...EMPTY_SCOPE, terms: ['jazz'] };

  it('does not hold RADIO ON on WARMING UP for ever once the directory has answered', async () => {
    // Measured on the packaged build: `cutStanding: true` beside a term the
    // directory answered with zero rows kept `cutToRestore` armed, `warmingUp()`
    // true, and every press of the power dome on `WARMING UP · PLAY STARTS ON
    // ITS OWN` — on every launch, with nothing on its way.
    rig = await booted(
      (b) => {
        b.answer = () => [];
      },
      (b) => {
        b.onDisk = { ...DEFAULT_SETTINGS, scope: jazzScope, cutScope: jazzScope, cutBandIndex: 3 };
      },
    );
    const r = rig;
    await vi.advanceTimersByTimeAsync(400);
    r.host.handlers.onPower(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(r.notices.at(-1)!.headline).not.toBe('WARMING UP');
    expect(r.notices.at(-1)!.action).toBeTruthy();
    // And the answer is not asked again on the next launch: the throw is gone
    // from disk, the cards are not.
    await vi.advanceTimersByTimeAsync(600);
    expect(r.bridge.onDisk.cutScope).toBeUndefined();
    expect(r.bridge.onDisk.scope.terms).toEqual(['jazz']);
  });

  it('gives the same honest answer when a card was pulled before the first list landed', async () => {
    // A fresh profile whose opening band can never come, because the idle fetch
    // was superseded by a scope the listener chose during it.
    const pop = rows('pop', 30, { tags: ['pop'] });
    rig = await booted((b) => {
      b.hold = true;
      b.answer = (q) => (q.genre === 'pop' ? [] : pop);
    });
    const r = rig;
    r.host.handlers.onScope({ ...EMPTY_SCOPE, terms: ['pop'] });
    await vi.advanceTimersByTimeAsync(300);
    r.bridge.hold = false;
    for (const open of r.bridge.gates.splice(0)) open();
    await vi.advanceTimersByTimeAsync(300);
    r.host.handlers.onPower(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(r.notices.at(-1)!.headline).not.toBe('WARMING UP');
  });
});

describe('a standing band cut from a scope the cards have since left', () => {
  it('restores the throw, not the cards, with one extra round trip', async () => {
    // JAZZ was thrown; then a POP card was pulled and the app quit. The drum
    // must come back carrying JAZZ — the band that was standing — while the
    // register shows the POP cards, which is what was left on the table.
    const jazz = rows('jazz', 40, { tags: ['jazz'] });
    const pop = rows('pop', 30, { tags: ['pop'] });
    rig = await booted(
      (b) => {
        b.answer = (q) => (q.genre === 'jazz' ? jazz : q.genre === 'pop' ? pop : []);
      },
      (b) => {
        b.onDisk = {
          ...DEFAULT_SETTINGS,
          scope: { ...EMPTY_SCOPE, terms: ['pop'] },
          cutScope: { ...EMPTY_SCOPE, terms: ['jazz'] },
          cutBandIndex: 0,
        };
      },
    );
    const r = rig;
    await vi.advanceTimersByTimeAsync(400);
    expect(r.bridge.queries.map((q) => q.genre).sort()).toEqual(['jazz', 'pop']);
    const restored = r.cuts.filter((c) => c.cut && c.cut.bands.length > 0).at(-1);
    expect(restored, 'a cut was restored').toBeTruthy();
    expect(restored!.cut!.caption).toContain('JAZZ');
    expect(r.bands.at(-1)!.slots[0]!.station.id).toMatch(/^jazz-/);
    // The throw stays on disk as the throw; the cards stay as the cards.
    expect(r.bridge.onDisk.cutScope?.terms).toEqual(['jazz']);
    expect(r.bridge.onDisk.scope.terms).toEqual(['pop']);
  });
});


// ---------------------------------------------------------------------------
// A directory that comes back on its own
// ---------------------------------------------------------------------------

describe('a directory fault the listener does not touch', () => {
  it('is re-pulled on a bounded schedule, and the sheet prints when the mirror answers', async () => {
    const hot = rows('hot', 20);
    rig = await booted((b) => {
      b.searchFails = true;
      b.answer = () => hot;
    });
    const r = rig;
    await vi.advanceTimersByTimeAsync(300);
    expect(r.bridge.queries).toHaveLength(1);
    expect(r.frame().count).toBe('NOT PRINTED');

    // Nothing for 14 s, then the first unattended pull at 15 s.
    await vi.advanceTimersByTimeAsync(14_000);
    expect(r.bridge.queries.map((q) => JSON.stringify(q))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(r.bridge.queries).toHaveLength(2);

    // Still down: the next one waits 30 s, not 15.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(r.bridge.queries).toHaveLength(2);
    r.bridge.searchFails = false;
    await vi.advanceTimersByTimeAsync(11_000);
    expect(r.bridge.queries).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(300);
    expect(r.frame().count).not.toBe('NOT PRINTED');
    expect(r.bands.at(-1)!.slots.length).toBeGreaterThan(0);

    // Answered: no further pulls are scheduled.
    await vi.advanceTimersByTimeAsync(300_000);
    expect(r.bridge.queries).toHaveLength(3);
  });

  it('spends its budget and then stops, leaving RECONNECT and REPRINT to a hand', async () => {
    rig = await booted((b) => {
      b.searchFails = true;
    });
    const r = rig;
    await vi.advanceTimersByTimeAsync(300);
    // 15 + 30 + 60 + 120 s of retries, then nothing for as long as you like.
    await vi.advanceTimersByTimeAsync(230_000);
    expect(r.bridge.queries).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(r.bridge.queries).toHaveLength(5);
    // A hand on REPRINT is a fresh budget.
    r.host.handlers.onReprint();
    await vi.advanceTimersByTimeAsync(300);
    expect(r.bridge.queries).toHaveLength(6);
    await vi.advanceTimersByTimeAsync(15_500);
    expect(r.bridge.queries).toHaveLength(7);
  });

  it('is re-pulled at once when the browser reports the network back', async () => {
    rig = await booted((b) => {
      b.searchFails = true;
    });
    const r = rig;
    await vi.advanceTimersByTimeAsync(300);
    expect(r.bridge.queries).toHaveLength(1);
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(300);
    expect(r.bridge.queries).toHaveLength(2);
  });

  it('does nothing on `online` when there is no fault to recover from', async () => {
    rig = await booted((b) => {
      b.answer = () => rows('hot', 20);
    });
    const r = rig;
    await vi.advanceTimersByTimeAsync(300);
    const before = r.bridge.queries.length;
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(300);
    expect(r.bridge.queries).toHaveLength(before);
  });
});
