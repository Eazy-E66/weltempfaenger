/**
 * PlaybackEngine — the receiver's audio front end.
 *
 * `tune()` *requests* a station. Nothing about PlaybackState is written from that
 * request: phase, signal level, bitrate, buffer depth and byte counts are all
 * derived on a tick from real media-element events, the AnalyserNode, and byte
 * flow reported by the local proxy. A dead stream reads dead.
 */

import type {
  PlaybackError,
  PlaybackState,
  PlayableStream,
  RetryProgress,
  Settings,
  SignalLoss,
  StationRef,
} from '../../shared/contracts.js';
import { DEFAULT_SETTINGS, INITIAL_PLAYBACK_STATE } from '../../shared/contracts.js';
import type { ProxySessionStats } from '../../main/proxy/types.js';
import { getBridge, type PsppcprBridge } from './bridge.js';
import { AudioStage } from './stage.js';
import { ProxyLink } from './link.js';
import { MediaObserver } from './media-observer.js';
import { derivePhase, prerollDeadlineMs, prerollTarget, type PhaseEvidence } from './phase.js';
import { Afc, AFC_STABLE_MS } from './afc.js';
import { linkHealth } from './meter.js';
import { buildDiagnostics, type EngineDiagnostics } from './diagnostics.js';

/**
 * What a `resolve` hook throws when it knows *why* resolution failed.
 *
 * Without this the engine can only record `network`, which would flatten "this
 * station is HLS and Chromium cannot decode it" and "the host is dead" into the
 * same readout. Law 4 wants the specific reason on the panel, so the hook is
 * allowed to name it. A hook that throws anything else still lands on
 * `network`, so this is additive.
 */
export class TuneResolutionError extends Error {
  readonly kind: PlaybackError['kind'];

  constructor(kind: PlaybackError['kind'], message: string) {
    super(message);
    this.name = 'TuneResolutionError';
    this.kind = kind;
  }
}

/**
 * How long the reported `signalLevel` must sit on exactly zero before the engine
 * stops calling the phase `playing`.
 *
 * Not an arbitrary debounce. Broadcast material genuinely reaches digital
 * silence between items, and `deflectionFor` returns a hard zero below -38 dBFS,
 * so an instantaneous rule would strobe the panel on every track gap. Longer
 * than any gap, far shorter than a listener's patience with a dead deck.
 */
export const SILENT_LOCK_MS = 1_600;

/**
 * Station-path gain below which the front end counts as closed.
 *
 * `stationGainFor` is `proximity^0.6`, so this is proximity < 0.007 — i.e. the
 * dial is not on a station at all, rather than merely off-centre.
 */
const FRONT_END_CLOSED = 0.05;

/**
 * How long a stall is shown before AFC acts on it.
 *
 * Law 4 wants dead air *visible*: the meter falls, the readout says why. Jumping
 * straight from LOCKED to RE-LOCKING inside one tick means the state that
 * explains what happened is never rendered at any sampling rate — which is
 * exactly how `stalled` came to look like an unreachable label.
 */
export const STALL_HOLD_MS = 750;

/**
 * How long the decoder may produce nothing while bytes keep arriving before the
 * engine stops calling it BUFFERING or SIGNAL LOST and names it.
 *
 * Measured on the built app against a loopback stream of noise: from the
 * first byte the panel read BUFFERING with the byte count climbing for as
 * long as anyone cared to wait, and noise injected mid-song read `SIGNAL LOST
 * · FLOW STOPPED` beside a byte count that had not stopped. Neither state had
 * an exit: the proxy's stall detector never fires while bytes flow, so AFC
 * never engaged, and nothing else was watching the decoder.
 *
 * Counted from the later of the pre-roll completing and the decoder's last
 * advance, so a wide buffer's ten seconds of pre-roll are not charged to it.
 */
export const DECODER_DEAD_MS = 10_000;

/** Bytes are "flowing" if the count moved within this window. */
const FLOW_FRESH_MS = 2_000;

/**
 * Strings that betray the browser's internals rather than describing a fault.
 *
 * Chromium's `MediaError.message` is a developer diagnostic —
 * `DEMUXER_ERROR_COULD_NOT_OPEN: FFmpegDemuxer: open context failed` — and it is
 * both unreadable on a silkscreened panel and *wrong*: it names a format problem
 * for what is almost always a server that went away. Anything matching this is
 * kept for `diagnostics()` and replaced on the panel (Law 4).
 */
const ENGINE_JARGON =
  /MEDIA_ELEMENT_ERROR|MEDIA_ERR_|DEMUXER_ERROR|PIPELINE_ERROR|DECODER_ERROR|FFmpeg|play\(\)|NotAllowedError|NotSupportedError|AbortError/i;

