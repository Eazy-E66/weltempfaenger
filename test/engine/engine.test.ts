/**
 * The engine against real evidence.
 *
 * Every fact these tests assert about playback is one the engine *derived* — the
 * harness only ever says what the media element and the proxy were observed
 * doing. Nothing below sets a phase, and nothing below lets the engine be
 * believed on its own say-so. That is Law 2 as a test rather than as a comment.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DECODER_DEAD_MS, PlaybackEngine, TuneResolutionError } from '../../src/renderer/engine/engine';
import { AFC_MAX_ATTEMPTS } from '../../src/renderer/engine/afc';
import type { PlaybackState, PlayableStream, StationRef } from '../../src/shared/contracts';
import { FakeAudioElement, FakeProxy, installWebAudio } from '../helpers/fakeDeck';

/**
 * The four shapes of engine jargon that reached the panel in the field. None of
 * them may ever appear in a `PlaybackError.message` again, on any path.
 */
const JARGON = /MEDIA_ELEMENT_ERROR|DEMUXER_ERROR|FFmpeg|play\(\)/i;

/** The exact string a dead iHeart mount produced on the panel. */
const CHROMIUM_DEMUXER_ERROR =
  'DEMUXER_ERROR_COULD_NOT_OPEN: FFmpegDemuxer: open context failed';
const CHROMIUM_FORMAT_ERROR = 'MEDIA_ELEMENT_ERROR: Format error';

function station(id = 'st-1'): StationRef {
  return { id, name: `Station ${id}`, url: `http://radio.test/${id}`, tags: [], popularity: 1 };
}

function stream(url: string): PlayableStream {
  return { url, contentType: 'audio/mpeg', supportsIcyMetadata: false, origin: 'direct' };
}

interface Deck {
  engine: PlaybackEngine;
  el: FakeAudioElement;
  proxy: FakeProxy;
  /** Every state the engine emitted, in order. */
  emitted: PlaybackState[];
  setLevel(amplitude: number): void;
}

let audio: ReturnType<typeof installWebAudio>;
const decks: Deck[] = [];

function makeDeck(opts: Partial<ConstructorParameters<typeof PlaybackEngine>[0]> = {}): Deck {
  const el = new FakeAudioElement();
  const proxy = new FakeProxy();
  const emitted: PlaybackState[] = [];
  const engine = new PlaybackEngine({
    bridge: proxy.bridge(),
    audioElement: el as unknown as HTMLAudioElement,
    emitHz: 10,
    ...opts,
  });
  engine.subscribe((s) => emitted.push(s));
  const deck: Deck = { engine, el, proxy, emitted, setLevel: audio.setLevel };
  decks.push(deck);
  return deck;
}

/** Drive a deck all the way to a genuinely playing state, measuring nothing. */
async function reachPlaying(deck: Deck, streams: PlayableStream[] = [stream('http://a/1')]): Promise<void> {
  deck.setLevel(0.2);
  await deck.engine.tune(station(), streams);
  deck.proxy.stats({ bytesReceived: 64_000 });
  deck.el.ready(4);
  await vi.advanceTimersByTimeAsync(150);
  await vi.advanceTimersByTimeAsync(300);
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
  });
  audio = installWebAudio();
});

