/**
 * A driveable stand-in for everything the engine touches that is not the engine:
 * one media element, one WebAudio graph, one proxy.
 *
 * Every fake here is a *source of evidence*, never an opinion. Nothing in this
 * file decides a phase, a level or a fault — the test sets out what the browser
 * and the proxy are observed to be doing, and the engine derives the rest. That
 * is the only way a test of Law 2 can mean anything: if the harness asserted
 * playback, the engine agreeing would prove nothing.
 */

import type {
  ProxyEvent,
  ProxyHandle,
  ProxyMetadata,
  ProxySessionStats,
} from '../../src/main/proxy/types';
import type { PsppcprBridge } from '../../src/main/ipc';

// ---------------------------------------------------------------------------
// The media element
// ---------------------------------------------------------------------------

interface Range {
  start: number;
  end: number;
}

/**
 * An `<audio>` element as the engine actually uses it: events, readyState,
 * `buffered`, a `currentTime` that only moves when something is really playing,
 * and a `MediaError` that survives until the next `load()` — which is the detail
 * the reconnect path turns on.
 */
export class FakeAudioElement {
  crossOrigin: string | null = null;
  preload = '';
  autoplay = false;
  controls = false;
  src = '';

  readyState = 0;
  networkState = 0;
  paused = true;
  ended = false;
  error: { code: number; message: string } | undefined;

  /** Set by the test: the element is genuinely rendering audio. */
  advancing = false;
  private advancingSince = 0;
  private frozenAt = 0;
  private ranges: Range[] = [];

  private readonly listeners = new Map<string, Set<() => void>>();
  /** Every load()/play()/pause() the engine performed, in order. */
  readonly calls: string[] = [];

  constructor(private readonly now: () => number = () => Date.now()) {}

  get currentTime(): number {
    if (!this.advancing) return this.frozenAt;
    return this.frozenAt + (this.now() - this.advancingSince) / 1000;
  }

  get buffered(): { length: number; start(i: number): number; end(i: number): number } {
    const ranges = this.ranges;
    return {
      length: ranges.length,
      start: (i: number) => ranges[i]!.start,
      end: (i: number) => ranges[i]!.end,
    };
  }

  addEventListener(type: string, listener: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
  }

  async play(): Promise<void> {
    this.calls.push('play');
    if (this.playRejection) {
      const err = this.playRejection;
      this.playRejection = undefined;
      throw err;
    }
    if (this.playPending) {
      // Chromium exactly: a play() issued before HAVE_FUTURE_DATA does not
      // settle at all until the element either starts rendering or its load is
      // cancelled. Nothing here decides anything — the promise simply stays out.
      return new Promise<void>((_resolve, reject) => {
        this.pendingPlayReject = reject;
      });
    }
    this.paused = false;
    this.dispatch('play');
    this.startAdvancing();
    this.dispatch('playing');
  }

  /** Armed by a test to make the next play() reject, as autoplay policy does. */
  playRejection?: Error;

  /**
   * Armed by a test: play() is called at readyState < 3 and stays pending, so
   * the next load() aborts it. This is the only way an `AbortError` is ever
   * produced in real life, and it is produced by the engine's own teardown.
   */
  playPending = false;
  private pendingPlayReject?: (err: Error) => void;

  /** Cancelling the load rejects a still-pending play(), as the spec requires. */
  private abortPendingPlay(): void {
    const reject = this.pendingPlayReject;
    if (!reject) return;
    this.pendingPlayReject = undefined;
    const err = new Error('The play() request was interrupted by a new load request.');
    err.name = 'AbortError';
    reject(err);
  }

  pause(): void {
    this.calls.push('pause');
    this.paused = true;
    this.stopAdvancing();
  }

  load(): void {
    this.calls.push('load');
    this.abortPendingPlay();
    // Exactly the browser's behaviour, and load-bearing for AFC: a load clears
    // the MediaError, which is why a reconnect has to perform one.
    this.error = undefined;
    this.readyState = 0;
    this.ranges = [];
    this.frozenAt = 0;
    this.stopAdvancing();
    this.dispatch('emptied');
  }

  removeAttribute(name: string): void {
    if (name === 'src') this.src = '';
  }

  // --- test controls -------------------------------------------------------

  /** The browser says it can play on, with `seconds` of audio ahead. */
  ready(seconds: number): void {
    this.readyState = 4;
    this.ranges = [{ start: 0, end: this.currentTime + seconds }];
    this.dispatch('canplay');
  }

  /** Audio really is being rendered from here on. */
  startAdvancing(): void {
    if (this.advancing) return;
    this.frozenAt = this.currentTime;
    this.advancingSince = this.now();
    this.advancing = true;
  }

  /** The decoder ran dry: currentTime stops, everything else stays as it was. */
  stopAdvancing(): void {
    if (!this.advancing) return;
    this.frozenAt = this.currentTime;
    this.advancing = false;
  }

  /** The element reports a MediaError, exactly as Chromium does. */
  fail(code: number, message: string): void {
    this.error = { code, message };
    this.stopAdvancing();
    this.dispatch('error');
  }
}

// ---------------------------------------------------------------------------
// WebAudio
// ---------------------------------------------------------------------------

/** What the decoder is producing right now, as the test declares it. */
export interface DecodedLevel {
  amplitude: number;
}

/** The one analyser reading that matters: the station tap the meter reads. */
export class FakeAnalyser {
  fftSize = 2048;
  smoothingTimeConstant = 0;

  constructor(private readonly level: DecodedLevel) {}

