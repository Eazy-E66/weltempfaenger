#!/usr/bin/env node
/**
 * Launch smoke test for the PACKAGED Weltempfänger app.
 *
 * WHY THIS EXISTS
 * ---------------
 * `npm test` proves the modules behave. `npx electron-builder` proves a file
 * came out. Neither proves the shipped binary *starts*, opens a window, and
 * gets a renderer onto it — which is the only claim a user actually cares
 * about, and the one claim nobody could make about the Windows and macOS
 * artifacts because the dev box is Linux. This script makes that claim
 * checkable on any of the three platforms, in CI, without a human looking at a
 * screen.
 *
 * HOW IT PROVES IT
 * ----------------
 * The app already carries an evidence channel (src/main/proxy/test-routes.ts).
 * With PSPPCPR_TEST_HOOKS=1 the main process hangs /test/ping, /test/state,
 * /test/exec, /test/screenshot and /test/quit off its loopback proxy and writes
 * a descriptor JSON — {port, token, pid, base, routes, writtenAt} — to
 * PSPPCPR_TEST_HOOKS_FILE. This script:
 *
 *   1. launches the packaged binary with an ISOLATED --user-data-dir,
 *   2. waits for the descriptor file to appear,
 *   3. polls  GET  /test/ping         until the main process answers,
 *   4. reads  GET  /test/state        and checks version/platform/testHooks and
 *                                     that userData really is the throwaway dir,
 *   5. POSTs       /test/exec         an expression that only evaluates inside a
 *                                     live renderer with the real faceplate DOM
 *                                     mounted — this is what proves a window
 *                                     with a renderer process exists, not just
 *                                     a main process with a listening socket,
 *   6. POSTs       /test/exec         a sentinel PlaybackState through the real
 *                                     preload bridge and waits for the RENDERER
 *                                     to overwrite it — proving renderer ->
 *                                     preload -> IPC -> main is live, which a
 *                                     broken preload breaks silently while the
 *                                     window still paints,
 *   7. calls  GET  /test/screenshot   and validates the PNG signature, byte
 *                                     count and IHDR dimensions — the strongest
 *                                     available "the window was really on
 *                                     screen and had pixels in it" evidence,
 *   8. calls  GET  /test/quit         and waits for the process to actually go.
 *
 * AUTHENTICATION — READ THIS BEFORE EDITING
 * -----------------------------------------
 * The proxy's bearer token is NOT a header. src/main/proxy/server.ts checks
 * `url.searchParams.get('t')` against the token with a timing-safe compare, and
 * it does that for EVERY route including the /test/* ones. It also pins the
 * Host header to `127.0.0.1:<port>` or `localhost:<port>` (anti DNS-rebinding)
 * and refuses any peer that is not loopback. So: request 127.0.0.1 by IP, let
 * Node set Host itself, and put `?t=<token>` on every single URL. Anything else
 * is a 401 or a 403.
 *
 * USAGE
 *   node tools/smoke.mjs [app-path] [options]
 *
 *   app-path              Binary / .AppImage / .app / mac .zip to launch.
 *                         Omitted -> auto-discovery under release/ for the
 *                         current platform (see discoverApp below).
 *
 *   --app=<path>          Same as the positional argument.
 *   --timeout=<dur>       Overall budget for "app answers and renderer is up".
 *                         Accepts 60, 60s, 90000ms. Default 60s.
 *   --screenshot=<path>   Keep the window PNG here instead of throwing it away
 *                         with the temp profile.
 *   --json                Also print the collected evidence as JSON.
 *   --display=<:N>        Force DISPLAY for the child (Linux; handy when you
 *                         have your own Xvfb/Xephyr running).
 *   --keep-profile        Do not delete the temp --user-data-dir (for debugging).
 *   --no-sandbox          Force --no-sandbox. Same as SMOKE_NO_SANDBOX=1.
 *   -h, --help            This text.
 *
 * ENVIRONMENT
 *   SMOKE_APP             Default app path.
 *   SMOKE_TIMEOUT_MS      Default timeout in ms.
 *   SMOKE_NO_SANDBOX=1    Pass --no-sandbox to the app. Needed in most CI
 *                         containers, because release/linux-unpacked/ ships
 *                         chrome-sandbox WITHOUT the setuid bit (only the deb
 *                         and AppImage get 4755), and Ubuntu 24 additionally
 *                         blocks unprivileged user namespaces. It is opt-in so
 *                         that a normal local run still exercises the sandbox.
 *                         Auto-enabled when running as uid 0, where Chromium
 *                         refuses to start sandboxed anyway.
 *
 * HEADLESS
 *   Electron has NO --headless flag; passing one is a hard startup error. On
 *   Linux with neither DISPLAY nor WAYLAND_DISPLAY set, this script re-launches
 *   the app under `xvfb-run -a` automatically, and tells you plainly if
 *   xvfb-run is not installed rather than hanging until the timeout.
 *
 * EXIT CODES
 *   0  PASS — every assertion held.
 *   1  FAIL — an assertion failed, or the app never became answerable.
 *   2  usage / environment problem (no binary found, no virtual display, ...).
 */