afterEach(() => {
  for (const deck of decks.splice(0)) deck.engine.dispose();
  audio.restore();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------

describe('re-tuning faster than a host answers', () => {
  /**
   * The blocker: `finally { this.resolving = false }` was not generation-guarded,
   * so a superseded tune cleared the flag its own replacement had just set. The
   * engine then reported `idle`, which is STANDBY on the panel — and because
   * `isPowered()` is `phase !== 'idle'`, the tuning knob stopped tuning while the
   * engine was demonstrably still resolving.
   */
  function slowHost(afterMs: number): (s: StationRef, signal: AbortSignal) => Promise<PlayableStream> {
    return (s, signal) =>
      new Promise<PlayableStream>((resolve, reject) => {
        const timer = setTimeout(() => resolve(stream(`http://a/${s.id}`)), afterMs);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new TuneResolutionError('aborted', 'tuned away'));
        });
      });
  }

  it('holds resolving across five tunes fired 300 ms apart and never drops to standby', async () => {
    const deck = makeDeck({ resolve: slowHost(8_000) });
    const phases: string[] = [];

    void deck.engine.tune(station('a'));
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(300);
      phases.push(deck.engine.currentState.phase);
      void deck.engine.tune(station(`b${i}`));
    }
    // Six more seconds of sampling, which is where /test/state read `idle`.
    for (let i = 0; i < 24; i++) {
      await vi.advanceTimersByTimeAsync(250);
      phases.push(deck.engine.currentState.phase);
    }

    expect(phases).not.toContain('idle');
    expect(new Set(phases)).toEqual(new Set(['resolving']));
  });

  it('never emits idle to a subscriber while a tune is in flight', async () => {
    const deck = makeDeck({ resolve: slowHost(8_000) });
    void deck.engine.tune(station('a'));
    await vi.advanceTimersByTimeAsync(400);
    void deck.engine.tune(station('b'));
    await vi.advanceTimersByTimeAsync(6_000);

    // The first emission is the subscribe-time snapshot, which is genuinely idle.
    const afterTune = deck.emitted.slice(1);
    expect(afterTune.length).toBeGreaterThan(20);
    expect(afterTune.map((s) => s.phase)).not.toContain('idle');
  });

  it('returns to idle when, and only when, stop() is called', async () => {
    const deck = makeDeck({ resolve: slowHost(8_000) });
    void deck.engine.tune(station('a'));
    await vi.advanceTimersByTimeAsync(400);
    void deck.engine.tune(station('b'));
    await vi.advanceTimersByTimeAsync(400);
    expect(deck.engine.currentState.phase).toBe('resolving');

    deck.engine.stop();
    expect(deck.engine.currentState.phase).toBe('idle');
  });

  it('lets the superseding tune finish resolving after the abandoned one rejects', async () => {
    const deck = makeDeck({ resolve: slowHost(1_000) });
    void deck.engine.tune(station('a'));
    await vi.advanceTimersByTimeAsync(300);
    void deck.engine.tune(station('b'));
    // The first tune's promise rejects here (aborted); the second is still out.
    await vi.advanceTimersByTimeAsync(400);
    expect(deck.engine.currentState.phase).toBe('resolving');

    await vi.advanceTimersByTimeAsync(1_000);
    expect(deck.engine.currentState.station?.id).toBe('b');
    expect(deck.engine.currentState.phase).not.toBe('idle');
  });

  it('holds a phase other than idle across the mint round trip when handed a stream', async () => {
    const deck = makeDeck();
    deck.proxy.mintDelayMs = 500;
    void deck.engine.tune(station(), [stream('http://a/1')]);
    const phases: string[] = [];
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(100);
      phases.push(deck.engine.currentState.phase);
    }
    expect(phases).not.toContain('idle');
  });
});

// ---------------------------------------------------------------------------

