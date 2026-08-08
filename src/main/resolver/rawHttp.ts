/**
 * A deliberately small, lenient HTTP/1.x client built on raw sockets.
 *
 * Why not `fetch`? Because a large slice of the internet-radio world still
 * answers with a SHOUTcast status line:
 *
 *     ICY 200 OK
 *     icy-name:Groove Salad
 *
 * Node's HTTP parser (llhttp, under undici) rejects that outright — it is not
 * a valid HTTP version token — so `fetch()` throws before we ever see the
 * headers. Stations that do this are not broken; they predate the spec being
 * enforced. We want them.
 *
 * This client therefore does the minimum by hand: connect, write a request,
 * read a header block, parse it leniently, and expose the body as a
 * pull-based reader that decodes `chunked` when present. It never streams
 * audio — the resolver only ever peeks at the first few KB and then hangs up.
 * Actual playback bytes are the proxy's job.
 */

import * as net from 'node:net';
import * as tls from 'node:tls';
import type { NetworkCause } from '../../shared/contracts.js';

export const DEFAULT_USER_AGENT = 'Weltempfaenger/0.1';

/** Coarse failure classes; the resolver maps these onto `ResolveFailure`. */
export type RawErrorCode = 'network' | 'timeout' | 'protocol';

export class RawHttpError extends Error {
  readonly code: RawErrorCode;
  /**
   * What the socket layer said went wrong, as a closed set.
   *
   * `message` is kept verbatim and is genuinely useful — in a log, in
   * `diagnostics()`, in an HTTP body. It is not for a listener, and it used to
   * become one by being pasted into a sentence on the faceplate. This field is
   * what the panel composes from instead, and it is derived here because here
   * is the only place `error.code` still exists.
   */
  readonly netCause: NetworkCause;
  constructor(message: string, code: RawErrorCode, netCause?: NetworkCause) {
    super(message);
    this.name = 'RawHttpError';
    this.code = code;
    this.netCause = netCause ?? (code === 'protocol' ? 'protocol' : 'unknown');
  }
}

/** Node error codes that mean the name never resolved. */
const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NONAME']);
/** …that the host is reachable and refusing. */
const REFUSED_CODES = new Set(['ECONNREFUSED']);
/** …that there is no path to the host at all. */
const UNREACHABLE_CODES = new Set(['EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EHOSTDOWN', 'EADDRNOTAVAIL']);
/** …that a live connection was broken under us. */
const RESET_CODES = new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED']);
/**
 * OpenSSL's certificate verdicts, which Node surfaces as the bare `code`.
 *
 * These carry no `ERR_TLS_` prefix and several name neither a certificate nor
 * SSL — `UNABLE_TO_VERIFY_LEAF_SIGNATURE` is the commonest expired-chain verdict
 * in the wild and matches nothing keyword-shaped, which is exactly how it would
 * have fallen through to the generic sentence.
 */
const TLS_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_REVOKED',
  'CERT_UNTRUSTED',
  'CERT_CHAIN_TOO_LONG',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_GET_CRL',
  'HOSTNAME_MISMATCH',
  'EPROTO',
]);

/**
 * Classify a thrown transport error into a `NetworkCause`.
 *
 * Reads `error.code` and `error.library`, which are structured fields Node and
 * OpenSSL set — not the human message. The message is deliberately never
 * consulted: a classifier that pattern-matched prose would be the same denylist
 * the panel is being freed from, one layer down, and would go stale the moment
 * Node reworded anything.
 *
 * Anything unrecognised is `unknown`, which still composes into a sentence.
 * That is the whole point: completeness here only buys *specificity*, never
 * safety.
 */