import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const opts = {
  app: process.env.SMOKE_APP ?? '',
  timeoutMs: Number(process.env.SMOKE_TIMEOUT_MS ?? 60_000),
  screenshot: '',
  json: false,
  display: '',
  keepProfile: false,
  noSandbox: process.env.SMOKE_NO_SANDBOX === '1',
};

for (const arg of process.argv.slice(2)) {
  if (arg === '-h' || arg === '--help') {
    // The header comment above IS the help text; print the usage half of it.
    const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const block = src.slice(src.indexOf(' * USAGE'), src.indexOf(' * EXIT CODES'));
    console.log(block.replace(/^ \* ?/gm, ''));
    process.exit(0);
  } else if (arg === '--json') opts.json = true;
  else if (arg === '--keep-profile') opts.keepProfile = true;
  else if (arg === '--no-sandbox') opts.noSandbox = true;
  else if (arg.startsWith('--app=')) opts.app = arg.slice(6);
  else if (arg.startsWith('--timeout=')) opts.timeoutMs = parseDuration(arg.slice(10));
  else if (arg.startsWith('--screenshot=')) opts.screenshot = path.resolve(arg.slice(13));
  else if (arg.startsWith('--display=')) opts.display = arg.slice(10);
  else if (arg.startsWith('-')) fatal(2, `unknown option: ${arg}`);
  else opts.app = arg;
}

/** "90" and "90s" are seconds; "90000ms" is milliseconds. */
function parseDuration(text) {
  const m = /^(\d+(?:\.\d+)?)(ms|s)?$/.exec(text.trim());
  if (!m) fatal(2, `cannot parse duration: ${text}`);
  return m[2] === 'ms' ? Number(m[1]) : Number(m[1]) * 1000;
}

