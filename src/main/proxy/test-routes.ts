/**
 * The evidence channel.
 *
 * When PSPPCPR_TEST_HOOKS=1 the main process hangs these routes off the proxy's
 * loopback server, so an automated harness can screenshot the window and dump
 * the *real* PlaybackState without any UI scripting. They inherit the proxy's
 * loopback check and bearer token; the harness finds both in a small JSON file
 * written to userData (or PSPPCPR_TEST_HOOKS_FILE).
 *
 * Kept Electron-free — everything Electron-shaped arrives as a callback.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ProxyServer } from './server.js';

export interface TestHookDeps {
  /** PNG bytes of the app window. */
  capturePage(): Promise<Buffer>;
  /** Whatever the renderer last reported, verbatim. */
  playbackState(): unknown;
  appInfo(): unknown;
  quit(): void;
  /** Hide or show the app window: see the /test/window route. */
  setWindowVisible(visible: boolean): void;
  /**
   * Evaluate an expression in the renderer *as though a user had done it*, so
   * autoplay policy and every other user-activation gate behaves exactly as it
   * does for a real click. This is what lets a harness prove the shipped panel
   * works, rather than proving a parallel test-only path works.
   */
  executeJavaScript(code: string): Promise<unknown>;
}

export interface TestHookDescriptor {
  port: number;
  token: string;
  pid: number;
  base: string;
  routes: string[];
  writtenAt: number;
}

export function installTestHooks(
  proxy: ProxyServer,
  deps: TestHookDeps,
  descriptorPath: string,
): TestHookDescriptor {
  const json = (res: ServerResponse, status: number, body: unknown): void => {
    const text = JSON.stringify(body, null, 2);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
    });
    res.end(text);
  };

  proxy.route('/test/ping', (_req, res) => json(res, 200, { ok: true, pid: process.pid }));

  proxy.route('/test/state', (_req: IncomingMessage, res) =>
    json(res, 200, {
      at: Date.now(),
      app: deps.appInfo(),
      playbackState: deps.playbackState(),
      proxySessions: proxy.listSessions(),
    }),
  );

  proxy.route('/test/screenshot', async (_req, res, url) => {
    const png = await deps.capturePage();
    const out = url.searchParams.get('path');
    if (out) {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, png);
      json(res, 200, { ok: true, path: out, bytes: png.length });
      return;
    }
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length });
    res.end(png);
  });

  proxy.route('/test/exec', async (req: IncomingMessage, res) => {
    if (req.method !== 'POST') {
      json(res, 405, { ok: false, error: 'POST the expression to evaluate' });
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const code = Buffer.concat(chunks).toString('utf8');
    try {
      const value = await deps.executeJavaScript(code);
      json(res, 200, { ok: true, value });
    } catch (err) {
      json(res, 200, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Put the window out of sight, or bring it back.
   *
   * The battery behaviour of this app turns on one question — is anybody
   * looking? — and there is no other way for a harness to ask it. A headless X
   * server has no window manager to minimise with, and an XUnmapWindow issued
   * from outside is invisible to Chromium, which tracks its own widget state
   * rather than the server's map state: measured, the window vanished from the
   * screen and the needle carried on turning at frame rate.
   *
   * `hide` is what the window itself does when it is minimised, so this drives
   * exactly the production path — BrowserWindow event, attention push, parked
   * drawing loops — with the harness standing in for the hand.
   */
  proxy.route('/test/window', (_req, res, url) => {
    const state = url.searchParams.get('state');
    if (state !== 'hidden' && state !== 'shown') {
      json(res, 400, { ok: false, error: 'state must be hidden or shown' });
      return;
    }
    deps.setWindowVisible(state === 'shown');
    json(res, 200, { ok: true, state });
  });

  proxy.route('/test/quit', (_req, res) => {
    json(res, 200, { ok: true });
    setTimeout(() => deps.quit(), 50);
  });

  const { port, token } = proxy.address;
  const descriptor: TestHookDescriptor = {
    port,
    token,
    pid: process.pid,
    base: `http://127.0.0.1:${port}`,
    routes: [
      '/test/ping',
      '/test/state',
      '/test/screenshot',
      '/test/exec',
      '/test/window',
      '/test/quit',
    ],
    writtenAt: Date.now(),
  };
  fs.mkdirSync(path.dirname(descriptorPath), { recursive: true });
  fs.writeFileSync(descriptorPath, JSON.stringify(descriptor, null, 2));
  return descriptor;
}