export function networkCauseOf(err: unknown): NetworkCause {
  if (err instanceof RawHttpError) return err.netCause;
  if (!err || typeof err !== 'object') return 'unknown';
  const e = err as { code?: unknown; library?: unknown; reason?: unknown };
  const code = typeof e.code === 'string' ? e.code.toUpperCase() : '';
  // OpenSSL sets `library: 'SSL routines'` on handshake failures, and Node
  // prefixes its own TLS codes with ERR_TLS_ / ERR_SSL_. Certificate verdicts
  // arrive as bare OpenSSL verdict codes (CERT_HAS_EXPIRED,
  // UNABLE_TO_VERIFY_LEAF_SIGNATURE, DEPTH_ZERO_SELF_SIGNED_CERT, …).
  if (typeof e.library === 'string' && /ssl/i.test(e.library)) return 'tls';
  if (code.startsWith('ERR_TLS') || code.startsWith('ERR_SSL') || code.startsWith('ERR_OSSL')) return 'tls';
  if (TLS_CODES.has(code)) return 'tls';
  if (code.includes('CERT') || code.includes('SSL') || code.includes('TLS')) return 'tls';
  if (DNS_CODES.has(code)) return 'dns';
  if (REFUSED_CODES.has(code)) return 'refused';
  if (UNREACHABLE_CODES.has(code)) return 'unreachable';
  if (RESET_CODES.has(code)) return 'reset';
  if (code === 'ETIMEDOUT' || code === 'ERR_SOCKET_CONNECTION_TIMEOUT') return 'unreachable';
  return 'unknown';
}

export interface RawRequestOptions {
  /** Budget for connect + header block. Default 8000ms. */
  timeoutMs?: number;
  /** How long to wait for more body bytes before giving up on a read. Default 4000ms. */
  bodyIdleMs?: number;
  userAgent?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Default true. Radio servers with expired certs are common but we do not silently trust them. */
  rejectUnauthorized?: boolean;
  method?: 'GET' | 'HEAD';
}

export interface RawResponse {
  /** The URL this response actually came from. */
  url: string;
  status: number;
  statusText: string;
  /** `HTTP/1.1`, `HTTP/1.0`, or `ICY` for a SHOUTcast-style status line. */
  protocol: string;
  /** Header names lowercased. Repeated headers are joined with ", ". */
  headers: Record<string, string>;
  /**
   * Read decoded body bytes up to `maxBytes`. Cumulative and re-entrant:
   * `read(4096)` then `read(65536)` continues where the first left off and
   * returns the whole 65536-byte prefix.
   */
  read(maxBytes: number): Promise<Buffer>;
  /** True once the body has hit EOF / content-length / the terminating chunk. */
  complete(): boolean;
  /** Hang up. Always call this; the resolver never wants the whole stream. */
  close(): void;
}

const MAX_HEADER_BYTES = 32 * 1024;

// ---------------------------------------------------------------------------
// Buffered socket reader
// ---------------------------------------------------------------------------

class SocketReader {
  private chunks: Buffer[] = [];
  private length = 0;
  private ended = false;
  private failure: Error | null = null;
  private waiter: (() => void) | null = null;

  constructor(private readonly socket: net.Socket) {
    socket.on('data', (c: Buffer) => {
      this.chunks.push(c);
      this.length += c.length;
      this.wake();
    });
    socket.on('end', () => {
      this.ended = true;
      this.wake();
    });
    socket.on('close', () => {
      this.ended = true;
      this.wake();
    });
    socket.on('error', (err: Error) => {
      this.failure = err;
      this.ended = true;
      this.wake();
    });
  }

  get buffered(): number {
    return this.length;
  }

  get atEnd(): boolean {
    return this.ended;
  }

  get error(): Error | null {
    return this.failure;
  }

  private wake(): void {
    const w = this.waiter;
    this.waiter = null;
    if (w) w();
  }

