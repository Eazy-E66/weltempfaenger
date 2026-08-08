/**
 * Everything we know about the media element, observed rather than assumed.
 *
 * This module never decides anything — it only records what actually happened
 * (which events fired and when, whether currentTime really moved) so the phase
 * machine has facts to derive from.
 */

export interface MediaObservation {
  readyState: number;
  networkState: number;
  paused: boolean;
  ended: boolean;
  currentTime: number;
  /** Seconds buffered ahead of the playhead, from HTMLMediaElement.buffered. */
  bufferedAhead: number;
  /** Timestamp of the last tick where currentTime was strictly greater. */
  lastAdvanceAt?: number;
  /** Wall clock at which the element first genuinely advanced. */
  firstAdvanceAt?: number;
  lastEvent?: { type: string; at: number };
  events: Record<string, number>;
  /** Populated from the element's own MediaError. */
  error?: { code: number; message: string };
  /** True after a `suspend` while paused — the browser has stopped pre-buffering. */
  preloadSuspended: boolean;
}

const WATCHED = [
  'loadstart',
  'loadedmetadata',
  'loadeddata',
  'canplay',
  'canplaythrough',
  'playing',
  'play',
  'pause',
  'waiting',
  'stalled',
  'suspend',
  'progress',
  'emptied',
  'ended',
  'error',
  'abort',
] as const;

export type MediaEventName = (typeof WATCHED)[number];

export class MediaObserver {
  private readonly listeners = new Map<string, EventListener>();
  private lastTime = 0;
  private obs: MediaObservation = blank();
  private readonly subscribers = new Set<(name: string) => void>();

  constructor(
    private readonly el: HTMLAudioElement,
    private readonly now: () => number = () => Date.now(),
  ) {
    for (const name of WATCHED) {
      const listener = (): void => this.onEvent(name);
      this.listeners.set(name, listener);
      el.addEventListener(name, listener);
    }
  }

  /** Fired for every media event, so the engine can react without polling. */
  onAny(cb: (name: string) => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  /** Clears per-load history. Call immediately before assigning a new src. */
  reset(): void {
    this.obs = blank();
    this.lastTime = 0;
  }

  /** Samples the element. Called at the engine tick rate. */
  sample(): MediaObservation {
    const el = this.el;
    const t = el.currentTime;
    if (t > this.lastTime + 1e-4) {
      this.obs.lastAdvanceAt = this.now();
      this.obs.firstAdvanceAt ??= this.obs.lastAdvanceAt;
    }
    this.lastTime = t;

    this.obs.readyState = el.readyState;
    this.obs.networkState = el.networkState;
    this.obs.paused = el.paused;
    this.obs.ended = el.ended;
    this.obs.currentTime = t;
    this.obs.bufferedAhead = bufferedAhead(el);
    this.obs.error = el.error
      ? { code: el.error.code, message: el.error.message || mediaErrorText(el.error.code) }
      : undefined;
    return this.obs;
  }

  get observation(): MediaObservation {
    return this.obs;
  }

  private onEvent(name: MediaEventName): void {
    const at = this.now();
    this.obs.events[name] = at;
    this.obs.lastEvent = { type: name, at };
    if (name === 'suspend' && this.el.paused) this.obs.preloadSuspended = true;
    if (name === 'playing' || name === 'progress') this.obs.preloadSuspended = false;
    for (const cb of this.subscribers) cb(name);
  }

  dispose(): void {
    for (const [name, listener] of this.listeners) this.el.removeEventListener(name, listener);
    this.listeners.clear();
    this.subscribers.clear();
  }
}

/** Seconds of contiguous buffered audio ahead of the playhead. */
export function bufferedAhead(el: HTMLAudioElement): number {
  const ranges = el.buffered;
  const t = el.currentTime;
  for (let i = 0; i < ranges.length; i++) {
    // A tiny tolerance: the playhead sits fractionally past a range start.
    if (t >= ranges.start(i) - 0.25 && t <= ranges.end(i)) return Math.max(0, ranges.end(i) - t);
  }
  // Paused at 0 before the first range starts — report the leading range's span.
  return ranges.length > 0 ? Math.max(0, ranges.end(0) - Math.max(t, ranges.start(0))) : 0;
}

function blank(): MediaObservation {
  return {
    readyState: 0,
    networkState: 0,
    paused: true,
    ended: false,
    currentTime: 0,
    bufferedAhead: 0,
    events: {},
    preloadSuspended: false,
  };
}

function mediaErrorText(code: number): string {
  switch (code) {
    case 1:
      return 'playback aborted';
    case 2:
      return 'network error while fetching audio';
    case 3:
      return 'audio decode error';
    case 4:
      return 'source not supported';
    default:
      return `media error ${code}`;
  }
}
