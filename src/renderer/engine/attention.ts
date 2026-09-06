/**
 * IS ANYBODY LOOKING?
 *
 * One boolean, pushed from the browser process, that every drawing loop in the
 * renderer is allowed to consult and that nothing on the audio path ever does.
 *
 * WHY IT CANNOT BE `document.visibilityState`
 * -------------------------------------------
 * Because that is not true here. `backgroundThrottling: false` — set so a
 * throttled tab could not clamp the stall-detection tick — makes Electron hold
 * the WebContents "shown", so the page reports `visible` with the window
 * minimised, occluded, or unmapped from the X server altogether. Measured on
 * the shipping build, window unmapped and therefore on nobody's screen:
 *
 *     document.visibilityState  'visible'
 *     host frame loop           running
 *     total app CPU             63.5% of a core
 *
 * The browser process knows better — it owns the window, and it is the only
 * side that hears the OS say `suspend` (a shut laptop lid) or `lock-screen`.
 * So it decides and pushes; this module caches the answer and hands it out.
 *
 * WHAT IT IS FOR, AND WHAT IT IS NOT FOR
 * --------------------------------------
 * For: parking a 60 fps needle nobody can see. Against: anything audible.
 * The stream keeps playing, the proxy keeps forwarding, the engine keeps
 * measuring, the analyser keeps integrating, and the phase keeps being derived
 * from evidence at 10 Hz. What stops is *drawing*, which is the only part of
 * this application whose entire product is photons.
 *
 * LAW 2 SURVIVES THIS. A parked movement is not a stale reading: while nothing
 * is drawn the needle's position tracks the measurement exactly (see meter.ts —
 * `pos` is set to the target and the ballistics are skipped, not frozen), and
 * the instant attention returns the true position is written in one go, before
 * any spring runs. A dead stream still reads exactly zero, drawn or not.
 *
 * It lives under engine/ because that is where the renderer's non-visual
 * machinery lives; it imports nothing from the UI and holds no DOM state beyond
 * one listener.
 */

import type { WindowAttention } from '../../main/ipc.js';
import { hasBridge, getBridge } from './bridge.js';

type Listener = (attended: boolean) => void;

const listeners = new Set<Listener>();

/**
 * Optimistic by design. Every consumer treats `true` as "draw normally", so a
 * renderer that never hears from the browser process — a test, a stray window,
 * a bridge that failed to load — behaves exactly as it did before this existed.
 */
let attended = true;
let reason: WindowAttention['reason'] | 'assumed' = 'assumed';
let installed = false;

function publish(next: boolean, why: WindowAttention['reason'] | 'assumed'): void {
  reason = why;
  if (next === attended) return;
  attended = next;
  for (const cb of listeners) cb(attended);
}

/**
 * Subscribe to both sources, once.
 *
 * The two are ANDed rather than either taken alone. The push from the browser
 * process is the load-bearing one; `visibilitychange` is what actually fires
 * when the page is genuinely backgrounded (which it is in standby, where the
 * throttling policy lets it be), and hearing it directly saves a round trip.
 */
function install(): void {
  if (installed) return;
  installed = true;

  let fromMain = true;
  let fromPage = true;
  const recompute = (why: WindowAttention['reason'] | 'assumed'): void =>
    publish(fromMain && fromPage, why);

  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    fromPage = document.visibilityState !== 'hidden';
    document.addEventListener('visibilitychange', () => {
      fromPage = document.visibilityState !== 'hidden';
      recompute(fromPage ? 'shown' : 'hidden');
    });
  }

  if (hasBridge()) {
    // `onAttention` arrived with the battery work; a preload from an older
    // build simply has no such channel and the page source stands alone.
    getBridge().app.onAttention?.((a: WindowAttention) => {
      fromMain = a.attended;
      recompute(a.reason);
    });
  }

  recompute(reason);
}

/** True when a human could see the panel. Cheap: one boolean read. */
export function isAttended(): boolean {
  install();
  return attended;
}

/**
 * Called on every change, with the new value. Returns the unsubscribe.
 *
 * Consumers must treat a `true` callback as "the reading may have moved while
 * you were not drawing — show the real one now", not as "resume animating".
 */
export function onAttentionChange(cb: Listener): () => void {
  install();
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Test seam. The browser process is the only producer in the shipping app; a
 * DOM test has no browser process and a measurement harness needs to be able to
 * put the renderer into the state it is measuring.
 */
export function setAttendedForTest(next: boolean): void {
  install();
  publish(next, next ? 'shown' : 'hidden');
}