function fatal(code, message) {
  console.error(`smoke: ${message}`);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// Finding the packaged app
// ---------------------------------------------------------------------------

const RELEASE = path.join(ROOT, 'release');

function globOne(dir, test) {
  if (!fs.existsSync(dir)) return '';
  const hit = fs.readdirSync(dir).sort().find(test);
  return hit ? path.join(dir, hit) : '';
}

/**
 * The conventional electron-builder output locations, per platform. The
 * *unpacked* directory is preferred over the installer everywhere: it is what
 * the installer contains, it needs no FUSE (AppImage), no admin rights (NSIS)
 * and no disk-image mount (DMG), so it is both faster and less likely to fail
 * for a reason that has nothing to do with the app.
 */
function discoverApp() {
  if (process.platform === 'linux') {
    const unpacked = path.join(RELEASE, 'linux-unpacked', 'psppcpr');
    if (fs.existsSync(unpacked)) return unpacked;
    return globOne(RELEASE, (f) => f.endsWith('.AppImage'));
  }
  if (process.platform === 'win32') {
    const exe = globOne(path.join(RELEASE, 'win-unpacked'), (f) => f.toLowerCase().endsWith('.exe'));
    if (exe) return exe;
    return globOne(RELEASE, (f) => f.toLowerCase().endsWith('.exe'));
  }
  if (process.platform === 'darwin') {
    // electron-builder stages x64 in release/mac and every other arch in
    // release/mac-<arch>. Prefer the runner's OWN arch: macos-latest is arm64,
    // and launching the x64 bundle there would silently be a test of Rosetta 2
    // rather than a test of the app.
    const order =
      process.arch === 'arm64'
        ? ['mac-arm64', 'mac-universal', 'mac']
        : ['mac', 'mac-x64', 'mac-universal', 'mac-arm64'];
    for (const name of [...order.map((d) => path.join(RELEASE, d)), RELEASE]) {
      const app = globOne(name, (f) => f.endsWith('.app'));
      if (app) return app;
    }
    return globOne(path.join(RELEASE, 'mac'), (f) => f.endsWith('.zip'));
  }
  return '';
}

/** macOS: <bundle>.app -> Contents/MacOS/<CFBundleExecutable>. */
function macExecutableOf(appBundle) {
  const macos = path.join(appBundle, 'Contents', 'MacOS');
  const plist = path.join(appBundle, 'Contents', 'Info.plist');
  if (fs.existsSync(plist)) {
    const text = fs.readFileSync(plist, 'utf8');
    const m = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(text);
    const named = m && path.join(macos, m[1]);
    if (named && fs.existsSync(named)) return named;
  }
  const first = globOne(macos, (f) => !f.startsWith('.'));
  if (!first) fatal(2, `no executable inside ${appBundle}`);
  return first;
}

/** macOS: a zip has to become a bundle before anything can launch it. */
function expandMacZip(zip, into) {
  fs.mkdirSync(into, { recursive: true });
  const ditto = spawnSync('ditto', ['-x', '-k', zip, into], { stdio: 'inherit' });
  if (ditto.error || ditto.status !== 0) {
    const unzip = spawnSync('unzip', ['-q', zip, '-d', into], { stdio: 'inherit' });
    if (unzip.error || unzip.status !== 0) fatal(2, `could not expand ${zip}`);
  }
  const bundle = globOne(into, (f) => f.endsWith('.app'));
  if (!bundle) fatal(2, `no .app inside ${zip}`);
  return bundle;
}

// ---------------------------------------------------------------------------
// HTTP to the evidence channel
// ---------------------------------------------------------------------------

/**
 * One request to a /test/* route.
 *
 * Every URL carries `?t=<token>`; see the AUTHENTICATION note in the header.
 * The base is always the literal 127.0.0.1:<port> from the descriptor, so Node
 * emits exactly the Host header the server pins against.
 */
function call(hooks, route, { method = 'GET', body, query = {}, timeoutMs = 20_000 } = {}) {
  const url = new URL(route, hooks.base);
  url.searchParams.set('t', hooks.token);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));

  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method, headers: body === undefined ? {} : { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(body) } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          const text = raw.toString('utf8');
          let json;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode ?? 0, text, json, raw });
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// PNG inspection — signature + IHDR, no decoder needed
// ---------------------------------------------------------------------------

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function inspectPng(buf) {
  const signature = buf.length >= 8 && buf.subarray(0, 8).equals(PNG_MAGIC);
  const ihdr = buf.length >= 24 && buf.subarray(12, 16).toString('latin1') === 'IHDR';
  return {
    bytes: buf.length,
    signature,
    ihdr,
    width: ihdr ? buf.readUInt32BE(16) : 0,
    height: ihdr ? buf.readUInt32BE(20) : 0,
    bitDepth: ihdr ? buf.readUInt8(24) : 0,
    colorType: ihdr ? buf.readUInt8(25) : 0,
  };
}

// ---------------------------------------------------------------------------
// The renderer probe
//
// executeJavaScript evaluates an EXPRESSION, so this is an IIFE. It is written
// against the real shipped DOM (src/renderer/index.html mounts into #app; on a
// successful mount ui/index.ts adds `.faceplate-root` to it and appends
// `div.shell` containing `.panel__grid` and the `.power-btn` dome). The
// host-failure card (`.hostfail`) is the *designed* failure state and mounts
// into the same #app, so a naive "has children" check would pass on a receiver
// that never started. This distinguishes them and reports which it saw.
// ---------------------------------------------------------------------------

const PROBE = `(() => {
  const app = document.querySelector('#app');
  const shell = document.querySelector('#app > .shell');
  const rect = shell ? shell.getBoundingClientRect() : null;
  return {
    documentTitle: document.title,
    readyState: document.readyState,
    appPresent: !!app,
    appChildren: app ? app.children.length : -1,
    faceplateRootClass: !!app && app.classList.contains('faceplate-root'),
    shell: !!shell,
    panelGrid: !!document.querySelector('#app .panel__grid'),
    powerButton: !!document.querySelector('#app .power-btn'),
    drumDial: !!document.querySelector('#app .dial-head__band'),
    hostFailure: !!document.querySelector('#app .hostfail'),
    hostFailureText: (document.querySelector('#app .hostfail__detail') || {}).textContent || null,
    hostPublished: typeof window.__weltempfaenger === 'object' && window.__weltempfaenger !== null,
    shellSize: rect ? [Math.round(rect.width), Math.round(rect.height)] : null,
    styleSheets: document.styleSheets.length,
    innerSize: [window.innerWidth, window.innerHeight],
  };
})()`;

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  return !!ok;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const evidence = {
  startedAt: new Date().toISOString(),
  host: { platform: process.platform, arch: process.arch, node: process.version },
  expected: { version: PKG.version, platform: process.platform },
};

