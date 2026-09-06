/**
 * The typed IPC surface.
 *
 * Deliberately free of any `electron` import: the preload script, the main
 * process and the renderer all consume this module, so it must carry channel
 * names and payload shapes and nothing else.
 */

import type {
  LogEntry,
  PlaybackState,
  RegisterIndex,
  Preset,
  ResolveResult,
  Settings,
  StationQuery,
  StationRef,
} from '../shared/contracts.js';
import type { DirectoryErrorKind } from './directory/http.js';
import type {
  ProxyEvent,
  ProxyHandle,
  ProxyMetadata,
  ProxySessionOptions,
  ProxySessionStats,
} from './proxy/types.js';

export const IPC = {
  /** renderer -> main, invoke */
  proxyStart: 'psppcpr:proxy:start',
  proxyStop: 'psppcpr:proxy:stop',
  proxyStopAll: 'psppcpr:proxy:stop-all',
  settingsLoad: 'psppcpr:settings:load',
  settingsSave: 'psppcpr:settings:save',
  memoryLoad: 'psppcpr:memory:load',
  memorySave: 'psppcpr:memory:save',
  directoryIndex: 'psppcpr:directory:index',
  directorySearch: 'psppcpr:directory:search',
  directoryReport: 'psppcpr:directory:report',
  resolverResolve: 'psppcpr:resolver:resolve',
  appInfo: 'psppcpr:app:info',
  /** renderer -> main, fire and forget */
  reportState: 'psppcpr:state:report',
  /** main -> renderer, push */
  proxyStats: 'psppcpr:proxy:stats',
  proxyMetadata: 'psppcpr:proxy:metadata',
  proxyEvent: 'psppcpr:proxy:event',
  windowAttention: 'psppcpr:window:attention',
} as const;

// ---------------------------------------------------------------------------
// Attention: whether anybody can actually see the window
// ---------------------------------------------------------------------------

/**
 * Why the panel is, or is not, in front of a pair of eyes.
 *
 * The renderer cannot work this out for itself. `document.visibilityState` is
 * the obvious answer and it is a lie here: with `backgroundThrottling: false`
 * Electron holds the WebContents "shown" so its timers keep running, and the
 * page therefore reads `visible` with the window minimised, occluded, or
 * unmapped off the screen entirely. Measured on this build: window unmapped
 * from the X server, `document.visibilityState === 'visible'`, needle still
 * turning at frame rate, 63.5% of a core.
 *
 * So the fact is established where it is knowable — in the browser process,
 * from the window's own state and from the OS power/session signals — and
 * pushed down.
 */
export type AttentionReason =
  /** The window is mapped and not minimised, and the session is awake. */
  | 'shown'
  | 'minimised'
  /** Hidden by the app or unmapped by the window manager. */
  | 'hidden'
  /** The machine suspended — a shut laptop lid, most of the time. */
  | 'suspended'
  | 'screen-locked';

export interface WindowAttention {
  /** True when a human could see the panel. False parks every drawing loop. */
  attended: boolean;
  reason: AttentionReason;
  at: number;
}

// ---------------------------------------------------------------------------
// Directory results
//
// A `DirectoryError` thrown in the main process cannot survive the
// contextBridge: structured clone reduces an Error to its message, and the
// `kind` — the only part the UI can act on — is exactly what would be lost.
// So the boundary is explicitly result-typed. "The directory is unreachable"
// and "the directory answered, with nothing" are different states with
// different appearances (Law 4), and this is what keeps them different.
// ---------------------------------------------------------------------------

export interface DirectoryFailure {
  kind: DirectoryErrorKind;
  message: string;
  /** Present for `kind: 'http'`. */
  status?: number;
}

export type DirectoryResult<T> =
  | {
      ok: true;
      value: T;
      /**
       * The answer is real but incomplete, and the panel must say so (Law 4).
       *
       * The only producer today is a folded genre whose expansion partly
       * failed: `trip-hop` is three `tag=` queries, and two of three answering
       * means the band is short by an unknown amount. Silently returning the
       * short list would read as "the directory has this many".
       */
      warning?: string;
    }
  | { ok: false; failure: DirectoryFailure };

