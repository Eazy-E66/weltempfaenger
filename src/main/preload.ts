/**
 * The only thing the renderer gets. contextIsolation is on, so this runs in an
 * isolated world and hands over a frozen, hand-written surface — no ipcRenderer,
 * no require, no Node.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  IPC,
  type AppInfo,
  type DirectoryResult,
  type PsppcprBridge,
  type ResumeIntent,
  type StationMemory,
  type Unsubscribe,
  type WindowAttention,
} from './ipc.js';
import type {
  GenreTag,
  PlaybackState,
  RegisterIndex,
  ResolveResult,
  Settings,
  StationQuery,
  StationRef,
} from '../shared/contracts.js';
import type {
  ProxyEvent,
  ProxyHandle,
  ProxyMetadata,
  ProxySessionOptions,
  ProxySessionStats,
} from './proxy/types.js';

function subscribe<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const bridge: PsppcprBridge = {
  api: 1,

  proxy: {
    start: (upstreamUrl: string, opts?: ProxySessionOptions): Promise<ProxyHandle> =>
      ipcRenderer.invoke(IPC.proxyStart, upstreamUrl, opts),
    stop: (sessionId: string): Promise<void> => ipcRenderer.invoke(IPC.proxyStop, sessionId),
    stopAll: (): Promise<void> => ipcRenderer.invoke(IPC.proxyStopAll),
    onStats: (cb) => subscribe<ProxySessionStats>(IPC.proxyStats, cb),
    onMetadata: (cb) => subscribe<ProxyMetadata>(IPC.proxyMetadata, cb),
    onEvent: (cb) => subscribe<ProxyEvent>(IPC.proxyEvent, cb),
  },

  settings: {
    load: (): Promise<Settings> => ipcRenderer.invoke(IPC.settingsLoad),
    save: (settings: Settings): Promise<void> => ipcRenderer.invoke(IPC.settingsSave, settings),
  },

  memory: {
    load: (): Promise<StationMemory> => ipcRenderer.invoke(IPC.memoryLoad),
    save: (memory: StationMemory): Promise<void> => ipcRenderer.invoke(IPC.memorySave, memory),
  },

  directory: {
    listGenres: (minStations: number): Promise<DirectoryResult<GenreTag[]>> =>
      ipcRenderer.invoke(IPC.directoryGenres, minStations),
    listIndex: (): Promise<DirectoryResult<RegisterIndex>> =>
      ipcRenderer.invoke(IPC.directoryIndex),
    search: (query: StationQuery): Promise<DirectoryResult<StationRef[]>> =>
      ipcRenderer.invoke(IPC.directorySearch, query),
    reportListening: (stationId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.directoryReport, stationId),
  },

  resolver: {
    resolve: (url: string): Promise<ResolveResult> => ipcRenderer.invoke(IPC.resolverResolve, url),
  },

  app: {
    info: (): Promise<AppInfo> => ipcRenderer.invoke(IPC.appInfo),
    capturePage: (): Promise<string> => ipcRenderer.invoke(IPC.capturePage),
    onAttention: (cb) => subscribe<WindowAttention>(IPC.windowAttention, cb),
    resumeIntent: (): Promise<ResumeIntent> => ipcRenderer.invoke(IPC.appResumeIntent),
  },

  reportPlaybackState: (state: PlaybackState): void => {
    ipcRenderer.send(IPC.reportState, state);
  },
};

contextBridge.exposeInMainWorld('psppcpr', bridge);
