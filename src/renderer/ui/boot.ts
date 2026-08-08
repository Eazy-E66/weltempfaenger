/**
 * Renderer entry point for the shipped app.
 *
 * The faceplate does not know how to fetch a directory or open a socket, and it
 * must not learn. This file is the seam:
 *
 *   - If a host has published `window.__weltempfaenger` before this module runs
 *     (`host/index.ts`, loaded from the script tag above ours) we mount the
 *     faceplate, hand the host our `FaceplateHandle`, and get out of the way.
 *     Every intent the user expresses arrives at `host.handlers`.
 *
 *   - If nothing is there, the receiver has no engine and no directory, and it
 *     says so. It does **not** fall back to anything that produces audio-looking
 *     state.
 *
 * There used to be a fallback here that dynamically imported the mock feeder so
 * a hostless page still showed a moving needle. That import made the mock a
 * live code path in the shipping bundle — Rollup emitted it as a chunk and
 * electron-builder packed it into app.asar — which is precisely what Law 2's
 * corollary forbids: "no fixture, mock, or demo mode may ever be reachable from
 * the shipping UI in a way that looks like real playback."
 *
 * The mock now has exactly one importer, `ui/harness/harness.ts`, reached only
 * through `ui/harness/index.html`. That page is not an input to the production
 * Rollup build, so the mock is not merely dead code in the shipped bundle — it
 * is absent from it. `test/ui/no-mock-in-production.test.ts` walks the import
 * graph from the production entry points on every `npm test` and fails if any
 * path ever reaches the harness again.
 */

import '../styles/index.css';
import { mountFaceplate } from './index';
import { renderHostFailure } from './hostFailure';
import type { FaceplateHandle, FaceplateHandlers } from './types';

export interface FaceplateHost {
  handlers: FaceplateHandlers;
  /** Called once, with the handle the host should render through. */
  attach(handle: FaceplateHandle): void;
}

declare global {
  interface Window {
    __weltempfaenger?: FaceplateHost;
    /** Exposed so a host loaded after us can still take over. */
    __mountWeltempfaenger?: (host: FaceplateHost) => FaceplateHandle;
    /** Set by `host/index.ts` when constructing the receiver threw. */
    __weltempfaengerBootError?: string;
  }
}

const root = document.getElementById('app');
if (!root) throw new Error('#app is missing from index.html');

window.__mountWeltempfaenger = (host: FaceplateHost) => {
  // A late host takes over from whatever is on screen, fault card included.
  root.replaceChildren();
  const handle = mountFaceplate(root, host.handlers);
  host.attach(handle);
  return handle;
};

if (window.__weltempfaenger) {
  window.__mountWeltempfaenger(window.__weltempfaenger);
} else {
  // Law 4: failure is a designed state. There is no receiver behind this
  // window, so the window must not look like a receiver.
  renderHostFailure(root, window.__weltempfaengerBootError);
}
