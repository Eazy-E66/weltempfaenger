/**
 * Upstream stream client.
 *
 * Deliberately built on raw sockets rather than `http.request`: SHOUTcast v1
 * servers answer with a status line of `ICY 200 OK`, which is not valid HTTP and
 * which Node's parser rejects outright (HPE_INVALID_CONSTANT). Speaking the
 * protocol by hand also keeps the byte stream untouched, which matters because
 * the ICY demuxer downstream is position-sensitive.
 */

import net from 'node:net';
import tls from 'node:tls';
import { URL } from 'node:url';
import type { HeaderBag } from './icy.js';

export const USER_AGENT = 'Weltempfaenger/0.1 (PSPPCPR; +https://localhost) NSPlayer/ICY';

export interface UpstreamOptions {
  /** Hard cap on redirect hops. */
  maxRedirects?: number;
  /** Milliseconds to wait for the response headers. */
  headerTimeoutMs?: number;
  /** Allow upstreams on loopback/private addresses. Off outside tests: SSRF guard. */
  allowPrivateHosts?: boolean;
  signal?: AbortSignal;
}

export interface UpstreamConnection {
  url: string;
  statusCode: number;
  statusText: string;
  /** Lower-cased header names. */
  headers: HeaderBag;
  /** True when the status line was `ICY 200 OK` rather than HTTP. */
  icyProtocol: boolean;
  /** Body bytes that arrived in the same TCP segment as the headers. */
  leftover: Buffer;
  socket: net.Socket;
  redirects: string[];
}

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly kind: 'network' | 'http' | 'timeout' | 'too-many-redirects' | 'blocked' | 'aborted',
    readonly status?: number,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

const PRIVATE_V4 =
  /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (net.isIPv4(h)) return PRIVATE_V4.test(h);
  if (net.isIPv6(h)) {
    if (h === '::1' || h === '::') return true;
    if (h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
    if (mapped) return PRIVATE_V4.test(mapped[1]!);
  }
  return false;
}

/** Opens the stream and returns as soon as the response headers are complete. */
export async function openUpstream(
  rawUrl: string,
  opts: UpstreamOptions = {},
): Promise<UpstreamConnection> {
  const maxRedirects = opts.maxRedirects ?? 5;
  const redirects: string[] = [];
  let current = rawUrl;

  for (let hop = 0; ; hop++) {
    const res = await requestOnce(current, opts);
    const location = res.headers['location'];
    const isRedirect = [301, 302, 303, 307, 308].includes(res.statusCode) && location;

    if (!isRedirect) {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.socket.destroy();
        throw new UpstreamError(
          `upstream returned ${res.statusCode} ${res.statusText}`,
          'http',
          res.statusCode,
        );
      }
      return { ...res, redirects };
    }

    res.socket.destroy();
    if (hop >= maxRedirects) {
      throw new UpstreamError(`more than ${maxRedirects} redirects`, 'too-many-redirects');
    }
    current = new URL(location!, current).toString();
    redirects.push(current);
  }
}

type RawResponse = Omit<UpstreamConnection, 'redirects'>;

function requestOnce(rawUrl: string, opts: UpstreamOptions): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      reject(new UpstreamError(`not a URL: ${rawUrl}`, 'network'));
      return;
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      reject(new UpstreamError(`unsupported protocol ${url.protocol}`, 'blocked'));
      return;
    }
    if (!opts.allowPrivateHosts && isPrivateHost(url.hostname)) {
      reject(new UpstreamError(`refusing to proxy private host ${url.hostname}`, 'blocked'));
      return;
    }

    const secure = url.protocol === 'https:';
    const port = url.port ? Number(url.port) : secure ? 443 : 80;
    const socket = secure
      ? tls.connect({ host: url.hostname, port, servername: url.hostname })
      : net.connect({ host: url.hostname, port });

    let settled = false;
    let buffer: Buffer = Buffer.alloc(0);

    const headerTimeout = opts.headerTimeoutMs ?? 12_000;
    const timer = setTimeout(() => {
      fail(new UpstreamError(`no response headers within ${headerTimeout}ms`, 'timeout'));
    }, headerTimeout);

    const onAbort = () => fail(new UpstreamError('aborted', 'aborted'));
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    function cleanup(): void {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
    }

    function fail(err: UpstreamError): void {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(err);
    }

    function onError(err: Error): void {
      fail(new UpstreamError(err.message, 'network'));
    }

    function onClose(): void {
      fail(new UpstreamError('upstream closed before sending headers', 'network'));
    }

    function onData(chunk: Buffer): void {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      const end = findHeaderEnd(buffer);
      if (end < 0) {
        if (buffer.length > 64 * 1024) fail(new UpstreamError('response headers too large', 'network'));
        return;
      }
      settled = true;
      cleanup();
      let parsed: { statusCode: number; statusText: string; headers: HeaderBag; icyProtocol: boolean };
      try {
        parsed = parseResponseHead(buffer.subarray(0, end).toString('latin1'));
      } catch (e) {
        socket.destroy();
        reject(new UpstreamError((e as Error).message, 'network'));
        return;
      }
      socket.pause();
      resolve({
        url: url.toString(),
        ...parsed,
        leftover: buffer.subarray(headerBodyStart(buffer, end)),
        socket,
      });
    }

    socket.on('error', onError);
    socket.on('close', onClose);
    socket.on('data', onData);
    socket.on(secure ? 'secureConnect' : 'connect', () => {
      const path = `${url.pathname}${url.search}`;
      const head =
        `GET ${path === '' ? '/' : path} HTTP/1.1\r\n` +
        `Host: ${url.host}\r\n` +
        `User-Agent: ${USER_AGENT}\r\n` +
        `Accept: */*\r\n` +
        `Icy-MetaData: 1\r\n` +
        `Accept-Encoding: identity\r\n` +
        `Connection: close\r\n\r\n`;
      socket.write(head);
    });
  });
}

/** Index of the first byte of the header terminator, or -1. */
function findHeaderEnd(buf: Buffer): number {
  const crlf = buf.indexOf('\r\n\r\n', 0, 'latin1');
  const lf = buf.indexOf('\n\n', 0, 'latin1');
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) return crlf;
  return lf;
}

function headerBodyStart(buf: Buffer, end: number): number {
  return buf.subarray(end, end + 4).toString('latin1') === '\r\n\r\n' ? end + 4 : end + 2;
}

export function parseResponseHead(head: string): {
  statusCode: number;
  statusText: string;
  headers: HeaderBag;
  icyProtocol: boolean;
} {
  const lines = head.split(/\r?\n/);
  const statusLine = lines.shift() ?? '';
  // `HTTP/1.1 200 OK` or the SHOUTcast v1 dialect `ICY 200 OK`.
  const m = /^(ICY|HTTP\/\d(?:\.\d)?)\s+(\d{3})\s*(.*)$/i.exec(statusLine.trim());
  if (!m) throw new Error(`unparseable status line: ${JSON.stringify(statusLine.slice(0, 120))}`);

  const headers: HeaderBag = {};
  let lastKey = '';
  for (const line of lines) {
    if (line === '') continue;
    if (/^[ \t]/.test(line) && lastKey) {
      headers[lastKey] += ` ${line.trim()}`;
      continue;
    }
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    lastKey = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    // Repeated headers: keep the first, except set-cookie which we ignore anyway.
    if (headers[lastKey] === undefined) headers[lastKey] = value;
  }

  return {
    statusCode: Number.parseInt(m[2]!, 10),
    statusText: m[3]!.trim(),
    headers,
    icyProtocol: m[1]!.toUpperCase() === 'ICY',
  };
}
