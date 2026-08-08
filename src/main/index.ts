/**
 * Electron main process: window, lifecycle, the stream proxy, settings on disk,
 * and (behind PSPPCPR_TEST_HOOKS=1) the screenshot/state evidence channel.
 */

import { app, BrowserWindow, ipcMain, powerMonitor, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {
  IPC,
  EMPTY_STATION_MEMORY,
  type AppInfo,
  type AttentionReason,
  type DirectoryResult,
  type ResumeIntent,
  type StationMemory,
  type WindowAttention,
} from './ipc.js';
import {
  DEFAULT_SETTINGS,
  EMPTY_SCOPE,
  INITIAL_PLAYBACK_STATE,
  LOG_CAPACITY,
  type GenreTag,
  type LogEntry,
  type RegisterIndex,
  type RegisterScope,
  type PlaybackState,
  type Preset,
  type ResolveResult,
  type Settings,
  type StationQuery,
  type StationRef,
} from '../shared/contracts.js';
import { ProxyServer } from './proxy/server.js';
import type { ProxySessionOptions } from './proxy/types.js';
import { installTestHooks } from './proxy/test-routes.js';
import { DirectoryError } from './directory/http.js';
import { RadioBrowserProvider, clampLimit, type PartialExpansion } from './directory/radioBrowser.js';
import { HttpStreamResolver } from './resolver/streamResolver.js';
import { networkCauseOf } from './resolver/rawHttp.js';

// Resolved from the app root rather than __dirname/import.meta so this file is
// agnostic to whether the build emits CommonJS or ESM, and works inside an asar.
const APP_ROOT = app.getAppPath();
const PRELOAD = path.join(APP_ROOT, 'dist', 'main', 'preload.js');
const RENDERER_INDEX = path.join(APP_ROOT, 'dist', 'renderer', 'index.html');
const TEST_HOOKS = process.env.PSPPCPR_TEST_HOOKS === '1';

/** Warm cabinet grey, so the window never flashes white before the UI paints. */
const CHASSIS_BG = '#14120f';

const proxy = new ProxyServer();

/**
 * The live directory. Radio Browser only: `FixtureProvider` exists for tests
 * and must not be reachable from the shipping UI, because a fixture that looked
 * like a real tune-in would break Law 2's corollary.
 */
const directory = new RadioBrowserProvider({
  userAgent: `Weltempfaenger/${app.getVersion()}`,
});
const resolver = new HttpStreamResolver();

let mainWindow: BrowserWindow | null = null;
let lastPlaybackState: PlaybackState = INITIAL_PLAYBACK_STATE;

// ---------------------------------------------------------------------------
// Command line, before anything else reads it
// ---------------------------------------------------------------------------

/**
 * LOSING THE GPU PROCESS MUST NOT KILL THE RECEIVER.
 *
 * Chromium keeps a crash counter for the GPU process and, when it runs out of
 * fallbacks, gives up on the whole browser: `GPU process isn't usable.
 * Goodbye.` and the app is gone. That is a reasonable policy for a browser
 * whose tabs can be reopened; it is not one for something that is supposed to
 * sit in the corner playing a radio station all day, on a laptop where a driver
 * reset, a suspend/resume cycle and an undock are all ordinary events.
 *
 * `--disable-gpu-process-crash-limit` removes the give-up: the GPU process is
 * restarted (and if it cannot be, Chromium falls back to software) and the
 * audio path, which never went anywhere near the GPU, carries on.
 */
app.commandLine.appendSwitch('disable-gpu-process-crash-limit');

/**
 * Autoplay policy: this application IS an audio player.
 *
 * The gesture requirement exists to stop web pages making noise at strangers.
 * Here it stops exactly one thing that ought to work: putting the station back
 * on the air after the app was killed while playing (see `resumeIntent`). With
 * the gate in place the resumed tune would open the socket, fill the buffer and
 * feed a suspended AudioContext — a receiver reading PLAYING with silence
 * coming out of it, which is the one thing Law 2 forbids outright. Nothing here
 * plays without either a hand or a crash to recover from.
 */
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// ---------------------------------------------------------------------------
// Settings: a single JSON file in userData. Unknown keys are dropped and
// missing ones defaulted, so a half-written or older file cannot break startup.
// ---------------------------------------------------------------------------

const settingsPath = (): string => path.join(app.getPath('userData'), 'settings.json');

function loadSettings(): Settings {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as Partial<Settings>;
    return coerceSettings(raw);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function coerceSettings(raw: Partial<Settings>): Settings {
  const num = (v: unknown, lo: number, hi: number, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
  return {
    volume: num(raw.volume, 0, 1, DEFAULT_SETTINGS.volume),
    bassDb: num(raw.bassDb, -12, 12, DEFAULT_SETTINGS.bassDb),
    trebleDb: num(raw.trebleDb, -12, 12, DEFAULT_SETTINGS.trebleDb),
    noiseFloor: num(raw.noiseFloor, 0, 1, DEFAULT_SETTINGS.noiseFloor),
    afcEnabled: typeof raw.afcEnabled === 'boolean' ? raw.afcEnabled : DEFAULT_SETTINGS.afcEnabled,
    bufferDepth: raw.bufferDepth === 'narrow' || raw.bufferDepth === 'wide' ? raw.bufferDepth : DEFAULT_SETTINGS.bufferDepth,
    dialLampOn: typeof raw.dialLampOn === 'boolean' ? raw.dialLampOn : DEFAULT_SETTINGS.dialLampOn,
    lastStationId: typeof raw.lastStationId === 'string' ? raw.lastStationId : undefined,
    scope: coerceScope(raw.scope),
    // The visible half of the register's throw. Persisting `scope` without this
    // restored the cards and dropped the band: relaunching put `NO BAND CUT`
    // back on the faceplate with a locked flywheel, having faithfully remembered
    // the part of the state nobody can see.
    cutStanding: raw.cutStanding === true,
    cutBandIndex: Math.floor(num(raw.cutBandIndex, 0, 11, DEFAULT_SETTINGS.cutBandIndex)),
  };
}

/**
 * The scope the register last cut, restored across a restart.
 *
 * Every field is re-derived defensively: a scope file written by a build with a
 * different vocabulary must degrade to a wider scope, never to a crash or to a
 * silently different one.
 */
function coerceScope(raw: unknown): RegisterScope {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_SCOPE };
  const s = raw as Partial<RegisterScope>;
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()) : [];
  const scope: RegisterScope = {
    terms: strings(s.terms),
    tongues: strings(s.tongues),
    minKbps: typeof s.minKbps === 'number' && s.minKbps > 0 ? Math.floor(s.minKbps) : 0,
    codec: typeof s.codec === 'string' && s.codec ? s.codec.toUpperCase() : 'ANY',
    verifiedOnly: typeof s.verifiedOnly === 'boolean' ? s.verifiedOnly : EMPTY_SCOPE.verifiedOnly,
    hideHls: typeof s.hideHls === 'boolean' ? s.hideHls : EMPTY_SCOPE.hideHls,
  };
  if (typeof s.origin === 'string' && s.origin.trim()) scope.origin = s.origin.trim().toUpperCase();
  if (typeof s.text === 'string' && s.text.trim()) scope.text = s.text.trim();
  return scope;
}

function saveSettings(settings: Settings): void {
  writeJsonAtomic(settingsPath(), coerceSettings(settings));
}

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file); // atomic: a crash mid-write must not truncate the file
}