/** The designed sentence for each failure kind, used when the raw text cannot be. */
const FAULT_FALLBACK: Record<PlaybackError['kind'], string> = {
  network: 'the connection to the station failed',
  http: 'the station’s server refused the connection',
  'not-audio': 'that address does not serve a stream',
  hls: 'this station is HLS only, which this receiver cannot decode',
  'empty-playlist': 'the station list at that address was empty',
  'too-many-redirects': 'the address redirected in circles',
  timeout: 'the station took too long to answer',
  decode: 'this stream is in a form this receiver cannot decode',
  'upstream-closed': 'the station stopped sending',
  aborted: 'the attempt was cancelled',
};

export interface PlaybackEngineOptions {
  bridge?: PsppcprBridge;
  settings?: Partial<Settings>;
  /**
   * Lets `tune(station)` work without a pre-resolved stream. Owned by the
   * resolver slice.
   *
   * Returning the resolver's whole candidate list is what makes a PLS with a
   * dead first entry recoverable without a keypress: the engine walks it when a
   * mount exhausts its AFC budget. A single stream is still accepted and means
   * "one candidate".
   */
  resolve?: (
    station: StationRef,
    signal: AbortSignal,
  ) => Promise<PlayableStream | PlayableStream[]>;
  /** State emission rate. The UI animates the needle itself from signalLevel. */
  emitHz?: number;
  audioElement?: HTMLAudioElement;
}

export class PlaybackEngine {
  private readonly bridge: PsppcprBridge;
  private readonly el: HTMLAudioElement;
  private readonly stage: AudioStage;
  private readonly link: ProxyLink;
  private readonly observer: MediaObserver;
  private readonly afc = new Afc();
  private readonly subscribers = new Set<(s: PlaybackState) => void>();

  private settings: Settings;
  private state: PlaybackState = { ...INITIAL_PLAYBACK_STATE };

  /** Bumped on every tune/stop so late async work from an abandoned tune is dropped. */
  private generation = 0;
  private resolveAbort?: AbortController;
  private resolving = false;
  /** A tune is under way but has not reached a session yet. */
  private starting = false;
  private reconnecting = false;
  /** True only inside teardownCurrent(); see the note there. */
  private tearingDown = false;
  private failure?: PlaybackError;
  /** The browser's own words for the last fault. Diagnostics only, never the panel. */
  private rawFault?: string;

  /** Every mount the resolver offered, in preference order, and which is in use. */
  private candidates: PlayableStream[] = [];
  private candidateIndex = 0;

  private bytesCarried = 0;
  private playingMs = 0;
  private stablePlayingMs = 0;
  private lastTickAt = Date.now();

  /** Half of the meter reading, re-derived on every tick. See readSignalLevel(). */
  private linkHealth = 0;
  private lastBytes = 0;
  private lastBytesAt = 0;

  private prerollMet = false;
  private prerollStartedAt = 0;
  /** When the proxy first reported the pre-roll complete for this session. */
  private prerollCompleteAt?: number;
  private lastBytesSeen = 0;
  private lastBytesMovedAt = 0;
  /** Wall clock of the last tick at which the reported level was off the stop. */
  private lastSignalAt = 0;
  /** Wall clock at which the derived phase first read `stalled`. */
  private stalledSince?: number;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private ticker?: ReturnType<typeof setInterval>;
  /** Period of the emit tick, milliseconds. Fixed at construction. */
  private readonly tickMs: number;
  private unsubObserver?: () => void;

  constructor(private readonly opts: PlaybackEngineOptions = {}) {
    this.bridge = opts.bridge ?? getBridge();
    this.settings = { ...DEFAULT_SETTINGS, ...opts.settings };

    this.el = opts.audioElement ?? new Audio();
    // Without this the proxy's ACAO header is ignored and MediaElementSource
    // yields a tainted node that outputs silence.
    this.el.crossOrigin = 'anonymous';
    this.el.preload = 'auto';
    this.el.autoplay = false;
    this.el.controls = false;

    this.stage = new AudioStage(this.el);
    this.observer = new MediaObserver(this.el);
    this.unsubObserver = this.observer.onAny(() => this.tick());

    this.link = new ProxyLink(this.bridge, {
      metadata: (meta) => {
        this.state = {
          ...this.state,
          nowPlaying: {
            title: meta.title,
            artist: meta.artist,
            track: meta.track,
            receivedAt: meta.receivedAt,
          },
        };
      },
      dropped: (message, raw) => this.onDrop(message, raw),
      changed: () => this.tick(),
    });

    this.tickMs = Math.round(1000 / (opts.emitHz ?? 10));
    // Deliberately NOT started here. A fresh engine owns no session, no socket
    // and no element with a source on it, so there is nothing for a tick to
    // observe: see syncTicker().
  }

