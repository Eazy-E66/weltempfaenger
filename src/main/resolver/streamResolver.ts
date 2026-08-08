/**
 * Turning a directory's candidate URL into something that can actually be played.
 *
 * The directory hands us a URL that might be: a live stream, a PLS file, an M3U
 * file, an M3U wrapped in a PLS, a 302 to any of those, an HLS manifest, a
 * parking page, or a host that stopped answering in 2014. This module walks all
 * of that and returns either a preference-ordered list of playable stream URLs
 * or one specific reason it could not.
 *
 * The failure side matters as much as the success side. The reference UI puts
 * a Reconnect button next to the tuning strip because the design assumes
 * streams break; that button is only honest if we can say *what* broke. So
 * `resolve` never throws — every path terminates in a `ResolveFailure` kind.
 */

import type {
  PlayableStream,
  ResolveFailure,
  ResolveResult,
  StreamResolver,
} from '../../shared/contracts';
import {
  DEFAULT_USER_AGENT,
  RawHttpError,
  networkCauseOf,
  rawRequest,
  type RawResponse,
} from './rawHttp';
import { parsePlaylist } from './playlist';
import { decideBodyKind, normaliseContentType } from './sniff';

export interface ResolverOptions {
  /** Redirects followed within a single hop chain. Default 5. */
  maxRedirects?: number;
  /** How deep playlists may nest (a PLS pointing at an M3U is depth 1). Default 3. */
  maxPlaylistDepth?: number;
  /** Per-request connect + header budget, ms. Default 8000. */
  timeoutMs?: number;
  /** Whole-resolve budget, ms. Default 20000. */
  overallTimeoutMs?: number;
  /** Stop once this many playable candidates are found. Default 8. */
  maxCandidates?: number;
  /** Entries probed from any one playlist. Default 12. */
  maxEntriesPerPlaylist?: number;
  userAgent?: string;
  /** Default true. Set false only if the user opts into trusting bad certificates. */
  rejectUnauthorized?: boolean;
}

const DEFAULTS = {
  maxRedirects: 5,
  maxPlaylistDepth: 3,
  timeoutMs: 8000,
  overallTimeoutMs: 20000,
  maxCandidates: 8,
  maxEntriesPerPlaylist: 12,
  userAgent: DEFAULT_USER_AGENT,
  rejectUnauthorized: true,
} as const;

/** Bytes read before deciding what a response is. Plenty for any sync word. */
const SNIFF_BYTES = 4096;
/** Ceiling on a playlist body. Real ones are under 4 KB; this is pure paranoia. */
const MAX_PLAYLIST_BYTES = 512 * 1024;

interface Context {
  streams: PlayableStream[];
  seen: Set<string>;
  deadline: number;
  signal?: AbortSignal | undefined;
}

type Probe = { ok: true } | { ok: false; failure: ResolveFailure };

function failure(f: ResolveFailure): Probe {
  return { ok: false, failure: f };
}

/**
 * A transport error, as a `ResolveFailure`.
 *
 * `cause` rides along with the message rather than replacing it: the message is
 * the truth for a log and for `diagnostics()`, and the cause is the truth for a
 * sentence on the panel. Keeping both is what lets `host/faults.ts` compose from
 * the class and never quote the text.
 */
function mapRawError(err: unknown): ResolveFailure {
  if (err instanceof RawHttpError) {
    if (err.code === 'timeout') return { kind: 'timeout', message: err.message };
    return { kind: 'network', message: err.message, cause: err.netCause };
  }
  return {
    kind: 'network',
    message: err instanceof Error ? err.message : String(err),
    cause: networkCauseOf(err),
  };
}