// ---------------------------------------------------------------------------
// Station memory: presets and the last station, as whole `StationRef`s.
//
// Kept out of settings.json deliberately. `Settings` is a flat bag of scalars
// with a strict coercion pass; stations are structured, come from outside, and
// have their own validity rules.
// ---------------------------------------------------------------------------

const memoryPath = (): string => path.join(app.getPath('userData'), 'memory.json');

function loadMemory(): StationMemory {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(memoryPath(), 'utf8'));
    return coerceMemory(raw);
  } catch {
    return { ...EMPTY_STATION_MEMORY, presets: [] };
  }
}

function saveMemory(memory: StationMemory): void {
  writeJsonAtomic(memoryPath(), coerceMemory(memory));
}

/**
 * A station is only worth keeping if it can still be tuned, which means it must
 * at minimum have an id, a name and a candidate URL. Anything else is dropped
 * rather than half-restored into a panel that then cannot act on it.
 */
function coerceStation(raw: unknown): StationRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Partial<StationRef>;
  if (typeof s.id !== 'string' || !s.id) return null;
  if (typeof s.name !== 'string' || !s.name) return null;
  if (typeof s.url !== 'string' || !s.url) return null;

  const station: StationRef = {
    id: s.id,
    name: s.name,
    url: s.url,
    tags: Array.isArray(s.tags) ? s.tags.filter((t): t is string => typeof t === 'string') : [],
    popularity: typeof s.popularity === 'number' && Number.isFinite(s.popularity) ? s.popularity : 0,
  };
  if (typeof s.homepage === 'string') station.homepage = s.homepage;
  if (typeof s.faviconUrl === 'string') station.faviconUrl = s.faviconUrl;
  if (typeof s.countryCode === 'string') station.countryCode = s.countryCode;
  if (typeof s.country === 'string') station.country = s.country;
  if (typeof s.language === 'string') station.language = s.language;
  if (typeof s.claimedBitrate === 'number') station.claimedBitrate = s.claimedBitrate;
  if (typeof s.claimedCodec === 'string') station.claimedCodec = s.claimedCodec;
  if (
    s.geo &&
    typeof s.geo.lat === 'number' &&
    typeof s.geo.lon === 'number' &&
    Number.isFinite(s.geo.lat) &&
    Number.isFinite(s.geo.lon)
  ) {
    station.geo = { lat: s.geo.lat, lon: s.geo.lon };
  }
  return station;
}

