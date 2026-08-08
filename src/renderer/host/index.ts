/**
 * Host entry point.
 *
 * `boot.ts` looks for `window.__weltempfaenger` the moment it runs. In the
 * shipped app there is no second option: if this module does not publish a
 * host, boot.ts draws a hard-failure card and the panel is never mounted. That
 * is the whole mechanism behind Law 2's corollary — there is no mock left in
 * the production bundle for a hostless page to fall back onto.
 *
 * So this module is loaded from a script tag *before* the boot script and
 * publishes the host synchronously, on the first line of evaluation. Nothing is
 * awaited before it is in place.
 *
 * Everything slow (settings, the directory, the audio graph) happens inside
 * `attach`, after the faceplate is mounted and already showing something.
 */

import { ReceiverHost } from './host';

let host: ReceiverHost | undefined;

try {
  host = new ReceiverHost();
  // Synchronous and unconditional.
  window.__weltempfaenger = host;
} catch (err) {
  // Constructing the receiver is not supposed to be capable of throwing. If it
  // ever does, the reason has to survive to the fault card, because the panel
  // will not be mounted and there is nowhere else for it to appear.
  window.__weltempfaengerBootError = `RECEIVER CONSTRUCTION FAILED — ${
    err instanceof Error ? err.message : String(err)
  }`;
}

// Belt and braces against a bundler that reorders the two entry scripts: if
// boot.ts has already published its mount hook, it ran first and is not going
// to read the property we just set, so take over explicitly.
if (host && window.__mountWeltempfaenger) window.__mountWeltempfaenger(host);

export { host };