describe('what a failure is allowed to say', () => {
  /**
   * The panel of a 1977 receiver printed
   * `FAULT · DECODE — DEMUXER_ERROR_COULD_NOT_OPEN: FFMPEGDEMUXER: OPEN CONTEXT
   * FAILED`. Those strings are also a lie: the format was fine, the server went
   * away.
   */
  it('reports a dead upstream as upstream-closed with AFC on, not as a decode fault', async () => {
    const deck = makeDeck({ settings: { afcEnabled: true } });
    await reachPlaying(deck);

    // Upstream goes away; Chromium notices the truncated body and blames the demuxer.
    for (let attempt = 0; attempt <= AFC_MAX_ATTEMPTS; attempt++) {
      deck.proxy.drop();
      deck.el.fail(4, CHROMIUM_DEMUXER_ERROR);
      await vi.advanceTimersByTimeAsync(20_000);
      deck.proxy.stats({ bytesReceived: 0 });
    }

    const state = deck.engine.currentState;
    expect(state.phase).toBe('error');
    expect(state.error?.kind).toBe('upstream-closed');
    expect(state.error?.message).not.toMatch(JARGON);
    expect(state.error?.message).toContain('upstream ended the stream');
  });

  it('keeps the browser’s own words in diagnostics, where they belong', async () => {
    const deck = makeDeck({ settings: { afcEnabled: false } });
    await reachPlaying(deck);
    deck.el.fail(4, CHROMIUM_DEMUXER_ERROR);
    await vi.advanceTimersByTimeAsync(200);

    expect(deck.engine.currentState.error?.message).not.toMatch(JARGON);
    expect(deck.engine.diagnostics().rawFaultMessage).toContain('FFmpegDemuxer');
  });

  it('never lets engine jargon reach PlaybackError.message on any drivable path', async () => {
    const messages: string[] = [];

    // 1. The resolver hook throwing something raw.
    {
      const deck = makeDeck({
        resolve: () => Promise.reject(new Error(CHROMIUM_FORMAT_ERROR)),
      });
      await deck.engine.tune(station());
      await vi.advanceTimersByTimeAsync(200);
      messages.push(deck.engine.currentState.error!.message);
    }

    // 2. A media error with AFC off: the path that printed DECODE.
    {
      const deck = makeDeck({ settings: { afcEnabled: false } });
      await reachPlaying(deck);
      deck.el.fail(4, CHROMIUM_DEMUXER_ERROR);
      await vi.advanceTimersByTimeAsync(200);
      messages.push(deck.engine.currentState.error!.message);
    }

    // 3. A media error with AFC on, run until the budget is spent.
    {
      const deck = makeDeck({ settings: { afcEnabled: true } });
      await reachPlaying(deck);
      for (let i = 0; i <= AFC_MAX_ATTEMPTS; i++) {
        deck.el.fail(2, CHROMIUM_DEMUXER_ERROR);
        await vi.advanceTimersByTimeAsync(20_000);
      }
      messages.push(deck.engine.currentState.error!.message);
    }

    // 4. Autoplay policy refusing to start the element.
    {
      const deck = makeDeck();
      deck.el.playRejection = Object.assign(new Error('play() failed because the user didn’t interact'), {
        name: 'NotAllowedError',
      });
      await deck.engine.tune(station(), [stream('http://a/1')]);
      deck.proxy.stats({ bytesReceived: 64_000 });
      deck.el.ready(4);
      await vi.advanceTimersByTimeAsync(300);
      messages.push(deck.engine.currentState.error!.message);
    }

    // 5. Upstream simply closing, AFC off.
    {
      const deck = makeDeck({ settings: { afcEnabled: false } });
      await reachPlaying(deck);
      deck.proxy.drop(CHROMIUM_DEMUXER_ERROR);
      await vi.advanceTimersByTimeAsync(200);
      messages.push(deck.engine.currentState.error!.message);
    }

    expect(messages).toHaveLength(5);
    for (const message of messages) {
      expect(message).not.toMatch(JARGON);
      expect(message.trim().length).toBeGreaterThan(8);
    }
  });

  it('publishes the retry counter while AFC is re-locking, which nothing could read before', async () => {
    const deck = makeDeck({ settings: { afcEnabled: true } });
    await reachPlaying(deck);

    deck.proxy.drop();
    await vi.advanceTimersByTimeAsync(120);

    const state = deck.engine.currentState;
    expect(state.phase).toBe('reconnecting');
    expect(state.retry).toEqual({ attempt: 1, budget: AFC_MAX_ATTEMPTS, mount: 1, mounts: 1 });
    expect(state.error).toBeUndefined();
  });

  it('clears the retry counter once the engine gives up', async () => {
    const deck = makeDeck({ settings: { afcEnabled: true } });
    await reachPlaying(deck);
    for (let i = 0; i <= AFC_MAX_ATTEMPTS; i++) {
      deck.proxy.drop();
      await vi.advanceTimersByTimeAsync(20_000);
    }
    expect(deck.engine.currentState.phase).toBe('error');
    expect(deck.engine.currentState.retry).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe('the candidate list', () => {
  /**
   * A real PLS with a dead first entry and a healthy second burned 29 seconds
   * and six attempts on the corpse, then declared the station broken — with the
   * working sibling untouched in `ResolveResult.streams`.
   */
  it('moves to the next mount when a mount exhausts its budget, instead of failing', async () => {
    const deck = makeDeck({ settings: { afcEnabled: true } });
    await reachPlaying(deck, [stream('http://dead/1'), stream('http://good/2')]);

    for (let i = 0; i < AFC_MAX_ATTEMPTS; i++) {
      deck.proxy.drop();
      await vi.advanceTimersByTimeAsync(20_000);
    }
    // The budget for mount 1 is spent; the engine must now be on mount 2.
    deck.proxy.drop();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(deck.proxy.minted).toContain('http://good/2');
    expect(deck.engine.currentState.stream?.url).toBe('http://good/2');
    expect(deck.engine.currentState.phase).not.toBe('error');
  });

  it('restarts the budget on the new mount', async () => {
    const deck = makeDeck({ settings: { afcEnabled: true } });
    await reachPlaying(deck, [stream('http://dead/1'), stream('http://good/2')]);

    for (let i = 0; i < AFC_MAX_ATTEMPTS; i++) {
      deck.proxy.drop();
      await vi.advanceTimersByTimeAsync(20_000);
    }
    expect(deck.engine.currentState.retry ?? deck.engine.diagnostics().afcAttempts).toBe(
      AFC_MAX_ATTEMPTS,
    );

    // The drop that finds the budget spent: it moves on rather than giving up.
    deck.proxy.drop();
    await vi.advanceTimersByTimeAsync(120);

    const state = deck.engine.currentState;
    expect(state.phase).toBe('reconnecting');
    expect(state.retry).toMatchObject({ attempt: 1, mount: 2, mounts: 2 });
  });

  it('fails only when every mount has been tried, and says how many', async () => {
    const deck = makeDeck({ settings: { afcEnabled: true } });
    await reachPlaying(deck, [stream('http://dead/1'), stream('http://dead/2')]);

    for (let i = 0; i < (AFC_MAX_ATTEMPTS + 1) * 2 + 2; i++) {
      deck.proxy.drop();
      await vi.advanceTimersByTimeAsync(20_000);
    }
    const state = deck.engine.currentState;
    expect(state.phase).toBe('error');
    expect(state.error?.message).toContain('2 addresses');
    expect(state.error?.message).not.toMatch(JARGON);
  });

  it('accepts a single stream as a one-entry list, so old callers keep working', async () => {
    const deck = makeDeck();
    await deck.engine.tune(station(), stream('http://a/1'));
    expect(deck.engine.currentState.stream?.url).toBe('http://a/1');
    expect(deck.engine.diagnostics().candidateCount).toBe(1);
  });

  it('takes the whole list from a resolve hook that offers one', async () => {
    const deck = makeDeck({
      resolve: async () => [stream('http://a/1'), stream('http://a/2'), stream('http://a/3')],
    });
    await deck.engine.tune(station());
    await vi.advanceTimersByTimeAsync(150);
    expect(deck.engine.diagnostics().candidateCount).toBe(3);
    expect(deck.engine.currentState.stream?.url).toBe('http://a/1');
  });
});

// ---------------------------------------------------------------------------

describe('a lock the meter cannot support', () => {
  /**
   * Dragging the flywheel with a station playing but no band cut drove
   * `signalLevel` to 0.000 while the readout still printed LOCKED and the needle
   * sat on the zero stop. The panel and the meter contradicted each other in one
   * glance, which is the specific lie Law 2 exists to forbid.
   */
  it('reports playing with a real level', async () => {
    const deck = makeDeck();
    await reachPlaying(deck);
    expect(deck.engine.currentState.phase).toBe('playing');
    expect(deck.engine.currentState.signalLevel).toBeGreaterThan(0);
    expect(deck.engine.currentState.signalLoss).toBeUndefined();
  });

  it('stops reporting a lock once the front end is closed and the level is zero', async () => {
    const deck = makeDeck();
    await reachPlaying(deck);

    // The dial is dragged onto a band with no slots: proximity 0 everywhere.
    deck.engine.setTuningProximity(0);
    deck.setLevel(0);
    await vi.advanceTimersByTimeAsync(2_500);

    const state = deck.engine.currentState;
    expect(state.signalLevel).toBe(0);
    expect(state.phase).not.toBe('playing');
    expect(state.signalLoss).toBe('detuned');
  });

  it('names dead air as dead air when the front end is wide open', async () => {
    const deck = makeDeck();
    await reachPlaying(deck);
    deck.engine.setTuningProximity(1);
    deck.setLevel(0);
    await vi.advanceTimersByTimeAsync(2_500);

    expect(deck.engine.currentState.signalLoss).toBe('dead-air');
    expect(deck.engine.currentState.phase).not.toBe('playing');
  });

  it('does not flinch at a gap between tracks', async () => {
    const deck = makeDeck();
    await reachPlaying(deck);
    deck.setLevel(0);
    await vi.advanceTimersByTimeAsync(900);
    expect(deck.engine.currentState.phase).toBe('playing');
    deck.setLevel(0.2);
    await vi.advanceTimersByTimeAsync(300);
    expect(deck.engine.currentState.phase).toBe('playing');
    expect(deck.engine.currentState.signalLevel).toBeGreaterThan(0);
  });

  it('never emits a locked state at zero signal, across the whole run', async () => {
    const deck = makeDeck();
    await reachPlaying(deck);
    deck.engine.setTuningProximity(0);
    deck.setLevel(0);
    await vi.advanceTimersByTimeAsync(6_000);
    deck.setLevel(0.3);
    deck.engine.setTuningProximity(1);
    await vi.advanceTimersByTimeAsync(2_000);

    const lying = deck.emitted.filter((s) => s.phase === 'playing' && s.signalLevel === 0);
    // Only inside the gap grace, which is the deliberate part; nothing after it.
    for (const state of lying) expect(state.playingSeconds).toBeLessThan(60);
    const settled = deck.emitted.slice(-5);
    for (const state of settled) {
      expect(state.phase === 'playing' && state.signalLevel === 0).toBe(false);
    }
  });

  it('recovers as soon as the dial lands on a station again', async () => {
    const deck = makeDeck();
    await reachPlaying(deck);
    deck.engine.setTuningProximity(0);
    deck.setLevel(0);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(deck.engine.currentState.phase).toBe('stalled');

    deck.engine.setTuningProximity(1);
    deck.setLevel(0.25);
    await vi.advanceTimersByTimeAsync(300);
    expect(deck.engine.currentState.phase).toBe('playing');
    expect(deck.engine.currentState.signalLoss).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe('the bitrate slot', () => {
  it('prints the codec’s own rate and never the delivery rate', async () => {
    const deck = makeDeck();
    await reachPlaying(deck);
    deck.proxy.stats({
      bytesReceived: 900_000,
      measuredBitrateKbps: 1093, // Icecast burst-on-connect, genuinely measured
      info: {
        sessionId: 'x',
        url: 'u',
        finalUrl: 'u',
        redirects: [],
        statusCode: 200,
        icyProtocol: false,
        contentType: 'audio/aacp',
        supportsIcyMetadata: false,
        icyBitrate: 999,
        audioFormat: { codec: 'aac', sampleRate: 44100, channels: 2, frameBitrateKbps: 128, profile: 'AAC profile 2' },
      },
    });
    await vi.advanceTimersByTimeAsync(150);

    expect(deck.engine.currentState.codecBitrateKbps).toBe(128);
    expect(deck.engine.currentState.measuredBitrateKbps).toBe(1093);
    expect(deck.engine.currentState.sampleRate).toBe(44100);
  });

  it('falls back to icy-br only when no frame figure exists, and refuses absurd claims', async () => {
    const deck = makeDeck();
    await reachPlaying(deck);
    const info = {
      sessionId: 'x',
      url: 'u',
      finalUrl: 'u',
      redirects: [],
      statusCode: 200,
      icyProtocol: false,
      contentType: 'audio/aacp',
      supportsIcyMetadata: false,
    };
    deck.proxy.stats({ measuredBitrateKbps: 700, info: { ...info, icyBitrate: 96 } });
    await vi.advanceTimersByTimeAsync(150);
    expect(deck.engine.currentState.codecBitrateKbps).toBe(96);

    deck.proxy.stats({ measuredBitrateKbps: 700, info: { ...info, icyBitrate: 128_000 } });
    await vi.advanceTimersByTimeAsync(150);
    expect(deck.engine.currentState.codecBitrateKbps).toBeUndefined();
  });
});

describe('the stalled phase', () => {
  /**
   * A critic could not produce `phase: 'stalled'` in any scenario at 250 ms
   * sampling: the engine returned out of `tick()` before writing it whenever the
   * proxy reported a stall. A designed label that never renders is not a label.
   */
  it('is reachable when the decoder stops advancing while bytes still arrive', async () => {
    const deck = makeDeck();
    await reachPlaying(deck);

    deck.el.stopAdvancing();
    const seen: string[] = [];
    for (let i = 0; i < 16; i++) {
      await vi.advanceTimersByTimeAsync(250);
      deck.proxy.stats({ bytesReceived: 64_000, stalled: false });
      seen.push(deck.engine.currentState.phase);
    }
    expect(seen).toContain('stalled');
  });

  it('is visible at 250 ms sampling before AFC takes the deck away', async () => {
    const deck = makeDeck({ settings: { afcEnabled: true } });
    await reachPlaying(deck);

    deck.el.stopAdvancing();
    deck.proxy.stats({ bytesReceived: 64_000, stalled: true });

    const seen: string[] = [];
    for (let i = 0; i < 8; i++) {
      await vi.advanceTimersByTimeAsync(250);
      seen.push(deck.engine.currentState.phase);
    }
    expect(seen).toContain('stalled');
    expect(seen).toContain('reconnecting');
    expect(seen.indexOf('stalled')).toBeLessThan(seen.indexOf('reconnecting'));
  });

  it('names the cause when the proxy is the one reporting the stall', async () => {
    const deck = makeDeck({ settings: { afcEnabled: false } });
    await reachPlaying(deck);
    deck.el.stopAdvancing();
    deck.proxy.stats({ bytesReceived: 64_000, stalled: true });
    await vi.advanceTimersByTimeAsync(300);

    expect(deck.engine.currentState.phase).toBe('stalled');
    expect(deck.engine.currentState.signalLoss).toBe('flow-stopped');
  });
});

// ---------------------------------------------------------------------------
// Switching the receiver off
// ---------------------------------------------------------------------------

describe('power off after a fault', () => {
  /**
   * The regression, exactly as a listener hits it: a station fails, the panel
   * reads FAULT, RADIO is pressed for standby — and the panel showed STANDBY for
   * a single frame and then went back to FAULT for ever, because `stop()` reset
   * the published state but not the `failure` the next tick re-derives from.
   *
   * `isPowered()` is `phase !== 'idle'`, so the receiver also read as *powered*
   * while switched off.
   */
  async function faulted(): Promise<Deck> {
    const deck = makeDeck({
      settings: { afcEnabled: false },
      resolve: async () => {
        throw new TuneResolutionError('http', 'the station’s server refused the connection');
      },
    });
    await deck.engine.tune(station('dead'));
    await vi.advanceTimersByTimeAsync(200);
    expect(deck.engine.currentState.phase).toBe('error');
    return deck;
  }

  it('stays in standby instead of reverting to FAULT on the next tick', async () => {
    const deck = await faulted();
    deck.engine.stop();
    expect(deck.engine.currentState.phase).toBe('idle');

    // The ticker runs at 10 Hz; the revert used to arrive on the very first one.
    const phases: string[] = [];
    for (let i = 0; i < 30; i++) {
      await vi.advanceTimersByTimeAsync(100);
      phases.push(deck.engine.currentState.phase);
    }
    expect(new Set(phases)).toEqual(new Set(['idle']));
    expect(deck.engine.currentState.error).toBeUndefined();
  });

  it('clears the fault text as well as the phase, so the readout is not stale', async () => {
    const deck = await faulted();
    expect(deck.engine.diagnostics().rawFaultMessage).toBeTruthy();
    deck.engine.stop();
    await vi.advanceTimersByTimeAsync(300);
    expect(deck.engine.diagnostics().rawFaultMessage).toBeFalsy();
  });

  it('reads as unpowered, so a dial drag in standby tunes nothing', async () => {
    const deck = await faulted();
    deck.engine.stop();
    await vi.advanceTimersByTimeAsync(300);

    // This is precisely what the host asks before it lets the knob tune, and it
    // answered "powered" on a receiver that had been switched off.
    const powered = (): boolean => deck.engine.currentState.phase !== 'idle';
    expect(powered()).toBe(false);

    // The host's guard, driven for real: `onTune` returns before tuneStation.
    let tuned = 0;
    const dialDrag = (): void => {
      if (!powered()) return;
      tuned += 1;
      void deck.engine.tune(station('from-the-dial'), [stream('http://a/dial')]);
    };
    dialDrag();
    await vi.advanceTimersByTimeAsync(500);
    expect(tuned).toBe(0);
    expect(deck.proxy.minted).toHaveLength(0);
    expect(deck.engine.currentState.station).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The engine's own abort is not a fault
// ---------------------------------------------------------------------------

describe('a play() the engine itself cancelled', () => {
  /**
   * `evaluatePreroll` fires `play()` once the deadline expires even at
   * readyState < 3, where the promise stays pending. Everything that tears an
   * attempt down — a tune away, an AFC reconnect — then rejects it with
   * `AbortError`, and that rejection used to be turned into `fail('decode')`
   * against whatever the engine was doing by then.
   */
  it('does not fault the station that replaced the one being torn down', async () => {
    // NARROW, so the pre-roll deadline is 8 s rather than 20 s.
    const deck = makeDeck({ settings: { bufferDepth: 'narrow' } });
    deck.el.playPending = true;

    await deck.engine.tune(station('a'), [stream('http://a/1')]);
    deck.proxy.stats({ bytesReceived: 8_000 });
    // Never reaches HAVE_FUTURE_DATA, so play() is issued on the deadline only.
    await vi.advanceTimersByTimeAsync(9_000);
    expect(deck.el.calls).toContain('play');

    // Tune away. The teardown aborts the pending play() of 'a'.
    deck.el.playPending = false;
    deck.setLevel(0.2);
    await deck.engine.tune(station('b'), [stream('http://b/1')]);
    deck.proxy.stats({ bytesReceived: 64_000 });
    deck.el.ready(4);
    await vi.advanceTimersByTimeAsync(500);

    const state = deck.engine.currentState;
    expect(state.station?.id).toBe('b');
    expect(state.error).toBeUndefined();
    expect(state.phase).not.toBe('error');
  });

  it('lets AFC finish re-locking instead of killing the reconnect in flight', async () => {
    const deck = makeDeck({ settings: { afcEnabled: true } });
    await reachPlaying(deck);

    // The mount drops while a play() is still out — same generation, so nothing
    // but the name of the error distinguishes this from a real decode failure.
    deck.el.playPending = true;
    deck.el.stopAdvancing();
    deck.proxy.drop();
    await vi.advanceTimersByTimeAsync(200);
    expect(deck.engine.currentState.phase).toBe('reconnecting');

    deck.el.playPending = false;
    await vi.advanceTimersByTimeAsync(1_000);
    deck.proxy.stats({ bytesReceived: 96_000 });
    deck.el.ready(4);
    await vi.advanceTimersByTimeAsync(500);

    expect(deck.engine.currentState.error).toBeUndefined();
    expect(deck.engine.currentState.phase).toBe('playing');
    // Two sessions: the original and the re-lock. The reconnect really ran.
    expect(deck.proxy.minted.length).toBeGreaterThanOrEqual(2);
  });

  it('still reports a genuine autoplay refusal as the designed state', async () => {
    const deck = makeDeck();
    const denied = new Error('play() failed because the user did not interact');
    denied.name = 'NotAllowedError';
    deck.el.playRejection = denied;

    await deck.engine.tune(station(), [stream('http://a/1')]);
    deck.proxy.stats({ bytesReceived: 64_000 });
    deck.el.ready(4);
    await vi.advanceTimersByTimeAsync(400);

    const state = deck.engine.currentState;
    expect(state.phase).toBe('error');
    expect(state.error?.kind).toBe('aborted');
    expect(state.error?.message).not.toMatch(JARGON);
  });
});

// ---------------------------------------------------------------------------
// A refused mint
// ---------------------------------------------------------------------------

describe('the proxy refusing to mint a session', () => {
  /**
   * The AFC path has always caught this. The first attempt did not, so a
   * rejected `link.mint()` propagated out of `tune()` with `starting` still
   * true, and every subsequent tick derived `connecting` — for ever, with no
   * timeout. Law 4 forbids exactly that.
   */
  it('lands on a terminal, legible fault instead of CONNECTING for ever', async () => {
    const deck = makeDeck();
    deck.proxy.mintRejection = new Error('EPERM: the proxy could not bind a port');

    await deck.engine.tune(station(), [stream('http://a/1')]).catch(() => {
      throw new Error('tune() must not reject: the failure is a published state');
    });

    const phases: string[] = [];
    for (let i = 0; i < 60; i++) {
      await vi.advanceTimersByTimeAsync(500);
      phases.push(deck.engine.currentState.phase);
    }
    // Thirty seconds. The spinner used to run for as long as anyone watched.
    expect(new Set(phases)).toEqual(new Set(['error']));

    const state = deck.engine.currentState;
    expect(state.error?.kind).toBe('network');
    expect(state.error?.message).toBeTruthy();
    expect(state.error?.message).not.toMatch(JARGON);
    expect(state.error?.message).not.toMatch(/EPERM/);
    // The browser's own words survive where they belong.
    expect(deck.engine.diagnostics().rawFaultMessage).toMatch(/EPERM/);
  });

  it('does not fault the tune that superseded the one whose mint refused', async () => {
    const deck = makeDeck();
    deck.proxy.mintDelayMs = 400;
    deck.proxy.mintRejection = new Error('EPERM: the proxy could not bind a port');

    void deck.engine.tune(station('a'), [stream('http://a/1')]);
    await vi.advanceTimersByTimeAsync(100);

    deck.proxy.mintRejection = undefined;
    deck.proxy.mintDelayMs = 0;
    deck.setLevel(0.2);
    await deck.engine.tune(station('b'), [stream('http://b/1')]);
    deck.proxy.stats({ bytesReceived: 64_000 });
    deck.el.ready(4);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(deck.engine.currentState.station?.id).toBe('b');
    expect(deck.engine.currentState.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

/**
 * A receiver in standby must be a receiver that is doing nothing.
 *
 * The emit tick used to be started in the constructor and cleared only in
 * `dispose()`, so an engine with no session, no socket and no source on its
 * media element still woke ten times a second — 36,000 times an hour — to
 * derive `idle` from the same evidence as the tick before it and publish an
 * identical state. Measured on the packaged build it cost 4.7% of a core with
 * the gpu process at 0%: real work, about nothing.
 *
 * These are about *when the engine looks*, never about what it reports. Every
 * assertion below is on the observable timer population, and each is paired
 * with the phase the engine was publishing at the time, because a parked ticker
 * that also parked the truth would be a far worse bug than the one it fixes.
 */
describe('the tick runs while there is something to observe', () => {
  it('schedules nothing at all before the first tune', () => {
    const deck = makeDeck();
    expect(deck.engine.currentState.phase).toBe('idle');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('runs while a station is on the air, and emits at the asked-for rate', async () => {
    const deck = makeDeck();
    await reachPlaying(deck);
    expect(deck.engine.currentState.phase).toBe('playing');

    const before = deck.emitted.length;
    await vi.advanceTimersByTimeAsync(2_000);
    // 10 Hz for two seconds, plus whatever the media element's own events add.
    expect(deck.emitted.length - before).toBeGreaterThanOrEqual(20);
  });

  it('stops on the way back to standby and starts again on the next tune', async () => {
    const deck = makeDeck();
    await reachPlaying(deck);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    deck.engine.stop();
    expect(deck.engine.currentState.phase).toBe('idle');
    expect(vi.getTimerCount()).toBe(0);

    // …and nothing is published while it is parked: an engine that kept
    // emitting from somewhere else would make the saving imaginary.
    const quiet = deck.emitted.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(deck.emitted.length).toBe(quiet);

    deck.setLevel(0.2);
    await deck.engine.tune(station('b'), [stream('http://b/1')]);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    deck.proxy.stats({ bytesReceived: 64_000 });
    deck.el.ready(4);
    await vi.advanceTimersByTimeAsync(600);
    expect(deck.engine.currentState.phase).toBe('playing');
  });

  it('keeps ticking through a stall, which is exactly when it is needed', async () => {
    const deck = makeDeck();
    await reachPlaying(deck);

    // The bytes stop. Nothing else changes: no event, no call, no gesture.
    deck.proxy.stats({ stalled: true });
    await vi.advanceTimersByTimeAsync(3_000);

    // Whatever AFC has made of it by now — stalled, re-locking, or already
    // re-connecting — the receiver is not in standby and is still being watched.
    expect(deck.engine.currentState.phase).not.toBe('idle');
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// An abandoned re-lock must not speak for the station that replaced it
// ---------------------------------------------------------------------------

describe('a re-lock abandoned by a new tune', () => {
  it('cannot write its failure onto the station tuned in its place', async () => {
    // The AFC timer fires, `connect()` starts minting, the listener tunes
    // elsewhere while the mint is in flight, and then the mint rejects. Before
    // the generation guard on that path, the rejection called `fail()` and the
    // new station came up reading FAULT for a socket it never owned.
    const deck = makeDeck({ settings: { afcEnabled: true } });
    await reachPlaying(deck);

    deck.proxy.mintDelayMs = 200;
    deck.proxy.mintRejection = new Error('EPERM: the proxy could not bind a port');
    deck.proxy.drop();
    await vi.advanceTimersByTimeAsync(600); // past the 500 ms first AFC delay: the mint is in flight
    expect(deck.engine.currentState.phase).toBe('reconnecting');

    deck.proxy.mintDelayMs = 0;
    deck.proxy.mintRejection = undefined;
    const next = deck.engine.tune(station('st-2'), [stream('http://b/2')]);
    await vi.advanceTimersByTimeAsync(300); // the abandoned mint rejects in here
    await next;
    deck.proxy.stats({ bytesReceived: 64_000 });
    deck.el.ready(4);
    await vi.advanceTimersByTimeAsync(450);

    const state = deck.engine.currentState;
    expect(state.station?.id).toBe('st-2');
    expect(state.phase).not.toBe('error');
    expect(state.error).toBeUndefined();
    expect(deck.emitted.filter((s) => s.station?.id === 'st-2' && s.phase === 'error')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// A decoder that produces nothing while bytes keep arriving
// ---------------------------------------------------------------------------

describe('bytes that never become audio', () => {
  it('is a decode fault after the deadline when nothing has ever played — not BUFFERING for ever', async () => {
    // Measured on the built app against a loopback stream of noise: BUFFERING
    // with the byte count climbing for as long as anyone cared to wait.
    const deck = makeDeck({ settings: { afcEnabled: true, bufferDepth: 'narrow' } });
    // Chromium exactly: play() on an element that never reaches HAVE_FUTURE_DATA
    // stays pending and nothing advances.
    deck.el.playPending = true;
    await deck.engine.tune(station(), [stream('http://a/1')]);
    let bytes = 64_000;
    for (let t = 0; t < DECODER_DEAD_MS + 3_000; t += 500) {
      bytes += 8_000;
      deck.proxy.stats({ bytesReceived: bytes, prerollComplete: true });
      await vi.advanceTimersByTimeAsync(500);
      if (t < DECODER_DEAD_MS - 1_000) {
        expect(deck.engine.currentState.phase, `at ${t} ms`).toBe('buffering');
      }
    }
    const state = deck.engine.currentState;
    expect(state.phase).toBe('error');
    expect(state.error?.kind).toBe('decode');
    expect(state.error?.message).not.toMatch(JARGON);
  });

  it('is a drop for AFC to re-lock when the stream turned to noise mid-song', async () => {
    const deck = makeDeck({ settings: { afcEnabled: true } });
    await reachPlaying(deck);
    // The element stops advancing; the proxy keeps counting bytes.
    deck.el.stopAdvancing();
    let bytes = 200_000;
    const seen = new Set<string>();
    for (let t = 0; t < DECODER_DEAD_MS + 4_000; t += 500) {
      bytes += 8_000;
      deck.proxy.stats({ bytesReceived: bytes, prerollComplete: true });
      await vi.advanceTimersByTimeAsync(500);
      seen.add(`${deck.engine.currentState.phase}:${deck.engine.currentState.signalLoss ?? '-'}`);
    }
    // The stall is named for what it is while it stands, then AFC takes over.
    expect(seen.has('stalled:undecodable')).toBe(true);
    expect(seen.has('stalled:flow-stopped')).toBe(false);
    expect(seen.has('reconnecting:-')).toBe(true);
  });
});