const PRESET_SLOTS: ReadonlyArray<Preset['slot']> = ['C', 'B', 'P'];

function coerceMemory(raw: unknown): StationMemory {
  const source = (raw ?? {}) as Partial<StationMemory>;
  const presets: Preset[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(source.presets) ? source.presets : []) {
    const slot = (entry as Partial<Preset> | undefined)?.slot;
    if (!slot || !PRESET_SLOTS.includes(slot) || seen.has(slot)) continue;
    const station = coerceStation((entry as Partial<Preset>).station);
    if (!station) continue;
    seen.add(slot);
    const savedAt = (entry as Partial<Preset>).savedAt;
    presets.push({
      slot,
      station,
      savedAt: typeof savedAt === 'number' && Number.isFinite(savedAt) ? savedAt : Date.now(),
    });
  }
  const memory: StationMemory = { presets };
  const last = coerceStation(source.lastStation);
  if (last) memory.lastStation = last;

  // The log. Same rule as everything else here: a line whose station cannot be
  // tuned any more is dropped rather than restored into a panel that would then
  // offer a dead button. Newest first, deduplicated by station, capped — the
  // file is written by this process and read by this process, but it is still a
  // file on disk that a human can edit.
  const log: LogEntry[] = [];
  const loggedIds = new Set<string>();
  for (const raw of Array.isArray(source.log) ? source.log : []) {
    const entry = (raw ?? {}) as Partial<LogEntry>;
    const station = coerceStation(entry.station);
    if (!station || loggedIds.has(station.id)) continue;
    loggedIds.add(station.id);
    log.push({
      station,
      heardAt:
        typeof entry.heardAt === 'number' && Number.isFinite(entry.heardAt) ? entry.heardAt : Date.now(),
    });
    if (log.length >= LOG_CAPACITY) break;
  }
  if (log.length) memory.log = log;
  return memory;
}

// ---------------------------------------------------------------------------
// Directory / resolver: turning thrown errors into data the UI can act on.
// ---------------------------------------------------------------------------

/**
 * Runs a directory call and reduces every outcome to a value or a typed
 * failure. Nothing here is allowed to reject: an exception across the
 * contextBridge arrives as a bare string, and the difference between "the
 * network is down" and "there are no results" is precisely what would be lost.
 */