function parseIcyBitrate(headers: Record<string, string>): number | undefined {
  const direct = headers['icy-br'];
  if (direct) {
    const n = Number.parseInt(direct.split(',')[0]!.trim(), 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  // Icecast reports it inside a compound header instead.
  const info = headers['ice-audio-info'];
  if (info) {
    const m = /(?:^|;)\s*(?:ice-)?bitrate=(\d+)/i.exec(info);
    if (m) {
      const n = Number.parseInt(m[1]!, 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return undefined;
}

const PLACEHOLDER_NAMES = new Set(['', 'unspecified name', 'no name', 'unknown', 'this is my server name']);

function parseIcyName(headers: Record<string, string>): string | undefined {
  const raw = (headers['icy-name'] ?? headers['ice-name'] ?? '').trim();
  if (PLACEHOLDER_NAMES.has(raw.toLowerCase())) return undefined;
  return raw;
}

/**
 * A playlist origin outranks a redirect: knowing a URL came out of a PLS is
 * more useful to the UI than knowing the last hop was a 302.
 */
function originFor(
  parent: PlayableStream['origin'] | null,
  redirected: boolean,
): PlayableStream['origin'] {
  if (parent === 'pls' || parent === 'm3u') return parent;
  return redirected ? 'redirect' : 'direct';
}

export class HttpStreamResolver implements StreamResolver {
  private readonly opts: Required<ResolverOptions>;

  constructor(options: ResolverOptions = {}) {
    this.opts = { ...DEFAULTS, ...options };
  }

  async resolve(url: string, opts?: { signal?: AbortSignal }): Promise<ResolveResult> {
    const ctx: Context = {
      streams: [],
      seen: new Set(),
      deadline: Date.now() + this.opts.overallTimeoutMs,
      signal: opts?.signal,
    };

    let outcome: Probe;
    try {
      outcome = await this.probe(url, ctx, 0, null);
    } catch (err) {
      // Belt and braces: resolve() is contractually total.
      outcome = failure(mapRawError(err));
    }

    if (ctx.streams.length > 0) return { ok: true, streams: ctx.streams };
    if (outcome.ok) {
      return {
        ok: false,
        failure: { kind: 'empty-playlist', message: `Nothing playable was found at ${url}` },
      };
    }
    return { ok: false, failure: outcome.failure };
  }

  // -------------------------------------------------------------------------

  private aborted(ctx: Context): ResolveFailure | null {
    if (ctx.signal?.aborted) return { kind: 'network', message: 'Resolve aborted' };
    if (Date.now() > ctx.deadline) {
      return {
        kind: 'timeout',
        message: `Gave up resolving after ${this.opts.overallTimeoutMs}ms`,
      };
    }
    return null;
  }

  /**
   * Fetch one URL, following redirects, and either record a playable stream or
   * recurse into the playlist it turned out to be.
   */
  private async probe(
    url: string,
    ctx: Context,
    depth: number,
    parentOrigin: PlayableStream['origin'] | null,
  ): Promise<Probe> {
    const stop = this.aborted(ctx);
    if (stop) return failure(stop);

    // --- redirect chain ----------------------------------------------------
    let current = url;
    let redirects = 0;
    const chain = new Set<string>();
    let response: RawResponse;

    for (;;) {
      if (chain.has(current)) {
        return failure({
          kind: 'too-many-redirects',
          message: `Redirect loop: ${current} was visited twice`,
        });
      }
      chain.add(current);

      const budget = Math.min(this.opts.timeoutMs, Math.max(0, ctx.deadline - Date.now()));
      if (budget <= 0) {
        return failure({
          kind: 'timeout',
          message: `Gave up resolving after ${this.opts.overallTimeoutMs}ms`,
        });
      }

      try {
        response = await rawRequest(current, {
          timeoutMs: budget,
          userAgent: this.opts.userAgent,
          rejectUnauthorized: this.opts.rejectUnauthorized,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
      } catch (err) {
        return failure(mapRawError(err));
      }

      const location = response.headers['location'];
      if (response.status >= 300 && response.status < 400 && location) {
        response.close();
        redirects++;
        if (redirects > this.opts.maxRedirects) {
          return failure({
            kind: 'too-many-redirects',
            message: `More than ${this.opts.maxRedirects} redirects starting at ${url}`,
          });
        }
        try {
          current = new URL(location, current).toString();
        } catch {
          return failure({
            kind: 'network',
            message: `Server redirected to an unusable location: ${location}`,
            cause: 'protocol',
          });
        }
        continue;
      }
      break;
    }

    try {
      return await this.classify(response, current, ctx, depth, parentOrigin, redirects > 0);
    } finally {
      response.close();
    }
  }

  private async classify(
    response: RawResponse,
    url: string,
    ctx: Context,
    depth: number,
    parentOrigin: PlayableStream['origin'] | null,
    redirected: boolean,
  ): Promise<Probe> {
    // ICY responses carry status 200 with no HTTP version; everything else must
    // be a real 2xx before we look at the body.
    if (response.status < 200 || response.status >= 300) {
      return failure({
        kind: 'http',
        status: response.status,
        message: `${response.status}${response.statusText ? ` ${response.statusText}` : ''} from ${url}`,
      });
    }

    const contentType = normaliseContentType(response.headers['content-type']);

    let head: Buffer;
    try {
      head = await response.read(SNIFF_BYTES);
    } catch (err) {
      return failure(mapRawError(err));
    }

    const kind = decideBodyKind({ contentType, url, bytes: head });

    if (kind === 'audio') {
      this.record(ctx, url, response, originFor(parentOrigin, redirected), contentType);
      return { ok: true };
    }

    if (kind === 'hls') {
      // Deliberately a hard failure, and its own failure kind. Chromium's
      // <audio> cannot play an HLS manifest without an external library, so
      // "succeeding" here would hand the engine a URL that produces silence
      // forever. Reporting it as `not-audio` would be true but useless — the
      // bytes *are* audio — so the UI gets the precise reason instead.
      return failure({
        kind: 'hls',
        message:
          `${url} is an HLS manifest (#EXTM3U with #EXT-X- tags). ` +
          'HLS is not natively playable in Chromium, so this station cannot be tuned.',
      });
    }

    if (kind === 'html') {
      return failure({
        kind: 'not-audio',
        contentType: contentType || 'text/html',
        message: `${url} returned a web page, not an audio stream`,
      });
    }

    if (kind === 'pls' || kind === 'm3u') {
      return this.followPlaylist(response, url, ctx, depth, kind, head);
    }

    return failure({
      kind: 'not-audio',
      contentType: contentType || 'unknown',
      message:
        `Could not make sense of ${url}: ` +
        `content-type ${contentType || '(absent)'}, and the first ${head.length} bytes ` +
        'match no known audio or playlist format',
    });
  }

  private async followPlaylist(
    response: RawResponse,
    url: string,
    ctx: Context,
    depth: number,
    kind: 'pls' | 'm3u',
    alreadyRead: Buffer,
  ): Promise<Probe> {
    if (depth >= this.opts.maxPlaylistDepth) {
      return failure({
        kind: 'not-audio',
        contentType: kind === 'pls' ? 'audio/x-scpls' : 'audio/x-mpegurl',
        message: `Playlists nested more than ${this.opts.maxPlaylistDepth} deep starting at ${url}`,
      });
    }

    // The sniff read may have truncated the file; pull the rest if there is any.
    let body = alreadyRead;
    if (!response.complete() && alreadyRead.length >= SNIFF_BYTES) {
      try {
        body = await response.read(MAX_PLAYLIST_BYTES);
      } catch {
        body = alreadyRead; // partial playlist is still worth parsing
      }
    }

    const entries = parsePlaylist(kind, body.toString('utf8'), url);
    if (entries.length === 0) {
      return failure({
        kind: 'empty-playlist',
        message: `${url} is a ${kind.toUpperCase()} playlist with no entries`,
      });
    }

    const origin: PlayableStream['origin'] = kind;
    let firstFailure: ResolveFailure | null = null;
    let anyOk = false;

    for (const entry of entries.slice(0, this.opts.maxEntriesPerPlaylist)) {
      if (ctx.streams.length >= this.opts.maxCandidates) break;
      const stop = this.aborted(ctx);
      if (stop) {
        if (!anyOk) firstFailure ??= stop;
        break;
      }
      const result = await this.probe(entry.url, ctx, depth + 1, origin);
      if (result.ok) anyOk = true;
      else firstFailure ??= result.failure;
    }

    if (anyOk) return { ok: true };
    return failure(
      firstFailure ?? {
        kind: 'empty-playlist',
        message: `No entry in ${url} led to audio`,
      },
    );
  }

  private record(
    ctx: Context,
    url: string,
    response: RawResponse,
    origin: PlayableStream['origin'],
    contentType: string,
  ): void {
    if (ctx.seen.has(url)) return;
    if (ctx.streams.length >= this.opts.maxCandidates) return;
    ctx.seen.add(url);

    const icyBitrate = parseIcyBitrate(response.headers);
    const icyName = parseIcyName(response.headers);

    const stream: PlayableStream = {
      url,
      supportsIcyMetadata: response.headers['icy-metaint'] !== undefined,
      origin,
    };
    if (contentType) stream.contentType = contentType;
    if (icyBitrate !== undefined) stream.icyBitrate = icyBitrate;
    if (icyName !== undefined) stream.icyName = icyName;

    ctx.streams.push(stream);
  }
}

/** Convenience for callers that do not want to hold a resolver instance. */
export function createStreamResolver(options?: ResolverOptions): StreamResolver {
  return new HttpStreamResolver(options);
}