  // --- public API ----------------------------------------------------------

  subscribe(cb: (s: PlaybackState) => void): () => void {
    this.subscribers.add(cb);
    cb(this.state);
    return () => this.subscribers.delete(cb);
  }

  get currentState(): PlaybackState {
    return this.state;
  }

  get currentSettings(): Settings {
    return this.settings;
  }

  /**
   * Synchronous meter read for a 60 fps needle: decoded level times measured
   * link health, which is what the face's SIGNAL … HEALTH scale claims to show.
   *
   * Link health is re-derived on the 10 Hz tick — it comes from proxy telemetry
   * that only arrives at that rate — and cached here, so reading at frame rate
   * costs one analyser pass and a multiply.
   */
  readSignalLevel(): number {
    return this.stage.readSignalLevel() * this.linkHealth;
  }

  /** The link half of the meter reading on its own, 0..1. For diagnostics. */
  get currentLinkHealth(): number {
    return this.linkHealth;
  }

  /** Post-master analyser, once the graph exists. For output visualisation only. */
  get outputAnalyser(): AnalyserNode | undefined {
    return this.stage.outputAnalyser;
  }

  /** Call from a user gesture: browsers keep the AudioContext suspended until then. */
  unlock(): Promise<void> {
    return this.stage.unlock(this.settings);
  }

  async tune(station: StationRef, stream?: PlayableStream | PlayableStream[]): Promise<void> {
    const gen = this.teardownCurrent();
    const needsResolve = stream === undefined;
    if (needsResolve && !this.opts.resolve) {
      throw new Error('tune() needs a PlayableStream or a resolve option');
    }

    // Both flags are set *before* the first await. `unlock()` resumes an
    // AudioContext and `mint()` is an IPC round trip; a phase of `idle` across
    // either would mean STANDBY on the panel, `isPowered()` false, and the
    // tuning knob refusing to tune — while the engine is demonstrably working.
    this.resolving = needsResolve;
    this.starting = true;
    this.state = { ...INITIAL_PLAYBACK_STATE, station };
    this.failure = undefined;
    this.rawFault = undefined;
    this.afc.reset();
    this.candidates = [];
    this.candidateIndex = 0;
    this.bytesCarried = 0;
    this.playingMs = 0;
    this.stablePlayingMs = 0;
    // Derive and publish rather than assert: the phase that comes out of this is
    // whatever the evidence above supports, exactly as on every other tick.
    this.tick();
    await this.unlock();
    if (gen !== this.generation) return;

    let playable: PlayableStream | PlayableStream[] | undefined = stream;
    if (needsResolve) {
      this.resolveAbort = new AbortController();
      try {
        playable = await this.opts.resolve!(station, this.resolveAbort.signal);
      } catch (err) {
        if (gen !== this.generation) return;
        const kind = err instanceof TuneResolutionError ? err.kind : 'network';
        this.fail(kind, (err as Error).message);
        return;
      } finally {
        // Generation-guarded like every other post-await branch in this method.
        // Without the guard a superseded tune clears the flag the tune that
        // replaced it has just set, and re-tuning inside half a second reports
        // STANDBY while the engine is visibly still resolving (Law 2).
        if (gen === this.generation) this.resolving = false;
      }
    }
    if (gen !== this.generation) return;

    const candidates = streamList(playable);
    if (candidates.length === 0) {
      this.fail('empty-playlist', `${station.name} has no playable mount`);
      return;
    }
    this.candidates = candidates;
    this.candidateIndex = 0;
    this.state = { ...this.state, stream: candidates[0] };
    // The AFC path has always caught this; the first attempt did not, and the
    // difference was an infinite spinner. `connect()` clears `starting` only
    // *after* `link.mint()` resolves, so a rejected mint — the proxy refusing to
    // start, a dead IPC channel — propagated out of `tune()` into
    // `host.tuneStation`'s `.catch(() => {})` with `starting` still true, and
    // every subsequent tick derived 'connecting' with no timeout behind it.
    // Law 4: a failure is a designed state with words on it, never a spinner.
    await this.connect(gen, candidates[0]!).catch((err) => {
      if (gen !== this.generation) return;
      this.fail('network', 'the connection to the station failed', (err as Error).message);
    });
  }

  stop(): void {
    this.teardownCurrent();
    this.state = { ...INITIAL_PLAYBACK_STATE };
    this.emit();
    // Standby, decided here rather than a tenth of a second from now by a tick
    // whose only finding would be that the receiver is off.
    this.syncTicker('idle');
  }