async function directoryCall<T>(run: () => Promise<T>): Promise<DirectoryResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (err) {
    if (err instanceof DirectoryError) {
      return {
        ok: false,
        failure:
          err.status === undefined
            ? { kind: err.kind, message: err.message }
            : { kind: err.kind, message: err.message, status: err.status },
      };
    }
    return {
      ok: false,
      failure: { kind: 'network', message: err instanceof Error ? err.message : String(err) },
    };
  }
}

/** Clamp whatever the renderer asked for into something the directory accepts. */
function coerceQuery(raw: unknown): StationQuery {
  const q = (raw ?? {}) as Partial<StationQuery>;
  const text = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim() : undefined;
  const query: StationQuery = {
    limit: clampLimit(Math.floor(Number(q.limit)) || 50),
  };
  const genre = text(q.genre);
  if (genre) query.genre = genre;
  const countryCode = text(q.countryCode);
  if (countryCode) query.countryCode = countryCode;
  const language = text(q.language);
  if (language) query.language = language;
  const search = text(q.text);
  if (search) query.text = search;
  if (typeof q.offset === 'number' && q.offset > 0) query.offset = Math.floor(q.offset);
  return query;
}

// ---------------------------------------------------------------------------
// Attention: is anybody looking at the window?
//
// Everything the panel draws — a 60 fps moving-coil needle above all — is worth
// drawing only while a human could see it. The renderer cannot decide that for
// itself (see WindowAttention in ipc.ts: with backgroundThrottling off the page
// reads `visible` while unmapped), so the browser process decides it here and
// pushes the answer down. Nothing about the audio path consults this.
// ---------------------------------------------------------------------------

/** False while the machine is suspended or the session is locked. */
let sessionAwake = true;
let attention: WindowAttention = { attended: true, reason: 'shown', at: Date.now() };
/**
 * Slow poll of `win.isVisible()` while the receiver is on the air.
 *
 * Events cover everything the app and the window manager do politely —
 * minimise, hide, restore. They do not cover a plain X11 unmap, and on some
 * desktops they do not cover being fully occluded by another window either.
 * Two seconds is slow enough to be free (1800 wakeups an hour in a process that
 * is never throttled, against the 216,000 frames an hour this is here to stop)
 * and quick enough that nothing is drawn for long into an empty room. It only
 * runs while something is playing; in standby the drawing loops are parked
 * anyway and there is nothing to save.
 */
let attentionProbe: ReturnType<typeof setInterval> | undefined;

function publishAttention(attended: boolean, reason: AttentionReason): void {
  if (attention.attended === attended && attention.reason === reason) return;
  attention = { attended, reason, at: Date.now() };
  const win = mainWindow;
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send(IPC.windowAttention, attention);
  }
}

/** The window's own state, reduced to the one question the renderer asks. */
function evaluateAttention(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  if (!sessionAwake) return; // the power reason is the stronger one; keep it
  if (win.isMinimized()) {
    publishAttention(false, 'minimised');
    return;
  }
  publishAttention(win.isVisible(), win.isVisible() ? 'shown' : 'hidden');
}

function watchAttention(win: BrowserWindow): void {
  const reevaluate = (): void => evaluateAttention(win);
  win.on('show', reevaluate);
  win.on('restore', reevaluate);
  win.on('hide', reevaluate);
  win.on('minimize', reevaluate);
  // Suspend is what a shut laptop lid usually is, and a locked screen is the
  // other half of "nobody is looking" that no window event reports.
  const asleep = (reason: AttentionReason) => (): void => {
    sessionAwake = false;
    publishAttention(false, reason);
  };
  const awake = (): void => {
    sessionAwake = true;
    evaluateAttention(win);
  };
  powerMonitor.on('suspend', asleep('suspended'));
  powerMonitor.on('lock-screen', asleep('screen-locked'));
  powerMonitor.on('resume', awake);
  powerMonitor.on('unlock-screen', awake);
  evaluateAttention(win);
}

const ON_AIR: ReadonlySet<PlaybackState['phase']> = new Set([
  'resolving',
  'connecting',
  'buffering',
  'playing',
  'stalled',
  'reconnecting',
]);

/**
 * The receiver is doing something that has to keep working while nobody looks.
 * Drives both the attention probe and the throttling policy below.
 */