  getFloatTimeDomainData(buffer: Float32Array): void {
    for (let i = 0; i < buffer.length; i++) buffer[i] = this.level.amplitude;
  }

  connect(): void {}
  disconnect(): void {}
}

class FakeParam {
  constructor(public value = 0) {}
  setTargetAtTime(value: number): void {
    this.value = value;
  }
  setValueAtTime(value: number): void {
    this.value = value;
  }
}

class FakeNode {
  readonly gain = new FakeParam(1);
  readonly frequency = new FakeParam(0);
  readonly Q = new FakeParam(1);
  type = '';
  curve: Float32Array | null = null;
  oversample = 'none';
  buffer: unknown = null;
  loop = false;
  connect(): void {}
  disconnect(): void {}
  start(): void {}
  stop(): void {}
}

/**
 * Installs a WebAudio implementation on globalThis and hands back the station
 * analyser, so a test can say what the decoder is producing.
 */
export function installWebAudio(): {
  /** What the decoder is producing. Set it before the level is first read. */
  setLevel(amplitude: number): void;
  restore(): void;
} {
  const level: DecodedLevel = { amplitude: 0 };

  class FakeAudioContext {
    state = 'running';
    sampleRate = 48000;
    currentTime = 0;
    destination = new FakeNode();

    createMediaElementSource(): FakeNode {
      return new FakeNode();
    }
    createBiquadFilter(): FakeNode {
      return new FakeNode();
    }
    createGain(): FakeNode {
      return new FakeNode();
    }
    createWaveShaper(): FakeNode {
      return new FakeNode();
    }
    createAnalyser(): FakeAnalyser {
      return new FakeAnalyser(level);
    }
    createBuffer(_channels: number, frames: number): { getChannelData(): Float32Array } {
      const data = new Float32Array(frames);
      return { getChannelData: () => data };
    }
    createBufferSource(): FakeNode {
      return new FakeNode();
    }
    async resume(): Promise<void> {
      this.state = 'running';
    }
    async close(): Promise<void> {
      this.state = 'closed';
    }
  }

  const holder = globalThis as unknown as Record<string, unknown>;
  const previous = holder.AudioContext;
  holder.AudioContext = FakeAudioContext;
  return {
    setLevel(amplitude: number): void {
      level.amplitude = amplitude;
    },
    restore(): void {
      holder.AudioContext = previous;
    },
  };
}

// ---------------------------------------------------------------------------
// The proxy
// ---------------------------------------------------------------------------

/** A session the test drives: it mints handles and reports whatever it is told. */
export class FakeProxy {
  private seq = 0;
  private readonly statsSubs = new Set<(s: ProxySessionStats) => void>();
  private readonly metaSubs = new Set<(m: ProxyMetadata) => void>();
  private readonly eventSubs = new Set<(e: ProxyEvent) => void>();

  /** Upstream URLs minted, in order — this is the candidate walk, observed. */
  readonly minted: string[] = [];
  readonly stopped: string[] = [];
  current?: string;

  /** How long `start()` takes to answer. Models the IPC round trip. */
  mintDelayMs = 0;

  /**
   * Armed by a test: minting refuses. A dead IPC channel, a proxy that cannot
   * bind, an OS that says no — from the renderer all of them look like this.
   */
  mintRejection?: Error;

  async start(upstreamUrl: string): Promise<ProxyHandle> {
    this.minted.push(upstreamUrl);
    const sessionId = `s${++this.seq}`;
    if (this.mintDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.mintDelayMs));
    }
    if (this.mintRejection) throw this.mintRejection;
    this.current = sessionId;
    return { url: `http://127.0.0.1:9/stream?s=${sessionId}`, sessionId, port: 9, prerollSeconds: 2 };
  }

  async stop(sessionId: string): Promise<void> {
    this.stopped.push(sessionId);
  }

  /** Report session telemetry, as the main process broadcasts it. */
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

  /**
   * Upstream went away by itself — the only thing AFC ever keys off.
   *
   * `detail` is the transport's own words, exactly as `ProxySession.finish`
   * emits them (`upstream socket error: read ECONNRESET`). The panel may never
   * read it; `diagnostics()` is the only place it is allowed to land.
   */
  drop(message = 'upstream ended the stream', detail?: string): void {
    const sessionId = this.current;
    if (!sessionId) return;
    for (const cb of this.eventSubs) {
      cb({
        sessionId,
        kind: 'closed',
        graceful: false,
        message,
        at: Date.now(),
        ...(detail === undefined ? {} : { detail }),
      });
    }
  }

  metadata(meta: Omit<ProxyMetadata, 'sessionId'>): void {
    const sessionId = this.current;
    if (!sessionId) return;
    for (const cb of this.metaSubs) cb({ ...meta, sessionId });
  }

  bridge(): PsppcprBridge {
    const noop = async (): Promise<void> => {};
    return {
      api: 1,
      proxy: {
        start: (url: string) => this.start(url),
        stop: (id: string) => this.stop(id),
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
      settings: { load: async () => ({}) as never, save: noop },
      memory: { load: async () => ({ presets: [] }), save: noop },
      directory: {
        listIndex: async () => ({ ok: true, value: {} }) as never,
        search: async () => ({ ok: true, value: [] }) as never,
        reportListening: noop,
      },
      resolver: { resolve: async () => ({ ok: true, streams: [] }) as never },
      app: {},
      reportPlaybackState: () => {},
    } as unknown as PsppcprBridge;
  }
}
