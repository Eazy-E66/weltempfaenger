/**
 * The local stream proxy.
 *
 * Chromium will happily play an Icecast URL in an <audio> element, but two
 * things break without this hop:
 *   1. Icecast sends no CORS headers, so createMediaElementSource() yields a
 *      *tainted* node whose output is silence — no volume, no tone, no meter.
 *   2. Chromium never exposes ICY metadata, so "now playing" is unobtainable.
 *
 * So we terminate the upstream here, strip the interleaved metadata, and re-serve
 * pure audio from 127.0.0.1 with `Access-Control-Allow-Origin: *`.
 *
 * It must never become an open relay: loopback peers only, per-session bearer
 * token, Host pinned to the listening socket, and private upstream targets
 * refused.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { AddressInfo } from 'node:net';
import { EventEmitter } from 'node:events';
import { StreamSession } from './session.js';
import type {
  ProxyEvent,
  ProxyHandle,
  ProxyMetadata,
  ProxySessionOptions,
  ProxySessionStats,
} from './types.js';

export interface ProxyServerOptions {
  /** Permit upstreams on loopback/private ranges. Tests only. */
  allowPrivateHosts?: boolean;
  stallTimeoutMs?: number;
  maxRedirects?: number;
  host?: string;
}

export interface ProxyServerEvents {
  metadata: [ProxyMetadata];
  stats: [ProxySessionStats];
  event: [ProxyEvent];
}