function isOnAir(state: PlaybackState): boolean {
  return ON_AIR.has(state.phase);
}

function setOnAir(win: BrowserWindow, onAir: boolean): void {
  if (onAir && !attentionProbe) {
    attentionProbe = setInterval(() => evaluateAttention(win), 2_000);
    attentionProbe.unref?.();
  } else if (!onAir && attentionProbe) {
    clearInterval(attentionProbe);
    attentionProbe = undefined;
  }

  /* BACKGROUND THROTTLING, DECIDED PER STATE RATHER THAN ONCE AT BUILD TIME.
   *
   * `backgroundThrottling: false` was set because a throttled renderer would
   * clamp the 10 Hz tick that watches for a stalled stream, and a receiver that
   * notices a dead station four seconds late is a receiver that lies for four
   * seconds. That reasoning holds — while something is on the air.
   *
   * In standby it holds nothing up: the engine's ticker is stopped (there is
   * nothing to watch), the frame loop is parked, and the only thing the setting
   * still does is deny the OS the one mechanism built for an application that
   * sits minimised all day. So it is now the state that decides. On the air:
   * never throttled, exactly as before. Off the air: throttled like any other
   * background page, and any of the events that put it back on the air —
   * an IPC message, a click, a restore — wakes it.
   */
  if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.setBackgroundThrottling(!onAir);
  }
}

// ---------------------------------------------------------------------------
// The session marker: what this run was doing when it stopped
//
// Written on every on-air/off-air transition and stamped clean on the way out.
// A run that ends without that stamp — a GPU process that took the browser with
// it, an OOM kill, a laptop that never came back from suspend — leaves a marker
// saying "this receiver was playing", and the next launch can put the station
// back on the air instead of coming up in standby as though nothing happened.
// ---------------------------------------------------------------------------

interface SessionMarker {
  onAir: boolean;
  stationId?: string;
  cleanExit: boolean;
  at: number;
}

const sessionPath = (): string => path.join(app.getPath('userData'), 'session.json');

/** Read once, at startup, before this run overwrites it. */
let previousSession: SessionMarker | null = null;

function readPreviousSession(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(sessionPath(), 'utf8')) as Partial<SessionMarker>;
    previousSession = {
      onAir: raw.onAir === true,
      cleanExit: raw.cleanExit === true,
      at: typeof raw.at === 'number' ? raw.at : 0,
    };
    if (typeof raw.stationId === 'string' && raw.stationId) {
      previousSession.stationId = raw.stationId;
    }
  } catch {
    previousSession = null;
  }
}

function writeSession(marker: SessionMarker): void {
  try {
    writeJsonAtomic(sessionPath(), marker);
  } catch {
    /* A receiver that cannot write a hint must still play a radio station. */
  }
}

function resumeIntent(): ResumeIntent {
  const prev = previousSession;
  if (!prev) return { resume: false, reason: 'no-record' };
  if (!prev.onAir) return { resume: false, reason: 'was-idle' };
  if (prev.cleanExit) return { resume: false, reason: 'clean-exit' };
  return prev.stationId
    ? { resume: true, stationId: prev.stationId, reason: 'unclean-exit' }
    : { resume: true, reason: 'unclean-exit' };
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 860,
    minHeight: 560,
    resizable: true,
    backgroundColor: CHASSIS_BG,
    show: false,
    autoHideMenuBar: true,
    title: 'Weltempfänger',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // The renderer only ever loads audio from our own loopback proxy.
      webSecurity: true,
      // Off the air this is turned back on: see setOnAir(). The safe value is
      // the one the window starts with, because the first state report is a
      // moment away and a throttled tab would stall the audio graph.
      backgroundThrottling: false,
    },
  });

  win.once('ready-to-show', () => {
    win.show();
    // Establish the off-air policy explicitly rather than waiting for the first
    // transition: a receiver that is launched and left in standby never has one,
    // and would keep the unthrottled window it was built with all day.
    setOnAir(win, isOnAir(lastPlaybackState));
  });
  watchAttention(win);
  /* THE RENDERER MUST NOT TAKE THE APP WITH IT.
   *
   * A renderer that is gone (OOM, a GPU reset it could not survive, a crash)
   * used to leave a live main process holding a blank window. Reload it: the
   * proxy, the settings and the session marker all live out here, so what comes
   * back is the same receiver, and `resumeIntent` puts the station back on. */
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error(`renderer gone (${details.reason}); reloading the panel`);
    if (!win.isDestroyed()) win.reload();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
    if (process.env.PSPPCPR_DEVTOOLS === '1') win.webContents.openDevTools({ mode: 'detach' });
  } else {
    void win.loadFile(RENDERER_INDEX);
  }

  forwardProxyEvents(win);
  return win;
}

