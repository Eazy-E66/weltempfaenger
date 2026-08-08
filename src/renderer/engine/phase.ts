/**
 * Phase derivation. A pure function of observed evidence — no timers, no state,
 * no knowledge of what the user pressed.
 *
 * This is the load-bearing rule of the whole project: pressing PLAY *requests* a
 * transition, it never reports one. Everything below comes from HTMLMediaElement
 * events and readyState, from `buffered`, and from real byte flow measured by
 * the proxy. If the bytes stop, the phase changes whether or not anyone asked.
 */

import type { PlaybackPhase } from '../../shared/contracts.js';

/** Media-side quiet period after which a formerly playing element counts as stalled. */
export const MEDIA_STALL_MS = 2_000;
/** How stale a `playing` observation may be before we stop trusting it. */
export const ADVANCE_FRESH_MS = 900;

export interface PhaseEvidence {
  now: number;

  /** A proxy session exists (the <audio> has a URL to load). */
  hasSession: boolean;
  /** The host is asking the resolver for a playable URL. */
  resolving: boolean;
  /**
   * A tune is under way and has not yet reached a session: the audio context is
   * unlocking, or the proxy is minting. Both are real awaits — an IPC round trip
   * and an AudioContext resume — and during them the receiver is emphatically not
   * in standby, so this is what keeps `idle` meaning standby and nothing else.
   */
  starting: boolean;
  /** AFC is between attempts. */
  reconnecting: boolean;
  /** Terminal failure already decided by the engine. */
  failed: boolean;

  // --- measured by the proxy -------------------------------------------------
  bytesReceived: number;
  proxyStalled: boolean;
  /** Upstream went away on its own and no reconnect is in flight. */
  upstreamDropped: boolean;

  // --- measured on the media element ----------------------------------------
  readyState: number;
  paused: boolean;
  /** Wall clock of the last tick where currentTime was strictly greater. */
  lastAdvanceAt?: number;
  playingEventAt?: number;
  mediaError: boolean;
}

export function derivePhase(e: PhaseEvidence): PlaybackPhase {
  if (e.failed) return 'error';
  // Before the media error, deliberately. A dropped mount makes the element
  // report an error *and* makes AFC start re-locking; reporting the fault would
  // print FAULT for a state the engine is actively recovering from, and the
  // recovery is the thing the listener needs to see (Law 4 — Reconnect is a
  // designed control, so a reconnect in flight is a designed state).
  if (e.reconnecting) return 'reconnecting';
  if (e.mediaError) return 'error';
  if (e.resolving) return 'resolving';
  if (e.starting) return 'connecting';
  if (!e.hasSession) return 'idle';

  const advancing = e.lastAdvanceAt !== undefined && e.now - e.lastAdvanceAt < ADVANCE_FRESH_MS;
  const everPlayed = e.playingEventAt !== undefined;

  // Was producing audio and no longer is: that is a stall, regardless of intent.
  if (everPlayed && !e.paused) {
    // Between the `playing` event and the first observed currentTime step there
    // is legitimately nothing to measure yet; clocking the silence from the
    // event rather than from a missing advance avoids a false stall at start-up.
    const since = e.lastAdvanceAt ?? e.playingEventAt!;
    if (e.upstreamDropped || e.proxyStalled || e.now - since > MEDIA_STALL_MS) return 'stalled';
  }
  if (e.upstreamDropped) return 'stalled';

  // No audio bytes have reached us at all yet — the socket is still opening.
  if (e.bytesReceived === 0 && e.readyState < 1 /* HAVE_METADATA */) return 'connecting';

  // HAVE_FUTURE_DATA is the browser's own claim that it can play on.
  if (advancing && !e.paused && e.readyState >= 3) return 'playing';

  return 'buffering';
}

/** Pre-roll target in seconds for each NARROW/WIDE position. */
export function prerollTarget(bufferDepth: 'narrow' | 'wide'): number {
  return bufferDepth === 'wide' ? 10 : 2;
}

/**
 * How long to keep waiting for the pre-roll target before starting anyway.
 * A cap is required, not cosmetic: on a low-bitrate mount, or when Chromium
 * decides its buffer is full and suspends the fetch, the target may simply never
 * be reachable and the deck would sit in 'buffering' forever.
 */
export function prerollDeadlineMs(bufferDepth: 'narrow' | 'wide'): number {
  return bufferDepth === 'wide' ? 20_000 : 8_000;
}
