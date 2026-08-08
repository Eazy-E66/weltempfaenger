// @vitest-environment jsdom
/**
 * THE WIRE BETWEEN THE PANEL AND THE REGISTER.
 *
 * The register already knew how to print a fault, mark the line that failed and
 * offer RECONNECT. None of it was reachable: the lid — the only thing that owns
 * a register — exposed `setIndex`, `setRows`, `setScope` and `setOnAir`, and
 * nothing else. So a click made on the register's own sheet was answered on the
 * faceplate, which the open lid completely covers.
 *
 * Measured on the running product before this file existed: BBC Radio 3 clicked
 * in the register, `phase: "error"`, `kind: "hls"` at 0.39 s, and
 * `register.innerText` tested against `/HLS|CANNOT DECODE|FAULT/i` was **false**
 * for as long as anyone cared to poll it. Law 4 was unsatisfiable from that
 * surface however the host behaved, because there was no channel.
 *
 * Everything below is the shipping `createLid` talking to the shipping
 * `createRegister`. Nothing is stubbed but the two browser facilities jsdom
 * lacks, and neither of them decides anything.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  INITIAL_PLAYBACK_STATE,
  type GenreTag,
  type PlaybackState,
  type RegisterIndex,
  type StationRef,
} from '../../src/shared/contracts';
import { createLid, type LidHandle } from '../../src/renderer/ui/components/lid';
import { airStateOf } from '../../src/renderer/ui/types';

class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', FakeResizeObserver);
vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => setTimeout(() => fn(0), 0) as unknown as number);
vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = function noop(): void {};

/** The regex the critic tested `register.innerText` against, and got false. */
const CRITIC = /HLS|CANNOT DECODE|FAULT/i;

function tag(name: string, stationCount: number): GenreTag {
  return { name, stationCount, spellings: [name] };
}

const index: RegisterIndex = {
  source: 'fixture',
  pulledAt: 1,
  totals: { stations: 900, tags: 30, countries: 12, languages: 9 },
  subjects: [tag('classical', 400)],
  origins: [{ code: 'GB', name: 'United Kingdom', stationCount: 120 }],
  tongues: [{ name: 'english', stationCount: 300 }],
};

function station(over: Partial<StationRef> & { id: string }): StationRef {
  return {
    name: over.id,
    url: `http://example.invalid/${over.id}`,
    tags: ['classical'],
    popularity: 0.5,
    clickCount: 10,
    ...over,
  };
}

/** The real row that made this necessary, and two ordinary ones beside it. */
const BBC3 = station({ id: 'bbc3', name: 'BBC Radio 3', countryCode: 'GB', hls: true, clickCount: 49 });
const DEAD = station({ id: 'dead', name: 'Silent Transmitter', lastCheckOk: false, clickCount: 30 });
const GOOD = station({ id: 'good', name: 'Radio Swiss Classic', claimedCodec: 'MP3', clickCount: 20 });
const ROWS = [BBC3, DEAD, GOOD];

interface Rig {
  lid: LidHandle;
  reconnects: number;
  /** The ledger line for `id`, as it currently stands. */
  row(id: string): HTMLElement;
  text(sel: string): string;
  innerText(): string;
  destroy(): void;
}

function mount(): Rig {
  const tally = { reconnects: 0 };
  const lid = createLid({
    onScope: () => {},
    onSelect: () => {},
    onCut: () => {},
    onReprint: () => {},
    onToggle: () => {},
    onReconnect: () => {
      tally.reconnects += 1;
    },
  });
  document.body.append(lid.root);
  lid.setOpen(true);
  lid.setIndex(index, null);
  // No `key`: "take the current scope's word for it", which settles the press
  // for a caller that has no fetch of its own. With a key that names some other
  // population the sheet is still PRINTING and there are no rows to assert on.
  lid.setRows(ROWS, { loading: false });

  const names = (): HTMLElement[] =>
    Array.from(lid.root.querySelectorAll<HTMLElement>('.entry')).filter(
      (e) => e.style.display !== 'none',
    );
  return {
    lid,
    get reconnects() {
      return tally.reconnects;
    },
    row(id) {
      const wanted = ROWS.find((s) => s.id === id)!.name;
      const found = names().find((e) => e.querySelector('.entry__name')?.textContent === wanted);
      if (!found) throw new Error(`no ledger row for ${id}`);
      return found;
    },
    text: (sel) => (lid.root.querySelector(sel)?.textContent ?? '').trim(),
    // jsdom has no layout, so `innerText` is not implemented; `textContent` is
    // the same string for this purpose and is what the register's own tests use.
    innerText: () => lid.root.textContent ?? '',
    destroy() {
      lid.destroy();
      lid.root.remove();
    },
  };
}