/** Proxy events are pushed to whichever window is alive; sends after teardown are dropped. */
function forwardProxyEvents(win: BrowserWindow): void {
  const send = (channel: string) => (payload: unknown) => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
  };
  const onStats = send(IPC.proxyStats);
  const onMeta = send(IPC.proxyMetadata);
  const onEvent = send(IPC.proxyEvent);
  proxy.on('stats', onStats);
  proxy.on('metadata', onMeta);
  proxy.on('event', onEvent);
  win.once('closed', () => {
    proxy.off('stats', onStats);
    proxy.off('metadata', onMeta);
    proxy.off('event', onEvent);
  });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc(): void {
  ipcMain.handle(IPC.proxyStart, (_e, upstreamUrl: unknown, opts: unknown) => {
    if (typeof upstreamUrl !== 'string') throw new Error('proxy.start expects a URL string');
    const preroll = (opts as ProxySessionOptions | undefined)?.prerollSeconds;
    return proxy.createSession(upstreamUrl, { prerollSeconds: preroll });
  });
  ipcMain.handle(IPC.proxyStop, (_e, sessionId: unknown) => {
    if (typeof sessionId === 'string') proxy.closeSession(sessionId);
  });
  ipcMain.handle(IPC.proxyStopAll, () => proxy.closeAllSessions('renderer requested stop-all'));

  ipcMain.handle(IPC.settingsLoad, () => loadSettings());
  ipcMain.handle(IPC.settingsSave, (_e, settings: Settings) => saveSettings(settings));

  ipcMain.handle(IPC.memoryLoad, (): StationMemory => loadMemory());
  ipcMain.handle(IPC.memorySave, (_e, memory: unknown) => saveMemory(coerceMemory(memory)));

  ipcMain.handle(IPC.directoryGenres, (_e, minStations: unknown): Promise<DirectoryResult<GenreTag[]>> => {
    const min = Math.max(0, Math.floor(Number(minStations)) || 0);
    return directoryCall(() => directory.listGenres(min));
  });
  ipcMain.handle(
    IPC.directorySearch,
    async (_e, query: unknown): Promise<DirectoryResult<StationRef[]>> => {
      // A folded genre is several tag queries. If some of them fail the result
      // is real but short, and Law 4 says the panel must be told rather than
      // shown a quietly truncated band.
      let partial: PartialExpansion | null = null;
      const result = await directoryCall(() =>
        directory.search(coerceQuery(query), { onPartial: (note) => (partial = note) }),
      );
      if (result.ok && partial) {
        const note = partial as PartialExpansion;
        return {
          ...result,
          warning: `PARTIAL — ${note.fetched} OF ${note.spellings} SPELLINGS ANSWERED`,
        };
      }
      return result;
    },
  );
  ipcMain.handle(IPC.directoryIndex, (): Promise<DirectoryResult<RegisterIndex>> =>
    directoryCall(() => directory.listIndex()),
  );

  ipcMain.handle(IPC.directoryReport, async (_e, stationId: unknown): Promise<void> => {
    if (typeof stationId === 'string' && stationId) await directory.reportListening(stationId);
  });

  ipcMain.handle(IPC.resolverResolve, async (_e, url: unknown): Promise<ResolveResult> => {
    if (typeof url !== 'string' || !url) {
      return { ok: false, failure: { kind: 'network', message: 'resolve() expects a URL string' } };
    }
    // Contractually total — but the boundary must be total too, so a bug in the
    // resolver surfaces as a designed failure rather than an IPC rejection.
    try {
      return await resolver.resolve(url);
    } catch (err) {
      return {
        ok: false,
        failure: {
          kind: 'network',
          message: err instanceof Error ? err.message : String(err),
          cause: networkCauseOf(err),
        },
      };
    }
  });

  ipcMain.handle(IPC.appInfo, (): AppInfo => appInfo());

  ipcMain.handle(IPC.appResumeIntent, (): ResumeIntent => resumeIntent());

  ipcMain.handle(IPC.capturePage, async () => {
    const win = mainWindow;
    if (!win || win.isDestroyed()) throw new Error('no window');
    const image = await win.webContents.capturePage();
    return image.toDataURL();
  });

  ipcMain.on(IPC.reportState, (_e, state: PlaybackState) => {
    const wasOnAir = isOnAir(lastPlaybackState);
    const previousStation = lastPlaybackState.station?.id;
    lastPlaybackState = state;
    const onAir = isOnAir(state);
    const win = mainWindow;
    // The renderer reports ten times a second and nothing below is worth doing
    // ten times a second: act on the transitions only.
    if (win && !win.isDestroyed() && (onAir !== wasOnAir || state.station?.id !== previousStation)) {
      if (onAir !== wasOnAir) setOnAir(win, onAir);
      const marker: SessionMarker = { onAir, cleanExit: false, at: Date.now() };
      if (state.station?.id) marker.stationId = state.station.id;
      writeSession(marker);
    }
  });
}