  setSettings(patch: Partial<Settings>): void {
    const prev = this.settings;
    this.settings = { ...this.settings, ...patch };
    this.stage.applySettings(this.settings);
    // A change of buffer depth only takes effect on the next pre-roll; changing
    // it mid-stream must not retroactively re-gate audio that is already playing.
    if (prev.bufferDepth !== this.settings.bufferDepth && !this.prerollMet) {
      this.prerollStartedAt = Date.now();
    }
  }

  /** 0 = between stations (full hiss), 1 = locked on (silent). */
  setTuningProximity(proximity: number): void {
    this.stage.setProximity(proximity);
  }

  diagnostics(): EngineDiagnostics {
    return buildDiagnostics({
      settings: this.settings,
      stage: this.stage,
      link: this.link,
      observation: this.observer.observation,
      prerollMet: this.prerollMet,
      prerollStartedAt: this.prerollStartedAt,
      afcAttempts: this.afc.attempts,
      linkHealth: this.linkHealth,
      now: Date.now(),
      rawFaultMessage: this.rawFault,
      candidateIndex: this.candidateIndex,
      candidateCount: this.candidates.length,
    });
  }

  dispose(): void {
    this.teardownCurrent();
    this.stopTicker();
    this.unsubObserver?.();
    this.link.dispose();
    this.observer.dispose();
    this.stage.dispose();
    this.subscribers.clear();
  }

  // --- connection ----------------------------------------------------------

  private async connect(gen: number, stream: PlayableStream): Promise<void> {
    // NARROW/WIDE is enforced upstream of the browser: Chromium refuses to hold
    // more than ~2-3 s of a live MP3 in HTMLMediaElement.buffered, so the deep
    // buffer has to be accumulated by the proxy and handed over in one lump.
    const handle = await this.link.mint(stream.url, prerollTarget(this.settings.bufferDepth));
    if (gen !== this.generation) {
      this.link.discard(handle);
      return;
    }
    this.link.adopt(handle);
    this.starting = false;
    this.reconnecting = false;
    this.prerollMet = false;
    this.prerollStartedAt = Date.now();
    this.stalledSince = undefined;

    this.prerollCompleteAt = undefined;
    this.lastBytesSeen = 0;
    this.lastBytesMovedAt = Date.now();

    this.observer.reset();
    this.el.src = handle.url;
    this.el.load(); // the socket opens here, not before
    this.tick();
  }

  /**
   * Bytes are arriving from the session: the count moved inside `FLOW_FRESH_MS`.
   * Tracked here rather than read off the proxy's stall flag because that flag
   * is about *absence* of bytes; this is the presence that makes a silent
   * decoder the decoder's fault.
   */
  private bytesFlowing(now: number, stats: ProxySessionStats | undefined): boolean {
    const bytes = stats?.bytesReceived ?? 0;
    if (bytes !== this.lastBytesSeen) {
      this.lastBytesSeen = bytes;
      this.lastBytesMovedAt = now;
    }
    if (stats?.prerollComplete && this.prerollCompleteAt === undefined) this.prerollCompleteAt = now;
    return bytes > 0 && now - this.lastBytesMovedAt < FLOW_FRESH_MS;
  }

  /**
   * Invalidate the current attempt and release every resource it owns.
   *
   * Guarded because it *causes media events*: `pause()` and `load()` make the
   * element fire, the observer re-ticks, and a tick taken halfway through a
   * teardown would publish a snapshot of an engine that owns nothing — `idle`,
   * i.e. STANDBY on the panel — in the middle of a tune. Nothing observed here
   * is about anything; the tick that follows the teardown is.
   */
  private teardownCurrent(): number {
    this.tearingDown = true;
    try {
      return this.releaseCurrent();
    } finally {
      this.tearingDown = false;
    }
  }

  private releaseCurrent(): number {
    this.generation += 1;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.resolveAbort?.abort();
    this.resolveAbort = undefined;
    this.resolving = false;
    this.starting = false;
    this.reconnecting = false;
    this.prerollMet = false;
    this.stalledSince = undefined;
    // The fault belonged to the attempt being released, and it is released with
    // it. Leaving it behind is how switching the receiver OFF came back as
    // FAULT: `stop()` publishes INITIAL_PLAYBACK_STATE, then the next 10 Hz tick
    // sees `failed: true` and derives 'error' again — one frame of STANDBY and
    // then a permanent fault, with `isPowered()` reading true the whole time, so
    // a dial drag in standby tuned stations on a receiver that was switched off.
    this.failure = undefined;
    this.rawFault = undefined;
    this.candidates = [];
    this.candidateIndex = 0;
    // The meter must fall the moment the session goes, not coast on the last
    // session's health until the next tick.
    this.linkHealth = 0;
    this.lastBytes = 0;
    this.lastBytesAt = 0;
    this.link.close();

    // removeAttribute + load() is what actually cancels the in-flight fetch;
    // setting src='' makes Chromium resolve the empty string against the page URL.
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load();
    this.observer.reset();
    return this.generation;
  }

