/**
 * A minted session the <audio> element never fetches must not live for ever.
 *
 * `createSession` only records an intent; the socket opens when the renderer
 * sets `el.src`. If the renderer tunes away in between (or dies), nothing
 * ever claims the entry, and before the reaper `pending` grew by one for every
 * such tune for the life of the process.
 */
import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { ProxyServer } from '../../src/main/proxy/server';

const proxies: ProxyServer[] = [];

afterEach(async () => {
  for (const p of proxies.splice(0)) await p.stop();
});

function fetchStatus(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      resolve(res.statusCode ?? 0);
      res.resume();
      req.destroy();
    });
    req.on('error', reject);
  });
}

describe('an unclaimed proxy session', () => {
  it('is forgotten after the pending TTL, so a tune-away between mint and fetch leaks nothing', async () => {
    const proxy = new ProxyServer({ pendingTtlMs: 60, allowPrivateHosts: true });
    proxies.push(proxy);
    await proxy.start();
    const handle = proxy.createSession('http://127.0.0.1:1/never-fetched');
    await new Promise((r) => setTimeout(r, 150));
    // The entry is gone: the URL the renderer was handed no longer opens a session.
    expect(await fetchStatus(handle.url)).toBe(409);
    expect(proxy.listSessions()).toHaveLength(0);
  });

  it('is still honoured inside the TTL', async () => {
    const proxy = new ProxyServer({ pendingTtlMs: 60_000, allowPrivateHosts: true });
    proxies.push(proxy);
    await proxy.start();
    const handle = proxy.createSession('http://127.0.0.1:1/refused');
    await new Promise((r) => setTimeout(r, 50));
    // Claimed: the upstream refuses, which is a session that opened and failed,
    // not a session the proxy had already forgotten.
    expect(await fetchStatus(handle.url)).not.toBe(409);
  });
});
