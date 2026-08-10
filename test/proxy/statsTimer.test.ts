/**
 * The proxy's stats pump, and when it is allowed to exist.
 *
 * `pumpStats` pushes the byte/stall counters of live sessions to the renderer at
 * 5 Hz. It used to be armed in `start()` and cleared only in `stop()` — that is,
 * for the whole life of the application, whether or not there was a session. In
 * cold standby `sessions` is empty, so that was five main-process wakeups a
 * second, eighteen thousand an hour, to iterate an empty Map and emit nothing at
 * all. `unref()` does not help and was never meant to: an unrefed timer fires on
 * schedule exactly like any other, it merely declines to hold the event loop
 * open at exit.
 *
 * The rule these pin is the engine's own (`syncTicker`): poll while there is
 * something to observe, and not otherwise. So the assertions are in two halves —
 * the pump must not exist with no session, and it must still do its whole job
 * the moment one appears.
 *
 * Everything below runs against the real ProxyServer over real loopback sockets,
 * with a real upstream that streams until the test lets go of it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ProxyServer } from '../../src/main/proxy/server';
import type { ProxySessionStats } from '../../src/main/proxy/types';

/** MPEG-1 Layer III frame sync, so the sniffer is satisfied. */
const MP3 = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(2044, 0x5a)]);

/** An upstream that keeps sending until the test stops it. */
interface Upstream {
  url: string;
  close(): Promise<void>;
}

async function startUpstream(): Promise<Upstream> {
  const open = new Set<http.ServerResponse>();
  const timers = new Set<NodeJS.Timeout>();
  const server = http.createServer((_req, res) => {
    open.add(res);
    res.writeHead(200, { 'content-type': 'audio/mpeg' });
    res.write(MP3);
    const t = setInterval(() => {
      if (!res.writableEnded) res.write(MP3);
    }, 25);
    timers.add(t);
    res.on('close', () => {
      clearInterval(t);
      timers.delete(t);
      open.delete(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/stream.mp3`,
    close: async () => {
      for (const t of timers) clearInterval(t);
      for (const res of open) res.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** The private handle, read directly: its existence is the whole property. */
const pumping = (proxy: ProxyServer): boolean =>
  (proxy as unknown as { statsTimer?: NodeJS.Timeout }).statsTimer !== undefined;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('the proxy stats pump', () => {
  let proxy: ProxyServer;
  let upstream: Upstream;
  let base: { port: number; token: string };

  beforeEach(async () => {
    upstream = await startUpstream();
    proxy = new ProxyServer({ allowPrivateHosts: true });
    base = await proxy.start();
  });

  afterEach(async () => {
    await proxy.stop();
    await upstream.close();
  });

  it('does not exist in standby: a listening proxy with no session polls nothing', async () => {
    expect(proxy.listening).toBe(true);
    expect(pumping(proxy)).toBe(false);

    // And it does not quietly arm itself later.
    await sleep(400);
    expect(pumping(proxy)).toBe(false);
  });

  it('is not armed by minting a session that nothing has connected to yet', () => {
    // `createSession` hands out a URL; the socket opens when the <audio> element
    // fetches it. Until then there is still nothing to report on.
    proxy.createSession(upstream.url);
    expect(pumping(proxy)).toBe(false);
  });

  it('arms the moment a session really connects, and still reports at 5 Hz', async () => {
    const handle = proxy.createSession(upstream.url);
    const seen: ProxySessionStats[] = [];
    proxy.on('stats', (s) => seen.push(s));

    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.get(handle.url, resolve);
      req.on('error', reject);
    });
    res.resume();
    await sleep(150);

    expect(pumping(proxy)).toBe(true);

    // The pump's actual job, unchanged: roughly five pushes a second.
    seen.length = 0;
    await sleep(1000);
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen.every((s) => s.sessionId === handle.sessionId)).toBe(true);

    res.destroy();
  });

  it('disarms when the last session goes, and re-arms for the next one', async () => {
    const first = proxy.createSession(upstream.url);
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.get(first.url, resolve);
      req.on('error', reject);
    });
    res.resume();
    await sleep(150);
    expect(pumping(proxy)).toBe(true);

    proxy.closeSession(first.sessionId);
    expect(pumping(proxy)).toBe(false);
    res.destroy();

    // Tuning to the next station brings it straight back.
    const second = proxy.createSession(upstream.url);
    const res2 = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.get(second.url, resolve);
      req.on('error', reject);
    });
    res2.resume();
    await sleep(150);
    expect(pumping(proxy)).toBe(true);

    proxy.closeAllSessions();
    expect(pumping(proxy)).toBe(false);
    res2.destroy();
  });

  it('leaves nothing armed after stop()', async () => {
    const handle = proxy.createSession(upstream.url);
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.get(handle.url, resolve);
      req.on('error', reject);
    });
    res.resume();
    await sleep(150);
    expect(pumping(proxy)).toBe(true);

    res.destroy();
    await proxy.stop();
    expect(pumping(proxy)).toBe(false);
  });
});