  // --- AFC -----------------------------------------------------------------

  private onDrop(message: string, raw?: string): void {
    if (this.reconnecting || this.failure) return;
    const text = panelSentence('upstream-closed', message);
    if (!this.settings.afcEnabled) {
      this.fail('upstream-closed', `${text} (AFC off)`, raw);
      return;
    }
    // The budget is per mount, not per station. A PLS whose first entry is dead
    // and whose second is healthy used to burn all six attempts on the corpse
    // and then declare the station broken, with the working sibling sitting
    // untouched in the list the resolver already handed over.
    if (this.afc.exhausted && !this.advanceCandidate()) {
      this.fail('upstream-closed', `${text} — ${this.exhaustedText()}`, raw);
      return;
    }
    const stream = this.candidates[this.candidateIndex] ?? this.state.stream;
    if (!stream) {
      this.fail('upstream-closed', text, raw);
      return;
    }
    const delay = this.afc.nextDelayMs();
    this.reconnecting = true;
    this.stablePlayingMs = 0;
    // Byte counts survive a re-lock: it is still one listening session.
    this.bytesCarried += this.link.bytesReceived;
    const gen = this.generation;
    this.link.close();
    // Not cosmetic: the element keeps its MediaError until the next load(), and
    // a stale one makes every tick of the backoff look like a fresh fault.
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load();
    this.observer.reset();
    this.state = { ...this.state, stream };
    this.tick();
    this.reconnectTimer = setTimeout(() => {
      if (gen !== this.generation) return;
      // `reconnecting` stays up through the mint round trip: `connect()` takes
      // it down once a session is adopted, and `fail()` if the mint rejects.
      // Clearing it here left the engine owning nothing for the length of an
      // IPC call, which `derivePhase` reads as `idle` — STANDBY on the panel,
      // in the middle of a re-lock.
      void this.connect(gen, stream).catch((err) => {
        // The same guard `tune()` has on this call. Without it a mint that
        // rejects after the listener has tuned away writes an old attempt's
        // failure onto the new station's state.
        if (gen !== this.generation) return;
        this.fail('network', 'the connection to the station failed', (err as Error).message);
      });
    }, delay);
  }

  /**
   * Move to the next mount the resolver offered and hand it a fresh budget.
   * Returns false when the list is spent, which is the only thing that makes an
   * upstream drop terminal.
   */
  private advanceCandidate(): boolean {
    if (this.candidateIndex + 1 >= this.candidates.length) return false;
    this.candidateIndex += 1;
    this.afc.reset();
    return true;
  }

  /** What the panel says once every mount has been tried. */
  private exhaustedText(): string {
    const mounts = this.candidates.length;
    return mounts > 1
      ? `all ${mounts} mounts failed, ${this.afc.budget} attempts each`
      : `AFC gave up after ${this.afc.attempts} attempts`;
  }

  /**
   * Terminal failure. `raw` is whatever the browser or the socket actually said
   * — kept for `diagnostics()` and deliberately never shown, because Chromium's
   * `MediaError.message` names a demuxer for what is nearly always a server that
   * went away.
   */
  private fail(kind: PlaybackError['kind'], message: string, raw?: string): void {
    this.failure = { kind, message: panelSentence(kind, message), attempts: this.afc.attempts };
    this.rawFault = raw ?? message;
    this.reconnecting = false;
    // Terminal means terminal: nothing is under way any more, so no flag may
    // still claim otherwise. `derivePhase` reads `failed` first and would mask
    // them, which is exactly why they used to be left set.
    this.resolving = false;
    this.starting = false;
    clearTimeout(this.reconnectTimer);
    // Those bytes really did arrive; closing the link must not erase the count.
    this.bytesCarried += this.link.bytesReceived;
    this.link.close();
    this.el.pause();
    this.tick();
  }

  // --- the tick: everything below is derived, nothing is asserted ----------