  /**
   * Wait for more bytes. Resolves early on data, EOF, or error; resolves
   * (rather than rejects) on timeout so callers can decide whether a partial
   * read is acceptable.
   */
  async waitForMore(timeoutMs: number): Promise<void> {
    if (this.length > 0 || this.ended) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        resolve();
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.waiter = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  /** Concatenated view of at most `limit` buffered bytes, without consuming. */
  snapshot(limit = Infinity): Buffer {
    if (this.length === 0) return Buffer.alloc(0);
    if (limit >= this.length && this.chunks.length === 1) return this.chunks[0]!;
    const want = Math.min(limit, this.length);
    const out = Buffer.allocUnsafe(want);
    let filled = 0;
    for (const chunk of this.chunks) {
      if (filled >= want) break;
      const n = Math.min(chunk.length, want - filled);
      chunk.copy(out, filled, 0, n);
      filled += n;
    }
    return out;
  }

  /** Remove and return up to `n` bytes from the front. */
  take(n: number): Buffer {
    if (n <= 0 || this.length === 0) return Buffer.alloc(0);
    const want = Math.min(n, this.length);
    const out = Buffer.allocUnsafe(want);
    let filled = 0;
    while (filled < want) {
      const head = this.chunks[0]!;
      const need = want - filled;
      if (head.length <= need) {
        head.copy(out, filled);
        filled += head.length;
        this.chunks.shift();
      } else {
        head.copy(out, filled, 0, need);
        this.chunks[0] = head.subarray(need);
        filled += need;
      }
    }
    this.length -= want;
    return out;
  }

  destroy(): void {
    this.chunks = [];
    this.length = 0;
    this.socket.destroy();
  }
}

// ---------------------------------------------------------------------------
// Header parsing
// ---------------------------------------------------------------------------

/** `HTTP/1.1 200 OK`, `HTTP/1.0 302 Found`, or the SHOUTcast `ICY 200 OK`. */
const STATUS_LINE = /^(ICY|HTTP\/\d(?:\.\d)?)[ \t]+(\d{3})(?:[ \t]+(.*))?$/i;

export interface ParsedHead {
  protocol: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
}

/**
 * Parse a response head. Tolerates lone-LF line endings and the `ICY` status
 * line. Throws `RawHttpError('protocol')` when the first line is not a status
 * line at all (i.e. the peer is not speaking HTTP).
 */
export function parseResponseHead(head: string): ParsedHead {
  const lines = head.split(/\r?\n/);
  const first = (lines.shift() ?? '').trim();
  const m = STATUS_LINE.exec(first);
  if (!m) {
    const preview = first.slice(0, 60);
    throw new RawHttpError(`Not an HTTP or ICY response (got "${preview}")`, 'protocol');
  }
  const headers: Record<string, string> = {};
  for (const line of lines) {
    if (!line.trim()) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (!name) continue;
    headers[name] = name in headers ? `${headers[name]}, ${value}` : value;
  }
  return {
    protocol: m[1]!.toUpperCase(),
    status: Number(m[2]),
    statusText: (m[3] ?? '').trim(),
    headers,
  };
}

/** Index just past the end of the header block, or -1. Accepts CRLFCRLF and LFLF. */
function findHeadEnd(buf: Buffer): number {
  const crlf = buf.indexOf('\r\n\r\n');
  const lf = buf.indexOf('\n\n');
  if (crlf === -1 && lf === -1) return -1;
  if (crlf === -1) return lf + 2;
  if (lf === -1) return crlf + 4;
  return crlf < lf ? crlf + 4 : lf + 2;
}

// ---------------------------------------------------------------------------
// Body decoding
// ---------------------------------------------------------------------------

type ChunkState = 'size' | 'data' | 'crlf' | 'done';

class BodyReader {
  private decoded: Buffer[] = [];
  private decodedLength = 0;
  private state: ChunkState = 'size';
  private chunkRemaining = 0;
  private identityRemaining: number | null;
  private finished = false;

  constructor(
    private readonly reader: SocketReader,
    private readonly chunked: boolean,
    contentLength: number | null,
    private readonly idleMs: number,
  ) {
    this.identityRemaining = contentLength;
    if (contentLength === 0) this.finished = true;
  }

  get complete(): boolean {
    return this.finished;
  }

