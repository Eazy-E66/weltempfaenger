/**
 * In-process servers that make every network case in the offline suite
 * deterministic.
 *
 * The playlist bodies are real files under test/fixtures — they are what a
 * station actually hands you — but a file cannot know which ephemeral port the
 * test bound to, so every fixture writes `{{BASE}}` where a base URL belongs
 * and the server substitutes it on the way out. The files stay honest and
 * inspectable; the ports stay dynamic.
 *
 * `startIcyServer` is a raw TCP server rather than an http.Server because the
 * whole point of that case is a response Node's own HTTP layer refuses to
 * produce: a status line reading `ICY 200 OK`.
 */

import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.resolve(HERE, '..', 'fixtures');

export function fixturePath(...parts: string[]): string {
  return path.join(FIXTURES, ...parts);
}

export async function readFixture(...parts: string[]): Promise<Buffer> {
  return readFile(fixturePath(...parts));
}

// ---------------------------------------------------------------------------
// Synthetic audio payloads
// ---------------------------------------------------------------------------

function pad(head: number[], total: number): Buffer {
  const buf = Buffer.alloc(total, 0x5a);
  Buffer.from(head).copy(buf, 0);
  return buf;
}

/** MPEG-1 Layer III frame sync (0xFF 0xFB). */
export function mp3Bytes(total = 2048): Buffer {
  return pad([0xff, 0xfb, 0x90, 0x00], total);
}

/** ADTS AAC syncword (0xFF 0xF1). */
export function aacBytes(total = 2048): Buffer {
  return pad([0xff, 0xf1, 0x50, 0x80, 0x00, 0x1f, 0xfc], total);
}

/** Ogg page header. */
export function oggBytes(total = 2048): Buffer {
  return pad([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00, 0x00], total);
}

// ---------------------------------------------------------------------------
// HTTP fixture server
// ---------------------------------------------------------------------------

export interface FixtureServer {
  /** e.g. `http://127.0.0.1:41234` */
  base: string;
  /** Every path requested, in order. Lets tests assert on redirect chains. */
  requests: string[];
  close(): Promise<void>;
}

const PLAYLIST_TYPES: Record<string, string> = {
  '.pls': 'audio/x-scpls',
  '.m3u': 'audio/x-mpegurl',
  '.m3u8': 'application/vnd.apple.mpegurl',
};