  /**
   * THE TICKER RUNS WHILE THERE IS SOMETHING TO OBSERVE, AND NOT OTHERWISE.
   *
   * It used to be started in the constructor and stopped only in `dispose()`,
   * which means a receiver sitting in standby woke up ten times a second — a
   * little over 36,000 times an hour — to sample a media element with no source
   * on it, ask a proxy link with no session for its stats, derive `idle` from
   * the same evidence as last time, and publish a state identical to the one
   * before it. Measured at 4.7% of a core with the gpu process at 0%: entirely
   * real work, none of it about anything.
   *
   * `idle` is the standby case and `error` is the terminal one — a station that
   * has given up, with a sentence on the panel and nothing in flight. In both,
   * every remaining route back to life is an *event*: `tune()` and `stop()`
   * call this directly, the media element's own events tick the engine through
   * the observer, and the proxy's metadata/drop/stats pushes arrive over IPC.
   * None of them needs a poll to be noticed, so between them nothing is watched
   * and nothing is missed.
   *
   * Everything else — resolving, connecting, buffering, playing, stalled,
   * reconnecting — keeps the full 10 Hz, because those are precisely the states
   * where the panel's reading changes on its own and where stall detection has
   * a stream to watch. This changes when the engine looks, never what it sees.
   */
  private syncTicker(phase: PlaybackState['phase']): void {
    const settled =
      (phase === 'idle' || phase === 'error') &&
      this.reconnectTimer === undefined &&
      !this.resolving &&
      !this.starting &&
      !this.reconnecting;
    if (!settled) {
      this.startTicker();
      return;
    }
    this.stopTicker();
    // Nothing is on the air and nothing is on its way, so nothing needs an
    // audio thread. The graph and every setting on it survive; see stage.idle().
    void this.stage.idle();
  }

  private startTicker(): void {
    if (this.ticker !== undefined) return;
    this.lastTickAt = Date.now();
    this.ticker = setInterval(() => this.tick(), this.tickMs);
  }

  private stopTicker(): void {
    if (this.ticker === undefined) return;
    clearInterval(this.ticker);
    this.ticker = undefined;
  }

  private tick(): void {
    if (this.tearingDown) return;
    const now = Date.now();
    const dt = Math.min(1000, now - this.lastTickAt);
    this.lastTickAt = now;

    const o = this.observer.sample();
    const stats = this.link.stats;

    this.evaluatePreroll(now, o.bufferedAhead, o.preloadSuspended);
    this.updateLinkHealth(now, o.bufferedAhead, stats);

    const evidence: PhaseEvidence = {
      now,
      hasSession: this.link.sessionId !== undefined,
      resolving: this.resolving,
      starting: this.starting,
      reconnecting: this.reconnecting,
      failed: this.failure !== undefined,
      bytesReceived: stats?.bytesReceived ?? 0,
      proxyStalled: stats?.stalled === true,
      upstreamDropped: this.link.upstreamDropped && !this.reconnecting,
      readyState: o.readyState,
      paused: o.paused,
      lastAdvanceAt: o.lastAdvanceAt,
      playingEventAt: o.events['playing'],
      mediaError: o.error !== undefined,
    };
    const phase = derivePhase(evidence);
    const flowing = this.bytesFlowing(now, stats);

    if (phase === 'playing') {
      this.playingMs += dt;
      this.stablePlayingMs += dt;
      if (this.stablePlayingMs > AFC_STABLE_MS) this.afc.reset();
    } else {
      this.stablePlayingMs = 0;
    }

    // A media error is a *transition*, decided before anything is published: a
    // drop AFC is about to recover from must never flash FAULT on the panel.
    if (o.error && !this.failure && !this.reconnecting) {
      this.onMediaError(o.error);
      return;
    }

    this.stalledSince = phase === 'stalled' ? (this.stalledSince ?? now) : undefined;
    const level = this.readSignalLevel();
    const { reported, signalLoss } = this.qualify(phase, level, now, stats, flowing);

    this.state = {
      ...this.state,
      phase: reported,
      error: this.failure,
      signalLoss,
      retry: this.reconnecting ? this.retryProgress() : undefined,
      measuredBitrateKbps: stats?.measuredBitrateKbps,
      // The codec's own rate, never the delivery rate. The frame header is read
      // out of the audio bytes themselves and is preferred; `icy-br` is only a
      // claim, but it is a claim *about the codec*, which is the right kind of
      // number for this slot.
      codecBitrateKbps:
        stats?.info?.audioFormat?.frameBitrateKbps ?? sanitiseIcyBitrate(stats?.info?.icyBitrate),
      sampleRate: stats?.info?.audioFormat?.sampleRate,
      bufferedSeconds: o.bufferedAhead,
      playingSeconds: this.playingMs / 1000,
      bytesReceived: this.bytesCarried + (stats?.bytesReceived ?? 0),
      signalLevel: level,
    };
    this.emit();
    // Published first: whatever this tick found is on the panel before the
    // ticker is allowed to stop on the strength of it.
    this.syncTicker(reported);

    // Published first, acted on second. SIGNAL LOST is a designed state and has
    // to be renderable at a human sampling rate before AFC takes the deck away
    // into RE-LOCKING (Law 4).
    if (
      phase === 'stalled' &&
      stats?.stalled === true &&
      !this.reconnecting &&
      !this.failure &&
      now - (this.stalledSince ?? now) >= STALL_HOLD_MS
    ) {
      this.onDrop('the station stopped sending');
      return;
    }

    // The decoder has had bytes and produced nothing with them. Mid-stream that
    // is a drop for AFC to re-lock; from the first byte it is a stream this
    // receiver cannot decode, and the seventh try would not change that.
    if (
      (phase === 'buffering' || phase === 'stalled') &&
      flowing &&
      stats?.prerollComplete === true &&
      !this.reconnecting &&
      !this.failure
    ) {
      const watchedFrom = Math.max(o.lastAdvanceAt ?? 0, this.prerollCompleteAt ?? now);
      if (now - watchedFrom >= DECODER_DEAD_MS) {
        if (o.events['playing'] !== undefined) {
          this.onDrop('the stream stopped decoding');
        } else {
          this.fail('decode', 'nothing in the stream could be decoded', 'decoder produced no audio while bytes arrived');
        }
      }
    }
  }

