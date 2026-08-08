/**
 * Turning failures into sentences.
 *
 * Law 4: every failure is a designed state. A designed state needs words, and
 * the words have to say what broke *and* what the listener can do about it —
 * "DIRECTORY UNREACHABLE" with a Reconnect button beside it is a state; a blank
 * list is a defect.
 *
 * The panel silkscreens everything, so these are written in caps-lock voice and
 * kept short enough to sit on one line of a small readout.
 *
 * ## THE ONE RULE IN THIS FILE
 *
 * **Nothing here ever interpolates a failure's `message`.** Every sentence below
 * is composed from the failure's *kind* (plus, where the transport supplied one,
 * its structured `cause` and HTTP status). The raw text stays where it is useful
 * and harmless — a log, an HTTP body, `PlaybackEngine.diagnostics()` — and it
 * does not come through here.
 *
 * That rule exists because the opposite was shipped and measured on the panel,
 * verbatim:
 *
 *   · `the station's host did not answer (getaddrinfo ENOTFOUND stream…invalid)`
 *   · `the station's host did not answer (connect ECONNREFUSED 127.0.0.1:18799)`
 *     — an IP address and a port number on a 1977 faceplate
 *   · `the station's host did not answer (certificate has expired)` — which is
 *     *false*. The host answered. Its certificate had expired.
 *   · `(28879379129536:ERROR:100000F7:SSL ROUTINES:OPENSSL_INTERNAL…)`
 *
 * The engine has a jargon guard, and it sat downstream of all four: the sentence
 * was already assembled here, so by the time anything inspected it, the leak was
 * part of a sentence that read like prose. A denylist of known jargon is also
 * unwinnable in principle — it can only ever list the internals somebody has
 * already been shown. Composition cannot leak, because the output is drawn from
 * a closed set of strings written in this file. An unrecognised cause degrades to
 * a vaguer sentence, never to raw text.
 */

import type { DirectoryFailure } from '../../main/ipc';
import type { NetworkCause, ResolveFailure } from '../../shared/contracts';
import type { BrowseResults } from '../ui/types';

/**
 * The one rule about *where* a failure is allowed to land.
 *
 * `BrowseResults.error` is not a general message channel. The register turns it
 * into a `NOT PRINTED` sheet header, which is the truth when the sheet is empty
 * and a fabrication when there are rows under it — and one real click on RADIO
 * at cold start used to produce exactly that: `NOT PRINTED` printed above 43
 * still-rendered entries, and still wrong twenty seconds later, because the
 * message was never about the sheet in the first place.
 *
 * So a fault may only ride with an empty result. Panel-level messages go to the
 * annunciator (`host/notices.ts`) instead. Enforced by dropping the fault
 * rather than by throwing: a corrupted sheet header is a defect, and taking the
 * renderer down to avoid one would be a worse defect.
 */
export function sheetSafe(results: BrowseResults): BrowseResults {
  if (!results.error || results.stations.length === 0) return results;
  const { error: _dropped, ...rest } = results;
  return rest;
}

/**
 * Directory faults.
 *
 * The station list prefixes these with "DIRECTORY FAULT —" and silkscreen text
 * does not wrap, so the whole line has to fit the browser column: about
 * thirty-five characters are left after the prefix. Each one therefore says the
 * cause and the remedy and nothing else, which is how a legend on a real panel
 * reads anyway.
 *
 * Exhaustive with no `default`. The default used to be `brief(failure.message)`
 * — an unreachable branch today, and a standing invitation for the next
 * `DirectoryErrorKind` to arrive on the panel as a Node error string. A new kind
 * now stops the build here instead, which is where the decision belongs.
 */
export function directoryFaultText(failure: DirectoryFailure): string {
  switch (failure.kind) {
    case 'network':
      return 'NO ROUTE — RECONNECT TO RETRY';
    case 'timeout':
      return 'NO ANSWER IN TIME — RECONNECT';
    case 'http':
      return `MIRROR REFUSED${failure.status ? ` (HTTP ${failure.status})` : ''} — RECONNECT`;
    case 'malformed':
      return 'MIRROR UNREADABLE — RECONNECT';
    case 'no-mirror':
      return 'NO MIRROR REACHABLE — RECONNECT';
  }
}

/**
 * A transport failure, in words, composed from its structured cause.
 *
 * Each of these is a different fact with a different remedy, which is the whole
 * reason `NetworkCause` exists: "the station's host did not answer" was printed
 * for all of them, and for an expired certificate it was a plain lie.
 */