/**
 * Station memory: the parts of the receiver's state that are `StationRef`s
 * rather than scalars, so they cannot live in `Settings`.
 *
 * A preset must recall a station from a genre that is not currently tuned, and
 * the last station must come back on a launch with no network — neither is
 * possible from an id alone, so the whole ref is kept.
 */
export interface StationMemory {
  presets: Preset[];
  lastStation?: StationRef;
  /**
   * The operator's log: stations audio was actually observed from, newest
   * first. Persisted for the same reason `lastStation` is — a receiver you
   * switch on tomorrow should still know what you were listening to today —
   * and, unlike `lastStation`, it is surfaced on the panel.
   */
  log?: LogEntry[];
}

export const EMPTY_STATION_MEMORY: StationMemory = { presets: [] };

export interface AppInfo {
  version: string;
  platform: string;
  /** Loopback port the stream proxy listens on. */
  proxyPort: number;
  /** True when PSPPCPR_TEST_HOOKS=1 — the screenshot/state channel is live. */
  testHooks: boolean;
  userDataPath: string;
}

export type Unsubscribe = () => void;

/** Exactly what `window.psppcpr` offers. Nothing else crosses the bridge. */
export interface PsppcprBridge {
  readonly api: 1;

  proxy: {
    /**
     * Mint a proxy session for an upstream URL. Nothing connects until the
     * <audio> element loads the returned URL.
     */
    start(upstreamUrl: string, opts?: ProxySessionOptions): Promise<ProxyHandle>;
    /** Destroy a session and its upstream socket now. */
    stop(sessionId: string): Promise<void>;
    stopAll(): Promise<void>;
    onStats(cb: (stats: ProxySessionStats) => void): Unsubscribe;
    onMetadata(cb: (meta: ProxyMetadata) => void): Unsubscribe;
    onEvent(cb: (event: ProxyEvent) => void): Unsubscribe;
  };

  settings: {
    load(): Promise<Settings>;
    save(settings: Settings): Promise<void>;
  };

  memory: {
    load(): Promise<StationMemory>;
    save(memory: StationMemory): Promise<void>;
  };

  /**
   * Discovery. Lives in the main process because it needs raw HTTP and a
   * user-agent the renderer's fetch cannot set; it never touches audio.
   */
  directory: {
    /** Real tags with real counts. The band selector is built from this alone. */
    /** The register's whole printed index: subjects, origins, tongues, totals. */
    listIndex(): Promise<DirectoryResult<RegisterIndex>>;
    search(query: StationQuery): Promise<DirectoryResult<StationRef[]>>;
    /** Courtesy popularity ping. Fire and forget; never fails into the caller. */
    reportListening(stationId: string): Promise<void>;
  };

  /**
   * Resolution. `ResolveResult` is already total — the resolver never throws —
   * so this crosses the bridge exactly as it is.
   */
  resolver: {
    resolve(url: string): Promise<ResolveResult>;
  };

  app: {
    info(): Promise<AppInfo>;
    /**
     * Whether anybody can see the window. Pushed on every change, and once on
     * subscribe so a late subscriber is never left guessing.
     */
    onAttention(cb: (attention: WindowAttention) => void): Unsubscribe;
    /**
     * What the previous run was doing when it stopped. A receiver that was
     * taken off the air by a crash, a GPU reset or a suspend should come back
     * on the air; one that was switched off should come back in standby.
     */
  };

  /**
   * The engine mirrors its state here every tick so the test-hook channel can
   * dump the real PlaybackState. Cheap no-op when test hooks are off.
   */
  reportPlaybackState(state: PlaybackState): void;
}

declare global {
  interface Window {
    psppcpr?: PsppcprBridge;
  }
}