let child = null;
let profileDir = '';
let exited = false;
let exitInfo = null;
const childLog = [];

process.on('SIGINT', () => finish(130, 'interrupted'));
process.on('SIGTERM', () => finish(143, 'terminated'));

/**
 * Last-ditch cleanup. finish() is the normal path, but a run whose stdout is a
 * closed pipe (`node tools/smoke.mjs | head`) dies on EPIPE mid-print, and an
 * unforeseen throw would too — either way an Electron process and a temp
 * profile must not survive us. Only synchronous work is possible in an exit
 * handler, which is exactly what killChild and rmSync are.
 */
process.on('exit', () => {
  killChild();
  if (profileDir && !opts.keepProfile) {
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch {
      /* nothing left to try at this point */
    }
  }
});

await main();

async function main() {
  // -- resolve the binary ---------------------------------------------------
  let target = opts.app ? path.resolve(opts.app) : discoverApp();
  if (!target) {
    fatal(
      2,
      `no packaged app found for ${process.platform} under ${RELEASE}\n` +
        `  build one first (npx electron-builder --${process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux'} --publish never)\n` +
        `  or pass the path: node tools/smoke.mjs <path-to-app>`,
    );
  }
  if (!fs.existsSync(target)) fatal(2, `no such file: ${target}`);

  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'psppcpr-smoke-'));
  const hooksFile = path.join(profileDir, 'test-hooks.json');

  let launchArgs = [];
  if (target.endsWith('.zip')) {
    // A macOS zip is not launchable; expand it inside the throwaway profile dir
    // so the expansion is cleaned up with everything else.
    target = expandMacZip(target, path.join(profileDir, 'expanded'));
  }
  if (target.endsWith('.app')) target = macExecutableOf(target);
  if (target.endsWith('.AppImage')) {
    // --appimage-extract-and-run sidesteps FUSE entirely, which CI containers
    // frequently lack (no libfuse2 -> "dlopen(): error loading libfuse.so.2").
    launchArgs.push('--appimage-extract-and-run');
    try {
      fs.chmodSync(target, 0o755);
    } catch {
      /* best effort: a read-only artifact dir is not our problem to fix */
    }
  }

  evidence.app = { path: target, profileDir, hooksFile };

  // -- isolation ------------------------------------------------------------
  // --user-data-dir is a Chromium switch Electron honours verbatim. It moves
  // app.getPath('userData') AND the single-instance SingletonLock, so this run
  // can neither read nor disturb the developer's real ~/.config/Weltempfänger,
  // and an already-running copy of the app cannot steal our launch.
  launchArgs.push(`--user-data-dir=${profileDir}`);

  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (opts.noSandbox || asRoot) {
    launchArgs.push('--no-sandbox');
    evidence.sandbox = asRoot && !opts.noSandbox ? 'disabled (running as root)' : 'disabled (requested)';
  } else {
    evidence.sandbox = 'enabled';
  }

  // -- display --------------------------------------------------------------
  const env = { ...process.env, PSPPCPR_TEST_HOOKS: '1', PSPPCPR_TEST_HOOKS_FILE: hooksFile };
  if (opts.display) env.DISPLAY = opts.display;

  let command = target;
  let commandArgs = launchArgs;

  if (process.platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    // No display at all — an ubuntu-latest runner, or a bare container. Electron
    // has no headless mode, so a virtual X server is mandatory.
    const hasXvfbRun = spawnSync('which', ['xvfb-run'], { stdio: 'ignore' }).status === 0;
    if (!hasXvfbRun) {
      fatal(
        2,
        'no DISPLAY and no WAYLAND_DISPLAY on Linux, and xvfb-run is not installed.\n' +
          '  Electron has no headless mode; it needs a real (virtual) display.\n' +
          '  Install one:  sudo apt-get install -y xvfb\n' +
          '  or run your own and point at it:  node tools/smoke.mjs --display=:99',
      );
    }
    // -a picks a free display number, so parallel jobs cannot collide.
    commandArgs = ['-a', '-s', '-screen 0 1600x1000x24', target, ...launchArgs];
    command = 'xvfb-run';
    evidence.display = 'xvfb-run -a (auto)';
  } else {
    evidence.display = env.DISPLAY || env.WAYLAND_DISPLAY || '(platform default)';
  }

  console.log(`app        : ${target}`);
  console.log(`launcher   : ${command} ${commandArgs.join(' ')}`);
  console.log(`profile    : ${profileDir}`);
  console.log(`display    : ${evidence.display}`);
  console.log(`sandbox    : ${evidence.sandbox}`);
  console.log(`timeout    : ${opts.timeoutMs} ms`);
  console.log('');

  // -- launch ---------------------------------------------------------------
  child = spawn(command, commandArgs, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Own process group: xvfb-run is a shell script that forks, and Electron
    // forks its own zygote/GPU children. Killing the group is the only way to
    // guarantee CI does not leave stragglers behind.
    detached: process.platform !== 'win32',
  });
  const tap = (stream, tag) => {
    stream.setEncoding('utf8');
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      // The app prints its descriptor — bearer token included — on stdout. The
      // token is per-run and dies with the process, but this log is echoed into
      // CI output on failure, and a bearer token in a public build log is a
      // thing reviewers rightly object to. Redact it at the point of capture.
      for (const line of lines) childLog.push(`${tag} ${line}`.replace(/("token":")[^"]+/g, '$1<redacted>'));
    });
  };
  tap(child.stdout, 'out|');
  tap(child.stderr, 'err|');
  child.on('exit', (code, signal) => {
    exited = true;
    exitInfo = { code, signal };
  });
  child.on('error', (err) => {
    exited = true;
    exitInfo = { code: null, signal: null, error: err.message };
  });

  const deadline = Date.now() + opts.timeoutMs;

  // -- 1. the descriptor ----------------------------------------------------
  // The file is more reliable than scraping stdout (Windows buffering, xvfb-run
  // interposition), but the stdout line is a free fallback so both are tried.
  let hooks = null;
  while (Date.now() < deadline && !hooks) {
    if (fs.existsSync(hooksFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
        if (parsed && parsed.port && parsed.token) hooks = parsed;
      } catch {
        /* half-written file; try again next tick */
      }
    }
    if (!hooks) {
      const line = childLog.find((l) => l.includes('PSPPCPR_TEST_HOOKS {'));
      if (line) {
        try {
          hooks = JSON.parse(line.slice(line.indexOf('{')));
        } catch {
          /* keep polling */
        }
      }
    }
    if (!hooks && exited) break;
    if (!hooks) await sleep(150);
  }

  if (
    !check(
      'test-hook descriptor written',
      hooks && hooks.port && hooks.token,
      hooks ? `port ${hooks.port}, pid ${hooks.pid}` : exited ? `app exited early: ${JSON.stringify(exitInfo)}` : 'timed out waiting for the descriptor',
    )
  ) {
    return finish(1, 'app never published its test hooks');
  }
  evidence.hooks = { port: hooks.port, pid: hooks.pid, base: hooks.base, routes: hooks.routes };

  // -- 2. /test/ping --------------------------------------------------------
  let ping = null;
  while (Date.now() < deadline && !ping) {
    try {
      const res = await call(hooks, '/test/ping', { timeoutMs: 5_000 });
      if (res.status === 200 && res.json && res.json.ok === true) ping = res.json;
      else if (res.status === 401 || res.status === 403) {
        check('GET /test/ping', false, `${res.status} ${res.text.trim()} — token/host handshake is wrong`);
        return finish(1, 'the evidence channel refused us');
      }
    } catch {
      /* socket not accepting yet */
    }
    if (!ping && exited) break;
    if (!ping) await sleep(150);
  }
  if (!check('GET /test/ping answers {ok:true}', ping, ping ? `pid ${ping.pid}` : 'no answer before the deadline')) {
    return finish(1, 'the app never answered /test/ping');
  }
  evidence.ping = ping;
  check('ping pid matches descriptor pid', ping.pid === hooks.pid, `${ping.pid} === ${hooks.pid}`);

  // -- 3. /test/state -------------------------------------------------------
  const stateRes = await call(hooks, '/test/state');
  if (!check('GET /test/state returns JSON', stateRes.status === 200 && stateRes.json, `HTTP ${stateRes.status}`)) {
    return finish(1, '/test/state did not answer');
  }
  const app = stateRes.json.app ?? {};
  evidence.state = stateRes.json;

  check('app.testHooks === true', app.testHooks === true, JSON.stringify(app.testHooks));
  check(`app.version === ${PKG.version}`, app.version === PKG.version, `got ${JSON.stringify(app.version)}`);
  check(`app.platform === ${process.platform}`, app.platform === process.platform, `got ${JSON.stringify(app.platform)}`);
  check('app.proxyPort matches the descriptor', app.proxyPort === hooks.port, `${app.proxyPort} === ${hooks.port}`);
  // Isolation is an assertion, not a hope: if this fails the run just wrote to
  // the developer's real profile and the result is not trustworthy either way.
  check(
    'userData is the throwaway profile',
    typeof app.userDataPath === 'string' && isInside(profileDir, app.userDataPath),
    app.userDataPath,
  );

  // The renderer publishes PlaybackState to the main process across the preload
  // bridge (preload.ts `reportPlaybackState` -> IPC.reportState). In
  // src/main/index.ts `lastPlaybackState` starts as INITIAL_PLAYBACK_STATE and
  // is only ever replaced by that message, so this field is the main process's
  // view of what the renderer last said. Shape first; WHO put it there is a
  // separate question, settled in step 5 — see the comment there.
  const pbs = stateRes.json.playbackState;
  const PHASES = ['idle', 'resolving', 'connecting', 'buffering', 'playing', 'stalled', 'reconnecting', 'error'];
  check(
    '/test/state carries a PlaybackState',
    pbs !== null && typeof pbs === 'object' && PHASES.includes(pbs.phase),
    pbs ? `phase ${JSON.stringify(pbs.phase)}` : 'absent',
  );
  check(
    'PlaybackState carries its numeric telemetry',
    pbs !== null &&
      typeof pbs === 'object' &&
      ['bufferedSeconds', 'playingSeconds', 'bytesReceived', 'signalLevel'].every((k) => typeof pbs[k] === 'number'),
    pbs && typeof pbs === 'object'
      ? `buffered ${pbs.bufferedSeconds}s, played ${pbs.playingSeconds}s, ${pbs.bytesReceived} bytes, signal ${pbs.signalLevel}`
      : 'absent',
  );

  // -- 4. /test/exec — the renderer must be alive ---------------------------
  // Poll: the descriptor is written BEFORE createWindow() in src/main/index.ts,
  // so an immediate exec legitimately answers {ok:false,"no window"} for a beat.
  let probe = null;
  let lastProbeError = '';
  while (Date.now() < deadline) {
    const res = await call(hooks, '/test/exec', { method: 'POST', body: PROBE });
    if (res.status === 200 && res.json && res.json.ok === true) {
      probe = res.json.value;
      // The faceplate mounts a frame or two after the document is ready; only
      // accept a probe that saw the real panel, and keep trying until then.
      if (probe && probe.shell && probe.panelGrid && probe.powerButton) break;
      if (probe && probe.hostFailure) break; // designed failure — report it now
    } else if (res.json) {
      lastProbeError = String(res.json.error ?? res.text);
    } else {
      lastProbeError = `HTTP ${res.status} ${res.text.slice(0, 120)}`;
    }
    if (exited) break;
    await sleep(250);
  }

  if (!check('POST /test/exec evaluates in the renderer', probe !== null, probe ? 'ok' : lastProbeError || 'no renderer answered')) {
    return finish(1, 'no live renderer process');
  }
  evidence.renderer = probe;

  check('document.readyState is complete', probe.readyState === 'complete', probe.readyState);
  check('document.title is the product name', probe.documentTitle === 'Weltempfänger', probe.documentTitle);
  check('#app exists and has children', probe.appPresent && probe.appChildren > 0, `${probe.appChildren} child node(s)`);
  check('renderer did NOT fall back to the host-failure card', probe.hostFailure === false, probe.hostFailureText ?? 'no .hostfail in the document');
  check('#app carries .faceplate-root', probe.faceplateRootClass === true, String(probe.faceplateRootClass));
  check('faceplate .shell is mounted', probe.shell === true, probe.shellSize ? `${probe.shellSize[0]}x${probe.shellSize[1]} css px` : 'absent');
  check('.panel__grid is present', probe.panelGrid === true, String(probe.panelGrid));
  check('.power-btn is present', probe.powerButton === true, String(probe.powerButton));
  check('the main-process host published window.__weltempfaenger', probe.hostPublished === true, String(probe.hostPublished));
  check('renderer stylesheets loaded', probe.styleSheets > 0, `${probe.styleSheets} stylesheet(s)`);
  check('window has a non-zero viewport', probe.innerSize[0] > 0 && probe.innerSize[1] > 0, `${probe.innerSize[0]}x${probe.innerSize[1]}`);

  // -- 5. the renderer is actively publishing PlaybackState -----------------
  //
  // Step 3 proves a PlaybackState is THERE. It cannot prove the renderer put it
  // there: a renderer that never booted leaves src/main/index.ts's
  // INITIAL_PLAYBACK_STATE in place, and a renderer sitting at idle publishes a
  // byte-identical object. The two are indistinguishable by value.
  //
  // So make the value distinguishable. Write a sentinel that the engine could
  // never produce (negative AND fractional byte count) straight into
  // lastPlaybackState through the real preload bridge, then watch for it to be
  // REPLACED. Nothing in the main process writes that variable except the
  // IPC.reportState handler, so the only thing that can overwrite the sentinel
  // is the renderer publishing its own state.
  //
  // Asserting the sentinel DEPARTS is the sound direction. An earlier version
  // asserted it ARRIVED and was a race it lost half the time. A broken preload
  // is the most platform-sensitive part of an Electron package — loaded by
  // absolute path out of the asar — and is invisible to every other check here,
  // because the window still paints without it.
  //
  // But departure must be PROVOKED, not waited for. This comment used to record
  // that "at idle the renderer republishes faster than a 100 ms poll can see".
  // That is no longer true, and the check failed on a healthy packaged build
  // because of it: `ReceiverHost.canSettle` parks the frame loop in standby, on
  // purpose, and a parked renderer publishes nothing at all. That park is what
  // takes standby from 6.1% of a core to 0.6%, so waiting for an unprompted
  // republish is waiting for a battery bug to reappear.
  //
  // Verified rather than assumed: reverting `canSettle` to its pre-park form
  // does NOT make the passive check pass, so the park was never what this was
  // measuring — the app simply reaches rest before the poll starts.
  //
  // So provoke a publish through a control a user actually presses. The power
  // dome moves the phase, the renderer must publish the change, and the publish
  // still travels renderer -> preload -> IPC -> main — so a broken bridge fails
  // exactly as loudly as before, while a healthy idle app no longer does.
  const sentinel = -((Date.now() % 1_000_000) + 0.5);
  const pushRes = await call(hooks, '/test/exec', {
    method: 'POST',
    body:
      "(() => { const b = window.psppcpr; " +
      "if (!b || typeof b.reportPlaybackState !== 'function') return 'no bridge'; " +
      "b.reportPlaybackState({ phase: 'idle', bufferedSeconds: 0, playingSeconds: 0, " +
      `bytesReceived: ${sentinel}, signalLevel: 0 }); return 'sent'; })()`,
  });
  const pushed =
    pushRes.status === 200 && pushRes.json && pushRes.json.ok === true && pushRes.json.value === 'sent';
  check(
    'the preload bridge exposes reportPlaybackState',
    pushed,
    pushRes.json ? String(pushRes.json.value ?? pushRes.json.error) : `HTTP ${pushRes.status}`,
  );

  let republished = null;
  if (pushed) {
    // The provocation. A real press on the shipped power control, by its
    // accessible name — not a test-only hook, so this exercises the same path a
    // hand does. Its own result is not asserted: if the control is missing the
    // republish simply never comes and the check below says so.
    const wakeRes = await call(hooks, '/test/exec', {
      method: 'POST',
      body:
        "(() => { const b = document.querySelector('[aria-label^=\"Radio power\"]'); " +
        "if (!b) return 'no power control'; b.click(); return 'pressed'; })()",
    });
    evidence.playbackWake = wakeRes.json ? (wakeRes.json.value ?? wakeRes.json.error) : `HTTP ${wakeRes.status}`;
    for (let i = 0; i < 50; i++) {
      const again = await call(hooks, '/test/state');
      const p = again.json && again.json.playbackState;
      if (p && typeof p.bytesReceived === 'number' && p.bytesReceived !== sentinel && PHASES.includes(p.phase)) {
        republished = p;
        break;
      }
      if (exited) break;
      await sleep(100);
    }
  }
  check(
    'the renderer is actively publishing PlaybackState to the main process',
    republished !== null,
    republished
      ? `sentinel ${sentinel} was replaced by a live phase="${republished.phase}" state — renderer -> preload -> IPC -> main is up`
      : pushed
        ? `sentinel ${sentinel} was never replaced — the renderer has stopped publishing`
        : 'skipped: the bridge call did not go through',
  );
  evidence.playbackChannel = { sentinel, republished };

  // -- 6. /test/screenshot --------------------------------------------------
  const shotPath = opts.screenshot || path.join(profileDir, 'window.png');
  const shotRes = await call(hooks, '/test/screenshot', { query: { path: shotPath }, timeoutMs: 30_000 });
  const wrote = shotRes.status === 200 && shotRes.json && shotRes.json.ok === true && fs.existsSync(shotPath);
  if (check('GET /test/screenshot captured the window', wrote, wrote ? shotPath : `HTTP ${shotRes.status} ${shotRes.text.slice(0, 160)}`)) {
    const png = inspectPng(fs.readFileSync(shotPath));
    evidence.screenshot = { path: shotPath, ...png, kept: Boolean(opts.screenshot) };
    check('screenshot has a valid PNG signature', png.signature, '89 50 4e 47 0d 0a 1a 0a');
    check('screenshot has an IHDR chunk', png.ihdr, `bitDepth ${png.bitDepth}, colorType ${png.colorType}`);
    // A blank/absent window still encodes, but it encodes tiny. 16 KiB of PNG
    // out of a >=800x600 frame means real, varied pixels were in it.
    check('screenshot is not trivially small', png.bytes >= 16_384, `${png.bytes} bytes`);
    check('screenshot dimensions look like a window', png.width >= 320 && png.height >= 240, `${png.width}x${png.height} px`);
  }

  // -- 7. /test/quit --------------------------------------------------------
  const quitRes = await call(hooks, '/test/quit', { timeoutMs: 10_000 }).catch((err) => ({ status: 0, text: String(err) }));
  check('GET /test/quit accepted', quitRes.status === 200, `HTTP ${quitRes.status}`);

  const gone = await waitForExit(15_000);
  check('app process exited on request', gone, gone ? `code ${exitInfo?.code ?? '-'} signal ${exitInfo?.signal ?? '-'}` : 'still running after 15s — killed');

  return finish(checks.every((c) => c.ok) ? 0 : 1, null);
}