let rig: Rig | null = null;
afterEach(() => {
  rig?.destroy();
  rig = null;
  document.body.replaceChildren();
});

function faulted(): PlaybackState {
  return {
    ...INITIAL_PLAYBACK_STATE,
    phase: 'error',
    station: BBC3,
    error: {
      kind: 'hls',
      message: 'this station is HLS only, which this receiver cannot decode — pick another',
      attempts: 1,
    },
  };
}

// ---------------------------------------------------------------------------
// FIX A — the lid carries the fault channel
// ---------------------------------------------------------------------------

describe('a click on the register that does not come up', () => {
  it('is answered on the register, through the lid, in the register’s own text', () => {
    rig = mount();
    // The measured starting point: nothing on this surface says anything.
    expect(rig.innerText()).not.toMatch(/CANNOT DECODE/i);

    rig.lid.setPlayback(faulted());

    expect(rig.innerText()).toMatch(CRITIC);
    expect(rig.text('.reg-fault__big')).toBe('FAULT · HLS ONLY — THIS RECEIVER CANNOT DECODE IT');
    expect(rig.text('.reg-fault__why')).toContain('cannot decode');
    expect(rig.text('.reg-fault__where')).toContain('BBC RADIO 3');
    expect((rig.lid.root.querySelector('.reg-fault') as HTMLElement).style.display).not.toBe('none');
  });

  it('offers RECONNECT on the surface the click was made on, and it fires', () => {
    rig = mount();
    rig.lid.setPlayback(faulted());
    const act = rig.lid.root.querySelector('.reg-fault__act') as HTMLButtonElement | null;
    expect(act).not.toBeNull();
    act!.click();
    act!.click();
    // The lid passes `onReconnect` straight through to the register, so the
    // panel's own recovery handler is what runs — one action, two places to
    // reach it.
    expect(rig.reconnects).toBe(2);
  });

  it('clears the strip the moment the receiver is doing something again', () => {
    rig = mount();
    rig.lid.setPlayback(faulted());
    rig.lid.setPlayback({ ...INITIAL_PLAYBACK_STATE, phase: 'playing', station: BBC3 });
    expect((rig.lid.root.querySelector('.reg-fault') as HTMLElement).style.display).toBe('none');
  });

  it('takes null for "nothing to say", so a torn-down host cannot leave a fault up', () => {
    rig = mount();
    rig.lid.setPlayback(faulted());
    rig.lid.setPlayback(null);
    expect((rig.lid.root.querySelector('.reg-fault') as HTMLElement).style.display).toBe('none');
    expect(rig.lid.root.querySelectorAll('.entry.is-faulted')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// FIX B — the ledger row's tri-state
// ---------------------------------------------------------------------------

describe('what a ledger row says about itself', () => {
  it('reads TRYING while the engine is working on it, and is not selected', () => {
    rig = mount();
    rig.lid.setAir(GOOD.id, 'trying');
    const row = rig.row(GOOD.id);
    expect(row.classList.contains('is-trying')).toBe(true);
    expect(row.classList.contains('is-onair')).toBe(false);
    expect(row.classList.contains('is-faulted')).toBe(false);
    // Not on the air, so not selected. A screen reader must not be told
    // otherwise because somebody clicked it.
    expect(row.getAttribute('aria-selected')).toBe('false');
  });

  it('reads ON AIR only when the decoder is producing audio', () => {
    rig = mount();
    rig.lid.setAir(GOOD.id, 'on');
    const row = rig.row(GOOD.id);
    expect(row.classList.contains('is-onair')).toBe(true);
    expect(row.classList.contains('is-trying')).toBe(false);
    expect(row.getAttribute('aria-selected')).toBe('true');
  });

  it('reads FAILED, and stays failed until something re-tries it', () => {
    rig = mount();
    rig.lid.setAir(BBC3.id, 'failed');
    expect(rig.row(BBC3.id).classList.contains('is-faulted')).toBe(true);

    // Nothing has re-tried it. Ten repaints later it is still the line that
    // did not come up — the mark is not a transient.
    for (let i = 0; i < 10; i++) rig.lid.setAir(BBC3.id, 'failed');
    expect(rig.row(BBC3.id).classList.contains('is-faulted')).toBe(true);

    // RECONNECT: the engine is on it again, so the row says so.
    rig.lid.setAir(BBC3.id, 'trying');
    expect(rig.row(BBC3.id).classList.contains('is-faulted')).toBe(false);
    expect(rig.row(BBC3.id).classList.contains('is-trying')).toBe(true);
  });

  it('marks nothing at all in standby', () => {
    rig = mount();
    rig.lid.setAir(GOOD.id, 'on');
    rig.lid.setAir(GOOD.id, 'off');
    expect(rig.lid.root.querySelectorAll('.entry.is-onair')).toHaveLength(0);
    expect(rig.lid.root.querySelectorAll('.entry.is-trying')).toHaveLength(0);
    expect(rig.lid.root.querySelectorAll('.entry.is-faulted')).toHaveLength(0);
    expect(rig.row(GOOD.id).getAttribute('aria-selected')).toBe('false');
  });

  it('never marks two rows at once', () => {
    rig = mount();
    rig.lid.setAir(GOOD.id, 'on');
    rig.lid.setAir(BBC3.id, 'trying');
    expect(rig.lid.root.querySelectorAll('.entry.is-onair')).toHaveLength(0);
    expect(rig.lid.root.querySelectorAll('.entry.is-trying')).toHaveLength(1);
  });

  it('agrees with airStateOf for every phase the engine can report', () => {
    rig = mount();
    const cases: Array<[PlaybackState['phase'], string | null]> = [
      ['idle', null],
      ['resolving', 'is-trying'],
      ['connecting', 'is-trying'],
      ['buffering', 'is-trying'],
      ['reconnecting', 'is-trying'],
      ['playing', 'is-onair'],
      ['stalled', 'is-faulted'],
      ['error', 'is-faulted'],
    ];
    for (const [phase, expected] of cases) {
      const state = { ...INITIAL_PLAYBACK_STATE, phase, station: GOOD };
      rig.lid.setAir(GOOD.id, airStateOf(state));
      const row = rig.row(GOOD.id);
      for (const cls of ['is-trying', 'is-onair', 'is-faulted']) {
        expect(row.classList.contains(cls), `${phase} → ${cls}`).toBe(cls === expected);
      }
    }
  });

  it('is reported by setPlayback too, because both are the same state', () => {
    rig = mount();
    // A caller holding only the fault channel still gets a correct ledger.
    rig.lid.setPlayback({ ...INITIAL_PLAYBACK_STATE, phase: 'buffering', station: GOOD });
    expect(rig.row(GOOD.id).classList.contains('is-trying')).toBe(true);
    rig.lid.setPlayback(faulted());
    expect(rig.row(BBC3.id).classList.contains('is-faulted')).toBe(true);
    expect(rig.row(GOOD.id).classList.contains('is-trying')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FIX C — a row a stranger must not click blind
// ---------------------------------------------------------------------------

describe('what the ledger says before anything is clicked', () => {
  it('prints an HLS row, and marks it — it is not silently withheld', () => {
    rig = mount();
    const row = rig.row(BBC3.id);
    // `EMPTY_SCOPE.hideHls` is false on purpose: Law 4 prefers a struck, dated
    // row to a silently missing one. That is only honest if it is struck.
    expect(row.classList.contains('is-hls')).toBe(true);
    expect(row.querySelector('.entry__codec')!.textContent).toBe('HLS');
  });

  it('prints a row the checker could not reach, struck and dated FAIL', () => {
    rig = mount();
    const row = rig.row(DEAD.id);
    expect(row.classList.contains('is-dead')).toBe(true);
    expect(row.querySelector('.entry__chk')!.textContent).toBe('FAIL');
  });

  it('leaves an ordinary row unmarked, so the marks mean something', () => {
    rig = mount();
    const row = rig.row(GOOD.id);
    expect(row.classList.contains('is-hls')).toBe(false);
    expect(row.classList.contains('is-dead')).toBe(false);
    expect(row.querySelector('.entry__codec')!.textContent).toBe('MP3');
  });
});