  /**
   * The last word on the reported phase, and the only place `playing` is ever
   * withheld.
   *
   * Law 2 forbids a label that says Playing while the decoder is not producing
   * audio, and the engine's own meter is the measurement of exactly that. So a
   * reading pinned to the zero stop cannot be reported as a lock — with the
   * cause named, because "you are off-station", "the programme has gone silent"
   * and "the bytes stopped" are three different things a listener acts on
   * differently.
   */
  private qualify(
    phase: PlaybackState['phase'],
    level: number,
    now: number,
    stats: ProxySessionStats | undefined,
    flowing: boolean,
  ): { reported: PlaybackState['phase']; signalLoss: SignalLoss | undefined } {
    if (phase !== 'playing') {
      this.lastSignalAt = now;
      // A stall with bytes still arriving is not "flow stopped": the flow is
      // the one thing that has not stopped. It is the decoder that has.
      const loss: SignalLoss | undefined =
        phase === 'stalled' ? (flowing && stats?.stalled !== true ? 'undecodable' : 'flow-stopped') : undefined;
      return { reported: phase, signalLoss: loss };
    }
    if (level > 0) {
      this.lastSignalAt = now;
      return { reported: phase, signalLoss: undefined };
    }
    if (now - this.lastSignalAt < SILENT_LOCK_MS) {
      // Inside a plausible gap between items. Still a lock, still no signal —
      // the needle has already fallen, which is the honest part of the report.
      return { reported: phase, signalLoss: undefined };
    }
    // `stationGain` is this engine's own attenuator, read back rather than
    // assumed: closed means the dial is nowhere near a station.
    const detuned = this.stage.stationGain < FRONT_END_CLOSED;
    return {
      reported: 'stalled',
      signalLoss: detuned ? 'detuned' : stats?.stalled === true ? 'flow-stopped' : 'dead-air',
    };
  }

  private retryProgress(): RetryProgress {
    return {
      attempt: Math.max(1, this.afc.attempts),
      budget: this.afc.budget,
      mount: this.candidateIndex + 1,
      mounts: Math.max(1, this.candidates.length),
    };
  }

  /**
   * Chromium reported a MediaError. With AFC armed this is a drop, not a dead
   * end; either way the panel gets a sentence and `diagnostics()` gets the
   * browser's own text.
   */
  private onMediaError(error: { code: number; message: string }): void {
    // The proxy having already reported the upstream gone is far better evidence
    // than the demuxer's guess: the format was fine, the server went away.
    const dropped = this.link.upstreamDropped;
    const kind: PlaybackError['kind'] = dropped ? 'upstream-closed' : mediaErrorKind(error.code);
    const text = dropped ? 'upstream ended the stream' : mediaErrorText(error.code);
    // A source the browser has no decoder for will not become decodable on the
    // seventh try, so AFC does not get to spend a budget on it. Everything else
    // — a dropped socket, a torn frame — is exactly what AFC exists for.
    const retryable = dropped || error.code === 2 || error.code === 3;
    if (retryable && this.settings.afcEnabled && this.state.stream) {
      this.onDrop(text, error.message);
      return;
    }
    this.fail(kind, text, error.message);
  }

  /**
   * The other half of the meter reading. Every input is observed: session state
   * and byte flow from the proxy, buffer depth from HTMLMediaElement.buffered.
   *
   * The byte clock is kept here rather than in the proxy because what matters
   * is when the *renderer* last saw the counter move — that is the same
   * evidence the phase derivation uses, and it goes stale for exactly the same
   * reasons.
   */
  private updateLinkHealth(
    now: number,
    bufferedAhead: number,
    stats: ProxySessionStats | undefined,
  ): void {
    if (!stats) {
      this.linkHealth = 0;
      this.lastBytes = 0;
      this.lastBytesAt = 0;
      return;
    }
    const bytes = stats.bytesReceived;
    if (bytes > this.lastBytes || this.lastBytesAt === 0) {
      this.lastBytes = bytes;
      this.lastBytesAt = now;
    }
    this.linkHealth = linkHealth({
      connected: stats.connected,
      stalled: stats.stalled,
      bufferedSeconds: bufferedAhead,
      pipelineSeconds: stats.pipelineSeconds,
      sinceBytesMs: now - this.lastBytesAt,
    });
  }