  async read(maxBytes: number): Promise<Buffer> {
    while (this.decodedLength < maxBytes && !this.finished) {
      const moved = this.chunked ? this.pumpChunked(maxBytes) : this.pumpIdentity(maxBytes);
      if (moved) continue;
      if (this.reader.atEnd) {
        // Identity bodies terminate at EOF; chunked bodies that die early are
        // simply truncated. Either way, what we have is what we get.
        this.finished = true;
        break;
      }
      const before = this.reader.buffered;
      await this.reader.waitForMore(this.idleMs);
      if (this.reader.buffered === before && !this.reader.atEnd) break; // idle timeout
    }
    const all = Buffer.concat(this.decoded, this.decodedLength);
    return all.length > maxBytes ? all.subarray(0, maxBytes) : all;
  }

  private push(buf: Buffer): void {
    if (buf.length === 0) return;
    this.decoded.push(buf);
    this.decodedLength += buf.length;
  }

  private pumpIdentity(maxBytes: number): boolean {
    const room = maxBytes - this.decodedLength;
    if (room <= 0) return false;
    const limit = this.identityRemaining === null ? room : Math.min(room, this.identityRemaining);
    const got = this.reader.take(limit);
    if (got.length === 0) return false;
    this.push(got);
    if (this.identityRemaining !== null) {
      this.identityRemaining -= got.length;
      if (this.identityRemaining <= 0) this.finished = true;
    }
    return true;
  }

  private pumpChunked(maxBytes: number): boolean {
    let progressed = false;
    for (;;) {
      if (this.state === 'done') {
        this.finished = true;
        return progressed;
      }
      if (this.state === 'size') {
        const head = this.reader.snapshot(1024);
        const idx = head.indexOf('\r\n');
        if (idx === -1) return progressed;
        const line = head.subarray(0, idx).toString('latin1');
        const size = Number.parseInt(line.split(';')[0]!.trim(), 16);
        if (!Number.isFinite(size) || size < 0) {
          this.state = 'done';
          continue;
        }
        this.reader.take(idx + 2);
        progressed = true;
        if (size === 0) {
          this.state = 'done';
          continue;
        }
        this.chunkRemaining = size;
        this.state = 'data';
        continue;
      }
      if (this.state === 'data') {
        const room = maxBytes - this.decodedLength;
        if (room <= 0) return progressed;
        const got = this.reader.take(Math.min(this.chunkRemaining, room));
        if (got.length === 0) return progressed;
        this.push(got);
        this.chunkRemaining -= got.length;
        progressed = true;
        if (this.chunkRemaining === 0) this.state = 'crlf';
        continue;
      }
      // 'crlf' — swallow the chunk terminator
      if (this.reader.buffered < 2) return progressed;
      this.reader.take(2);
      this.state = 'size';
      progressed = true;
    }
  }
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

function connect(
  url: URL,
  port: number,
  timeoutMs: number,
  opts: RawRequestOptions,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err: Error | null, socket?: net.Socket): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        socket?.destroy();
        reject(err);
      } else {
        resolve(socket!);
      }
    };

    const timer = setTimeout(() => {
      finish(new RawHttpError(`Connect timed out after ${timeoutMs}ms`, 'timeout'), socket);
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    const host = url.hostname;
    const socket: net.Socket =
      url.protocol === 'https:'
        ? tls.connect({
            host,
            port,
            servername: net.isIP(host) ? undefined : host,
            rejectUnauthorized: opts.rejectUnauthorized ?? true,
          })
        : net.connect({ host, port });

    const onReady = (): void => finish(null, socket);
    socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', onReady);
    // The one site where `error.code` is still in scope. Everything downstream
    // — the resolver's `ResolveFailure`, the panel's sentence — is composed from
    // the class this derives, never from the text beside it.
    socket.once('error', (err: Error) =>
      finish(new RawHttpError(err.message, 'network', networkCauseOf(err)), socket),
    );

    if (opts.signal) {
      if (opts.signal.aborted) {
        finish(new RawHttpError('Aborted', 'network'), socket);
        return;
      }
      opts.signal.addEventListener(
        'abort',
        () => finish(new RawHttpError('Aborted', 'network'), socket),
        { once: true },
      );
    }
  });
}