async function servePlaylist(
  res: ServerResponse,
  base: string,
  name: string,
  opts: { chunked?: boolean; contentType?: string } = {},
): Promise<void> {
  let raw: Buffer;
  try {
    raw = await readFixture('playlists', name);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('no such fixture');
    return;
  }
  const body = raw.toString('utf8').split('{{BASE}}').join(base);
  const type = opts.contentType ?? PLAYLIST_TYPES[path.extname(name)] ?? 'application/octet-stream';
  if (opts.chunked) {
    // No content-length: forces the client through the chunked decoder.
    res.writeHead(200, { 'content-type': type, 'transfer-encoding': 'chunked' });
    // Split mid-file so the chunk boundaries are not aligned to anything useful.
    const half = Math.floor(body.length / 2);
    res.write(body.slice(0, half));
    res.write(body.slice(half));
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': type, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function serveAudio(res: ServerResponse, body: Buffer, contentType: string | null, icy = true): void {
  const headers: Record<string, string> = {};
  if (contentType) headers['content-type'] = contentType;
  if (icy) {
    headers['icy-name'] = 'Fixture Stream';
    headers['icy-br'] = '128';
    headers['icy-genre'] = 'Ambient';
    headers['icy-metaint'] = '8192';
  }
  headers['content-length'] = String(body.length);
  res.writeHead(200, headers);
  res.end(body);
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const requests: string[] = [];
  let base = '';

  const server: Server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';
    requests.push(url);
    void handle(url, res, base);
  });

  async function handle(url: string, res: ServerResponse, baseUrl: string): Promise<void> {
    const [pathname = '/'] = url.split('?');

    // --- playlists ------------------------------------------------------
    const pl = /^\/pl\/(.+)$/.exec(pathname);
    if (pl) {
      await servePlaylist(res, baseUrl, pl[1]!);
      return;
    }
    const chunked = /^\/pl-chunked\/(.+)$/.exec(pathname);
    if (chunked) {
      await servePlaylist(res, baseUrl, chunked[1]!, { chunked: true });
      return;
    }
    // A playlist served under a content-type that claims it is a live stream.
    const mistyped = /^\/pl-as-audio\/(.+)$/.exec(pathname);
    if (mistyped) {
      await servePlaylist(res, baseUrl, mistyped[1]!, { contentType: 'audio/mpeg' });
      return;
    }

    // --- audio ----------------------------------------------------------
    switch (pathname) {
      case '/audio/mp3':
        return serveAudio(res, mp3Bytes(), 'audio/mpeg');
      case '/audio/aac':
        return serveAudio(res, aacBytes(), 'audio/aac');
      case '/audio/ogg':
        return serveAudio(res, oggBytes(), 'application/ogg');
      case '/audio/no-metadata':
        return serveAudio(res, mp3Bytes(), 'audio/mpeg', false);
      case '/audio/no-content-type':
        // Server omits content-type entirely; only the bytes can save us.
        return serveAudio(res, mp3Bytes(), null);
      case '/audio/lying-html':
        // Content-type says web page, body is unmistakably MP3.
        return serveAudio(res, mp3Bytes(), 'text/html');
      case '/audio/x-mpegurl-stream':
        // The documented edge case: a live stream served as audio/x-mpegurl.
        return serveAudio(res, mp3Bytes(), 'audio/x-mpegurl');
      default:
        break;
    }
    if (pathname.startsWith('/hls/segment-')) {
      // Real AAC. If the resolver ever treats an HLS manifest as a plain M3U it
      // will "succeed" here, which is exactly the silent failure we forbid.
      return serveAudio(res, aacBytes(), 'audio/aac');
    }

    // --- redirects ------------------------------------------------------
    const hop = /^\/redirect\/(\d+)$/.exec(pathname);
    if (hop) {
      const n = Number(hop[1]);
      const next = n <= 1 ? '/audio/mp3' : `/redirect/${n - 1}`;
      res.writeHead(302, { location: next });
      res.end();
      return;
    }
    if (pathname === '/redirect-loop/a') {
      res.writeHead(302, { location: '/redirect-loop/b' });
      res.end();
      return;
    }
    if (pathname === '/redirect-loop/b') {
      res.writeHead(302, { location: '/redirect-loop/a' });
      res.end();
      return;
    }
    if (pathname === '/redirect-relative') {
      res.writeHead(301, { location: 'audio/mp3' });
      res.end();
      return;
    }

    // --- failures -------------------------------------------------------
    if (pathname === '/html') {
      const body = await readFixture('html', 'parking-page.html');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length });
      res.end(body);
      return;
    }
    if (pathname === '/garbage') {
      const body = await readFixture('binary', 'garbage.bin');
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length });
      res.end(body);
      return;
    }
    if (pathname === '/truncated') {
      // Promises 4096 bytes, sends 24, then hangs up mid-body. The destroy is
      // deferred to the write callback so the header block is guaranteed to
      // have reached the client first -- otherwise this would just be a
      // connection failure and would prove nothing about truncation.
      const body = await readFixture('binary', 'garbage.bin');
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': '4096' });
      res.write(body.subarray(0, 24), () => {
        res.socket?.destroy();
      });
      return;
    }
    const status = /^\/status\/(\d{3})$/.exec(pathname);
    if (status) {
      res.writeHead(Number(status[1]), { 'content-type': 'text/plain' });
      res.end('nope');
      return;
    }
    if (pathname === '/slow') {
      // Accepts the request and then says nothing at all, ever.
      return;
    }
    if (pathname === '/hangup') {
      res.socket?.destroy();
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server did not bind a port');
  base = `http://127.0.0.1:${address.port}`;

  return {
    base,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

// ---------------------------------------------------------------------------
// Raw SHOUTcast (ICY) server
// ---------------------------------------------------------------------------

export interface IcyServer extends FixtureServer {
  /** Number of connections accepted. */
  connections(): number;
}

/**
 * Answers with a literal `ICY 200 OK` status line, which is what SHOUTcast v1
 * servers have always done and what Node's HTTP parser refuses to accept.
 *
 * Two paths:
 *   /crlf — the head from the fixture with CRLF line endings (the common case)
 *   /lf   — the same head with bare LF endings, which some old builds emit
 */
export async function startIcyServer(): Promise<IcyServer> {
  const requests: string[] = [];
  let accepted = 0;
  const head = (await readFixture('raw', 'icy-200-ok.head.txt')).toString('utf8').trimEnd();

  const server: TcpServer = createTcpServer((socket: Socket) => {
    accepted++;
    let buffered = '';
    socket.on('error', () => {
      /* client hang-ups are expected; the resolver never reads the whole stream */
    });
    socket.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('latin1');
      const end = buffered.indexOf('\r\n\r\n');
      if (end === -1) return;
      const requestLine = buffered.split('\r\n')[0] ?? '';
      const target = requestLine.split(' ')[1] ?? '/';
      requests.push(target);

      const eol = target.startsWith('/lf') ? '\n' : '\r\n';
      const lines = head.split('\n');
      socket.write(Buffer.from(lines.join(eol) + eol + eol, 'latin1'));
      socket.write(mp3Bytes(4096));
      // Left open, exactly like a real station: an endless stream with no EOF.
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('icy server did not bind a port');

  return {
    base: `http://127.0.0.1:${address.port}`,
    requests,
    connections: () => accepted,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Sockets are deliberately left open by the handler; force them shut.
        server.unref();
        resolve();
      }),
  };
}

// ---------------------------------------------------------------------------
// Minimal JSON API server (for the directory provider tests)
// ---------------------------------------------------------------------------

export interface JsonServer extends FixtureServer {
  /** Paths that should fail, and how. Mutate between assertions. */
  failures: Map<string, 'refuse' | 'error' | 'garbage' | 'hang'>;
}

/** Serves the Radio Browser fixture JSON under the real API's paths. */
export async function startJsonServer(): Promise<JsonServer> {
  const requests: string[] = [];
  const failures = new Map<string, 'refuse' | 'error' | 'garbage' | 'hang'>();

  const server = createHttpServer((req, res) => {
    const url = req.url ?? '/';
    requests.push(`${req.method ?? 'GET'} ${url}`);
    const [pathname = '/'] = url.split('?');

    const failure = failures.get(pathname) ?? failures.get('*');
    if (failure === 'refuse') {
      res.socket?.destroy();
      return;
    }
    if (failure === 'error') {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('mirror overloaded');
      return;
    }
    if (failure === 'garbage') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('<html>captive portal</html>');
      return;
    }
    if (failure === 'hang') return;

    void (async () => {
      try {
        if (pathname === '/json/servers') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(await readFixture('radiobrowser', 'servers.json'));
          return;
        }
        if (pathname === '/json/tags') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(await readFixture('radiobrowser', 'tags.json'));
          return;
        }
        // Geography: the tag filter asks the directory which names are places
        // rather than hardcoding an atlas, so the fixture has to answer.
        if (pathname === '/json/countries') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(await readFixture('radiobrowser', 'countries.json'));
          return;
        }
        if (pathname === '/json/states') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(await readFixture('radiobrowser', 'states.json'));
          return;
        }
        // The register files by tongue as well as by subject and origin.
        if (pathname === '/json/languages') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(await readFixture('radiobrowser', 'languages.json'));
          return;
        }
        // The colophon's numbers. Best-effort in the provider, so a test that
        // fails this path is testing a degraded edition, not a broken one.
        if (pathname === '/json/stats') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ stations: 61846, tags: 11809, countries: 241, languages: 646 }));
          return;
        }
        if (pathname === '/json/stations/search') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(await readFixture('radiobrowser', 'stations-jazz.json'));
          return;
        }
        if (pathname.startsWith('/json/url/')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, message: 'retrieved station url' }));
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"ok":false}');
      } catch (err) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(String(err));
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('json server did not bind a port');

  return {
    base: `http://127.0.0.1:${address.port}`,
    requests,
    failures,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