  /**
   * The last gate before audio is allowed out. The requested NARROW/WIDE depth
   * has already been accumulated by the proxy, so all that remains is to confirm
   * the browser itself agrees it can play on. The deadline is not cosmetic: a
   * mount slower than real time must not leave the deck buffering forever.
   */
  private evaluatePreroll(now: number, bufferedAhead: number, suspended: boolean): void {
    if (this.prerollMet || !this.link.sessionId || this.reconnecting) return;
    if (!this.link.stats?.prerollComplete) return;
    const ready = this.el.readyState >= 3; // HAVE_FUTURE_DATA
    const settled = bufferedAhead >= 1 || suspended;
    const expired = now - this.prerollStartedAt > prerollDeadlineMs(this.settings.bufferDepth);

    if (!(ready && settled) && !expired) return;
    this.prerollMet = true;
    const gen = this.generation;
    void this.el.play().catch((err) => {
      // Generation-guarded like every other post-await branch in this class, and
      // for the identical reason `resolving` is. A `play()` issued at
      // readyState < 3 stays pending; `teardownCurrent()` and `onDrop()` then
      // cancel it with pause() + removeAttribute('src') + load(), which is what
      // *makes* it reject. Unguarded, the engine's own abort of an abandoned
      // attempt landed a fault on the attempt that replaced it — a healthy
      // station reading FAULT the instant you tuned to it.
      if (gen !== this.generation) return;
      // Autoplay policy or a genuinely broken source: either way, observed —
      // but the two are different states with different remedies, and neither
      // of them is the browser's exception text.
      const e = err as Error;
      if (e.name === 'NotAllowedError') {
        this.fail('aborted', 'the browser held playback until the panel is touched', e.message);
        return;
      }
      // The only things that abort a play() are this engine's own load()/pause(),
      // so an abort is never evidence about the stream. With the generation
      // unchanged it is AFC re-locking, which owns the recovery — and failing
      // here would kill it outright, because `onDrop` returns early on a
      // failure that is already set.
      if (e.name === 'AbortError') return;
      this.fail('decode', 'the browser refused to start this stream', e.message);
    });
  }

  private emit(): void {
    for (const cb of this.subscribers) cb(this.state);
    this.bridge.reportPlaybackState(this.state);
  }
}

/**
 * `icy-br` is free-form text a station operator typed once. Values in bits per
 * second, zeroes and blanks all occur. Nothing outside the range a real audio
 * codec occupies is worth printing, and printing nothing is the designed state.
 */
function sanitiseIcyBitrate(kbps: number | undefined): number | undefined {
  if (kbps === undefined || !Number.isFinite(kbps)) return undefined;
  if (kbps <= 0 || kbps > 1024) return undefined;
  return kbps;
}

/** A resolve hook may answer with one mount or with the whole preference list. */
function streamList(value: PlayableStream | PlayableStream[] | undefined): PlayableStream[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).filter((s) => typeof s?.url === 'string' && s.url !== '');
}

/**
 * The last gate before a fault reaches a listener.
 *
 * Every call site above already composes a sentence, so in practice this only
 * ever fires on a message that came from outside the engine — a rejected
 * promise, a resolver hook throwing something raw. It is kept because the
 * invariant is worth more than the branch: nothing carrying the browser's
 * internals reaches `PlaybackError.message`, ever, on any path.
 */
export function panelSentence(kind: PlaybackError['kind'], message: string | undefined): string {
  const clean = (message ?? '').replace(/\s+/g, ' ').trim();
  if (clean === '' || ENGINE_JARGON.test(clean)) return FAULT_FALLBACK[kind];
  return clean;
}

/** What a `MediaError` code means, in words a listener can act on. */
function mediaErrorText(code: number): string {
  switch (code) {
    case 1:
      return 'playback was stopped before it started';
    case 2:
      return 'the connection to the station dropped';
    case 3:
      return 'the audio arriving from the station could not be decoded';
    case 4:
      return 'this stream is in a form this receiver cannot decode';
    default:
      return 'the station stopped sending';
  }
}

/** Which designed failure a `MediaError` code belongs to. */
function mediaErrorKind(code: number): PlaybackError['kind'] {
  switch (code) {
    case 1:
      return 'aborted';
    case 2:
      return 'network';
    default:
      return 'decode';
  }
}