function buildRequest(url: URL, opts: RawRequestOptions): string {
  const path = `${url.pathname || '/'}${url.search}`;
  const hostHeader = url.port ? `${url.hostname}:${url.port}` : url.hostname;
  const headers: Record<string, string> = {
    Host: hostHeader,
    'User-Agent': opts.userAgent ?? DEFAULT_USER_AGENT,
    Accept: '*/*',
    // Ask for ICY metadata so `icy-metaint` shows up in the response and we can
    // tell the engine whether "now playing" text is available at all.
    'Icy-MetaData': '1',
    // No Accept-Encoding: we never want a compressed playlist to decode.
    Connection: 'close',
    ...(opts.headers ?? {}),
  };
  const lines = [`${opts.method ?? 'GET'} ${path} HTTP/1.1`];
  for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
  lines.push('', '');
  return lines.join('\r\n');
}

/**
 * Perform one request and return once the header block has been read. The body
 * is left unread on the socket; pull it with `response.read()`.
 */
export async function rawRequest(rawUrl: string, opts: RawRequestOptions = {}): Promise<RawResponse> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const bodyIdleMs = opts.bodyIdleMs ?? 4000;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new RawHttpError(`Not a usable URL: ${rawUrl}`, 'network');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RawHttpError(
      `Unsupported URL scheme "${url.protocol.replace(':', '')}" — only http and https can be played`,
      'network',
    );
  }
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;

  const socket = await connect(url, port, timeoutMs, opts);
  socket.setNoDelay(true);
  const reader = new SocketReader(socket);
  const close = (): void => reader.destroy();

  const onAbort = (): void => close();
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    socket.write(buildRequest(url, opts));

    // --- read the header block -------------------------------------------
    const deadline = Date.now() + timeoutMs;
    let headEnd = -1;
    let snapshot: Buffer = Buffer.alloc(0);
    for (;;) {
      snapshot = reader.snapshot(MAX_HEADER_BYTES + 4);
      headEnd = findHeadEnd(snapshot);
      if (headEnd !== -1) break;
      if (snapshot.length > MAX_HEADER_BYTES) {
        throw new RawHttpError('Response header block is implausibly large', 'protocol');
      }
      if (reader.error) {
        throw new RawHttpError(reader.error.message, 'network', networkCauseOf(reader.error));
      }
      if (reader.atEnd) {
        if (snapshot.length === 0) {
          throw new RawHttpError('Connection closed before any response was sent', 'network', 'reset');
        }
        throw new RawHttpError('Connection closed mid-header', 'network', 'reset');
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new RawHttpError(`No response headers after ${timeoutMs}ms`, 'timeout');
      }
      const before = reader.buffered;
      await reader.waitForMore(remaining);
      if (reader.buffered === before && !reader.atEnd && Date.now() >= deadline) {
        throw new RawHttpError(`No response headers after ${timeoutMs}ms`, 'timeout');
      }
    }

    const headBuf = reader.take(headEnd);
    const headText = headBuf.toString('latin1');
    const parsed = parseResponseHead(
      headText.replace(/\r\n\r\n$/, '').replace(/\n\n$/, ''),
    );

    const chunked = /chunked/i.test(parsed.headers['transfer-encoding'] ?? '');
    const clRaw = parsed.headers['content-length'];
    const contentLength =
      !chunked && clRaw !== undefined && /^\d+$/.test(clRaw.trim()) ? Number(clRaw.trim()) : null;

    const body = new BodyReader(reader, chunked, contentLength, bodyIdleMs);

    return {
      url: rawUrl,
      status: parsed.status,
      statusText: parsed.statusText,
      protocol: parsed.protocol,
      headers: parsed.headers,
      read: (maxBytes: number) => body.read(maxBytes),
      complete: () => body.complete,
      close: () => {
        opts.signal?.removeEventListener('abort', onAbort);
        close();
      },
    };
  } catch (err) {
    opts.signal?.removeEventListener('abort', onAbort);
    close();
    throw err instanceof RawHttpError
      ? err
      : new RawHttpError(err instanceof Error ? err.message : String(err), 'network', networkCauseOf(err));
  }
}