function isInside(parent, candidate) {
  const rel = path.relative(fs.realpathSync(parent), path.resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function waitForExit(ms) {
  if (exited) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(exited), ms);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** SIGTERM then SIGKILL, to the whole process group where there is one. */
function killChild() {
  if (!child || exited) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-child.pid, 'SIGTERM');
      const until = Date.now() + 3000;
      while (!exited && Date.now() < until) spawnSync('sleep', ['0.1']);
      if (!exited) process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    /* already gone */
  }
}

function finish(code, reason) {
  killChild();

  const width = Math.max(...checks.map((c) => c.name.length), 10);
  console.log('assertions');
  console.log('-'.repeat(width + 12));
  for (const c of checks) {
    console.log(`  ${c.ok ? 'ok  ' : 'FAIL'}  ${c.name.padEnd(width)}  ${c.detail}`);
  }

  const failed = checks.filter((c) => !c.ok);
  const pass = code === 0 && failed.length === 0 && checks.length > 0;
  evidence.checks = checks;
  evidence.result = pass ? 'PASS' : 'FAIL';
  evidence.finishedAt = new Date().toISOString();

  if (!pass && childLog.length) {
    console.log('\nlast 40 lines from the app:');
    for (const line of childLog.slice(-40)) console.log(`  ${line}`);
  }

  console.log(
    `\n${pass ? 'PASS' : 'FAIL'}: ${checks.filter((c) => c.ok).length}/${checks.length} assertions held` +
      (reason ? ` — ${reason}` : ''),
  );
  if (pass) {
    console.log(
      `      the packaged app launched on ${process.platform}, opened a window and got a live renderer onto it.`,
    );
  }

  if (opts.json) console.log(`\n${JSON.stringify(evidence, null, 2)}`);

  if (profileDir && !opts.keepProfile) {
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch {
      /* Windows sometimes holds the profile a moment longer; not worth failing over */
    }
  } else if (profileDir) {
    console.log(`\nprofile kept: ${profileDir}`);
  }

  process.exit(pass ? 0 : code || 1);
}