export type ExtraRoute = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
) => void | Promise<void>;

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export class ProxyServer extends EventEmitter<ProxyServerEvents> {
  private server?: http.Server;
  private readonly sessions = new Map<string, StreamSession>();
  /** Sessions handed out but not yet connected by the <audio> element. */
  private readonly pending = new Map<string, { url: string; prerollSeconds: number }>();
  private readonly routes = new Map<string, ExtraRoute>();
  private statsTimer?: NodeJS.Timeout;

  readonly token = crypto.randomBytes(24).toString('hex');
  private port = 0;

  constructor(private readonly opts: ProxyServerOptions = {}) {
    super();
  }

  async start(): Promise<{ port: number; token: string }> {
    if (this.server) return { port: this.port, token: this.token };
    const server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    // Live sockets must die with the process; do not let keep-alive linger.
    server.keepAliveTimeout = 0;
    server.headersTimeout = 10_000;
    server.requestTimeout = 0; // an endless body is not a slow-loris

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, this.opts.host ?? '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    this.statsTimer = setInterval(() => this.pumpStats(), 200);
    this.statsTimer.unref?.();
    return { port: this.port, token: this.token };
  }

  /** Register an auxiliary loopback route (used for the test-hook channel). */
  route(path: string, handler: ExtraRoute): void {
    this.routes.set(path, handler);
  }

  get listening(): boolean {
    return this.server !== undefined;
  }

  get address(): { port: number; token: string } {
    return { port: this.port, token: this.token };
  }

  /**
   * Mint a session. Nothing connects yet — the socket opens when the renderer's
   * <audio> element fetches the returned URL.
   */
  createSession(upstreamUrl: string, opts: ProxySessionOptions = {}): ProxyHandle {
    if (!this.server) throw new Error('proxy not started');
    const sessionId = crypto.randomBytes(9).toString('hex');
    const prerollSeconds = clampPreroll(opts.prerollSeconds);
    this.pending.set(sessionId, { url: upstreamUrl, prerollSeconds });
    const url =
      `http://127.0.0.1:${this.port}/stream` +
      `?u=${encodeURIComponent(upstreamUrl)}` +
      `&t=${this.token}&s=${sessionId}&p=${prerollSeconds}`;
    return { url, sessionId, port: this.port, prerollSeconds };
  }

  closeSession(sessionId: string, reason = 'tuned away'): void {
    this.pending.delete(sessionId);
    this.sessions.get(sessionId)?.destroy(reason);
    this.sessions.delete(sessionId);
  }

  closeAllSessions(reason = 'shutdown'): void {
    for (const id of [...this.sessions.keys()]) this.closeSession(id, reason);
    this.pending.clear();
  }

  statsFor(sessionId: string): ProxySessionStats | undefined {
    return this.sessions.get(sessionId)?.stats();
  }

  listSessions(): ProxySessionStats[] {
    return [...this.sessions.values()].map((s) => s.stats());
  }

  async stop(): Promise<void> {
    clearInterval(this.statsTimer);
    this.closeAllSessions();
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections?.();
  }

  // -------------------------------------------------------------------------

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const peer = req.socket.remoteAddress ?? '';
    if (!LOOPBACK.has(peer)) {
      this.deny(res, 403, 'loopback only');
      req.socket.destroy();
      return;
    }
    // Blocks DNS-rebinding: a page on some.evil.host resolving to 127.0.0.1
    // would send its own Host header.
    const host = (req.headers.host ?? '').toLowerCase();
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) {
      this.deny(res, 403, 'bad host');
      return;
    }

    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);

    if (!timingSafeEqual(url.searchParams.get('t') ?? '', this.token)) {
      this.deny(res, 401, 'bad token');
      return;
    }

    const extra = this.routes.get(url.pathname);
    if (extra) {
      try {
        await extra(req, res, url);
      } catch (err) {
        if (!res.headersSent) this.deny(res, 500, (err as Error).message);
        else res.destroy();
      }
      return;
    }

    if (url.pathname !== '/stream') {
      this.deny(res, 404, 'not found');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      this.deny(res, 405, 'GET only');
      return;
    }

    const sessionId = url.searchParams.get('s') ?? '';
    const upstreamUrl = url.searchParams.get('u') ?? '';
    const minted = this.pending.get(sessionId);
    if (!minted || minted.url !== upstreamUrl) {
      // Unknown or already-consumed session: refuse rather than open a socket to
      // an arbitrary URL that merely carried a valid token.
      this.deny(res, 409, 'unknown session');
      return;
    }
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'access-control-allow-origin': '*' });
      res.end();
      return;
    }

    this.pending.delete(sessionId);
    this.sessions.get(sessionId)?.destroy('superseded');

    const session = new StreamSession({
      sessionId,
      url: upstreamUrl,
      allowPrivateHosts:
        this.opts.allowPrivateHosts ?? process.env.PSPPCPR_PROXY_ALLOW_PRIVATE === '1',
      stallTimeoutMs: this.opts.stallTimeoutMs ?? 4_000,
      maxRedirects: this.opts.maxRedirects ?? 5,
      prerollSeconds: minted.prerollSeconds,
    });
    this.sessions.set(sessionId, session);

    session.on('metadata', (m) => this.emit('metadata', m));
    session.on('open', (info) =>
      this.emit('event', { sessionId, kind: 'open', at: Date.now(), message: info.finalUrl }),
    );
    session.on('stall', () => this.emit('event', { sessionId, kind: 'stall', at: Date.now() }));
    session.on('resume', () => this.emit('event', { sessionId, kind: 'resume', at: Date.now() }));
    session.on('close', ({ reason, graceful, detail }) => {
      this.emit('stats', session.stats());
      this.emit('event', {
        sessionId,
        kind: 'closed',
        graceful,
        // `message` is what the panel is allowed to read; `detail` is the
        // transport's own words, for a diagnostic and for nothing else.
        message: reason,
        ...(detail === undefined ? {} : { detail }),
        at: Date.now(),
      });
      if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId);
    });

    await session.run(res);
  }

  private pumpStats(): void {
    for (const session of this.sessions.values()) {
      if (!session.isClosed) this.emit('stats', session.stats());
    }
  }

  private deny(res: http.ServerResponse, status: number, message: string): void {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(message);
  }
}

/** 0..30 s. A pre-roll deeper than this is a memory hazard, not a feature. */
function clampPreroll(seconds: number | undefined): number {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return 0;
  return Math.min(30, Math.max(0, seconds));
}

function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