function appInfo(): AppInfo {
  return {
    version: app.getVersion(),
    platform: process.platform,
    proxyPort: proxy.address.port,
    testHooks: TEST_HOOKS,
    userDataPath: app.getPath('userData'),
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    await proxy.start();
    // Before anything this run writes over it.
    readPreviousSession();
    registerIpc();

    /* A child process died. Only the renderer is fatal to the panel and it has
     * its own handler; the GPU process is Chromium's to restart, and with the
     * crash limit lifted it will. Logged because "the needle stopped moving for
     * two seconds at 3am" needs an explanation somewhere. */
    app.on('child-process-gone', (_e, details) => {
      console.error(
        `child process gone: ${details.type}${details.serviceName ? ` (${details.serviceName})` : ''} — ${details.reason}`,
      );
    });

    if (TEST_HOOKS) {
      const descriptorPath =
        process.env.PSPPCPR_TEST_HOOKS_FILE ?? path.join(app.getPath('userData'), 'test-hooks.json');
      const d = installTestHooks(
        proxy,
        {
          capturePage: async () => {
            const win = mainWindow;
            if (!win || win.isDestroyed()) throw new Error('no window');
            return (await win.webContents.capturePage()).toPNG();
          },
          playbackState: () => lastPlaybackState,
          appInfo,
          quit: () => app.quit(),
          setWindowVisible: (visible: boolean) => {
            const win = mainWindow;
            if (!win || win.isDestroyed()) return;
            if (visible) win.show();
            else win.hide();
          },
          executeJavaScript: async (code: string) => {
            const win = mainWindow;
            if (!win || win.isDestroyed()) throw new Error('no window');
            // userGesture: true — a harness driving the panel must pass the same
            // user-activation gates a hand does, autoplay policy included.
            return win.webContents.executeJavaScript(code, true);
          },
        },
        descriptorPath,
      );
      // Printed so a harness can scrape stdout instead of reading userData.
      console.log(`PSPPCPR_TEST_HOOKS ${JSON.stringify({ ...d, descriptorPath })}`);
    }

    mainWindow = createWindow();
    mainWindow.on('closed', () => {
      mainWindow = null;
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    proxy.closeAllSessions('app quitting');
    // Stamped clean: this receiver was switched off, it did not fall over, and
    // the next launch must come up in standby rather than putting a station
    // back on the air nobody asked for.
    const marker: SessionMarker = {
      onAir: isOnAir(lastPlaybackState),
      cleanExit: true,
      at: Date.now(),
    };
    if (lastPlaybackState.station?.id) marker.stationId = lastPlaybackState.station.id;
    writeSession(marker);
  });

  app.on('will-quit', () => {
    void proxy.stop();
  });
}
