/**
 * The engine's debug view. Everything here is observed, but none of it belongs
 * in PlaybackState — the UI renders the contract, and this exists for the test
 * hooks and for working out why a mount is misbehaving.
 */

import type { Settings } from '../../shared/contracts.js';
import type { ProxyEvent, ProxySessionStats } from '../../main/proxy/types.js';
import type { MediaObservation } from './media-observer.js';
import type { AudioStage } from './stage.js';
import type { ProxyLink } from './link.js';
import { prerollTarget } from './phase.js';

export interface EngineDiagnostics {
  sessionId?: string;
  proxyUrl?: string;
  prerollTargetSeconds: number;
  prerollMet: boolean;
  prerollWaitedMs: number;
  afcAttempts: number;
  readyState: number;
  networkState: number;
  paused: boolean;
  /** Timestamp of the last occurrence of each watched media event. */
  mediaEvents: Record<string, number>;
  lastProxyEvent?: ProxyEvent;
  audioContextState?: string;
  noiseGain: number;
  tuningProximity: number;
  /** How much of the station survives the current detune, 0..1. */
  stationGain: number;
  /** The link half of the meter reading, 0..1. */
  linkHealth: number;
  /** The decoded-level half of the meter reading, 0..1. */
  levelDeflection: number;
  /** icy-br, for comparison against the measured rate. */
  claimedBitrateKbps?: number;
  /**
   * Delivery throughput, kbps — bytes off the wire per unit time. Genuinely
   * useful (it is how you see burst-on-connect, and how you catch a mount that
   * cannot keep up with real time) but deliberately not what the panel prints
   * next to the codec name; see `PlaybackState.codecBitrateKbps`.
   */
  deliveryBitrateKbps?: number;
  /** The codec's own declared rate, read from real frame headers where present. */
  frameBitrateKbps?: number;
  /** Audio queued between the proxy and the decoder — where a WIDE buffer lives. */
  pipelineSeconds: number;
  proxyPrerollComplete: boolean;
  proxyPrerollHeldBytes: number;

  /**
   * The browser's own words for the current media fault, verbatim —
   * `DEMUXER_ERROR_COULD_NOT_OPEN: FFmpegDemuxer: open context failed` and the
   * rest. This is where they belong: they are real evidence and useless to a
   * listener, so `PlaybackError.message` gets a sentence and this gets the
   * stack trace.
   */
  mediaError?: { code: number; message: string };
  /** Raw text behind the last terminal fault, whatever produced it. */
  rawFaultMessage?: string;
  /** Which resolved mount is in use, and how many the resolver offered. */
  candidateIndex: number;
  candidateCount: number;
}

export interface DiagnosticsInput {
  settings: Settings;
  stage: AudioStage;
  link: ProxyLink;
  observation: MediaObservation;
  prerollMet: boolean;
  prerollStartedAt: number;
  afcAttempts: number;
  linkHealth: number;
  now: number;
  rawFaultMessage?: string;
  candidateIndex: number;
  candidateCount: number;
}

export function buildDiagnostics(input: DiagnosticsInput): EngineDiagnostics {
  const o = input.observation;
  const stats: ProxySessionStats | undefined = input.link.stats;
  return {
    sessionId: input.link.sessionId,
    proxyUrl: input.link.url,
    prerollTargetSeconds: prerollTarget(input.settings.bufferDepth),
    prerollMet: input.prerollMet,
    prerollWaitedMs: input.prerollStartedAt ? input.now - input.prerollStartedAt : 0,
    afcAttempts: input.afcAttempts,
    readyState: o.readyState,
    networkState: o.networkState,
    paused: o.paused,
    mediaEvents: { ...o.events },
    lastProxyEvent: input.link.lastProxyEvent,
    audioContextState: input.stage.contextState,
    noiseGain: input.stage.noiseGain,
    tuningProximity: input.stage.tuningProximity,
    stationGain: input.stage.stationGain,
    linkHealth: input.linkHealth,
    levelDeflection: input.stage.readSignalLevel(),
    claimedBitrateKbps: stats?.info?.icyBitrate,
    deliveryBitrateKbps: stats?.measuredBitrateKbps,
    frameBitrateKbps: stats?.info?.audioFormat?.frameBitrateKbps,
    pipelineSeconds: stats?.pipelineSeconds ?? 0,
    proxyPrerollComplete: stats?.prerollComplete ?? false,
    proxyPrerollHeldBytes: stats?.prerollHeldBytes ?? 0,
    mediaError: o.error,
    rawFaultMessage: input.rawFaultMessage,
    candidateIndex: input.candidateIndex,
    candidateCount: input.candidateCount,
  };
}