function networkText(cause: NetworkCause | undefined): string {
  switch (cause) {
    case 'dns':
      return 'that address does not exist any more';
    case 'refused':
      return 'nothing is listening at that address';
    case 'unreachable':
      return 'there is no route to that address — check the network';
    case 'reset':
      return 'the station broke the connection — try RECONNECT';
    case 'tls':
      return "the station's security certificate is not valid";
    case 'protocol':
      return 'that address answered with something that is not a stream';
    case 'unknown':
    default:
      // The transport told us nothing more than "it failed". Say exactly that,
      // and name the control that retries it.
      return 'the receiver could not reach that address — try RECONNECT';
  }
}

/**
 * An HTTP status, in words.
 *
 * 403 and 500 both used to read "the station's server answered N; it may have
 * moved", which is wrong twice over: a refusal is not a move, and a broken
 * server is not a move either. Each of the statuses a radio mount actually
 * returns now says what it means and, where there is one, what to do next —
 * RECONNECT walks to the next mount the resolver found, and none of the six
 * fault paths used to mention that it was sitting right there.
 */
function httpText(status: number): string {
  if (status === 401 || status === 407) return 'that mount wants a password this receiver cannot give';
  if (status === 403) return 'the station refused this receiver';
  if (status === 404 || status === 410) return 'that mount is gone — try RECONNECT for another';
  if (status === 429) return 'the station is turning listeners away — try again shortly';
  if (status === 451) return 'the station is not allowed to serve this listener';
  if (status >= 500) return "the station's server is broken — try RECONNECT";
  if (status >= 400) return 'the station would not serve this mount — try RECONNECT';
  // 1xx/2xx/3xx reaching a failure path means the response was not usable.
  return 'the station answered, but not with a stream';
}

/**
 * What was at the address instead of audio.
 *
 * A content type is structured rather than prose, but it is still the server's
 * text and a server may put anything in it, so it is classified into a closed
 * set rather than printed. A parking page is by far the common case and is worth
 * naming: "that address serves a web page" tells a listener the mount is dead
 * and the domain has been sold, which "not audio" does not.
 */
function contentText(contentType: string): string {
  const ct = contentType.toLowerCase();
  if (ct.includes('html') || ct.includes('xhtml')) return 'that address serves a web page, not a stream';
  if (ct.includes('json') || ct.includes('xml')) return 'that address serves a data file, not a stream';
  if (ct.includes('image/')) return 'that address serves an image, not a stream';
  if (ct.includes('video/')) return 'that address serves video, not a stream';
  if (ct.includes('text/')) return 'that address serves a text file, not a stream';
  return 'that address does not serve a stream';
}

/**
 * Resolve faults, as the engine will print them: the readout already shows the
 * kind in capitals, so these carry the specifics and the remedy.
 *
 * Deliberately exhaustive with no `default`. A new `ResolveFailure` member is a
 * new state the panel has to be able to describe, and the compiler should say
 * so here rather than letting it reach a listener as a shrug.
 */
export function resolveFaultText(failure: ResolveFailure): string {
  switch (failure.kind) {
    case 'network':
      return networkText(failure.cause);
    case 'timeout':
      return 'the station took too long to answer — try RECONNECT';
    case 'http':
      return httpText(failure.status);
    case 'not-audio':
      return contentText(failure.contentType);
    case 'hls':
      // The one failure the listener cannot fix, so it must not read as a
      // network problem they should keep retrying. RECONNECT is deliberately
      // not offered: it cannot help, and offering it here would teach that it
      // never helps.
      return 'this station is HLS only, which this receiver cannot decode — pick another';
    case 'empty-playlist':
      return 'the station list at that address was empty — try RECONNECT for another';
    case 'too-many-redirects':
      return 'that address redirected in circles — try RECONNECT for another mount';
  }
}

/**
 * Every sentence `resolveFaultText` can produce, for a test to sweep.
 *
 * Exported because the guarantee this file makes is a *closed set*, and a closed
 * set is only checkable if it can be enumerated. A test asserts that no member
 * carries a Node or OpenSSL identifier, which is a stronger statement than
 * asserting it about the handful of failures a test happens to construct.
 */
export const FAULT_SENTENCES: readonly string[] = [
  ...(['dns', 'refused', 'unreachable', 'reset', 'tls', 'protocol', 'unknown'] as NetworkCause[]).map(
    networkText,
  ),
  networkText(undefined),
  ...[200, 301, 401, 403, 404, 407, 410, 429, 451, 500, 502, 503, 400, 418].map(httpText),
  ...[
    'text/html',
    'application/json',
    'image/png',
    'video/mp4',
    'text/plain',
    'application/octet-stream',
    '',
  ].map(contentText),
  resolveFaultText({ kind: 'timeout', message: 'x' }),
  resolveFaultText({ kind: 'hls', message: 'x' }),
  resolveFaultText({ kind: 'empty-playlist', message: 'x' }),
  resolveFaultText({ kind: 'too-many-redirects', message: 'x' }),
];
