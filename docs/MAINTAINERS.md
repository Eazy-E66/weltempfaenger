# Maintaining Weltempfänger

The one place to start. Everything here was checked against the running app, not
inferred from the code; where a claim is only true on one platform it says so.
The two documents beside this one are different in kind: `DESIGN-LAWS.md` is
binding product law, `REFERENCE-BRIEF.md` is the visual reference the panel was
built from. Neither tells you how the thing runs. This does.

## What it is

An Electron desktop app. One window, one process pair:

- **Main process** (`src/main/`) — owns the network. It talks to the Radio
  Browser directory, resolves candidate URLs into playable streams, and runs a
  loopback **proxy** that the renderer's `<audio>` element actually plays from.
  It also owns the two files in the user's profile.
- **Renderer** (`src/renderer/`) — owns the audio graph and the panel. The
  **host** (`renderer/host/`) is the application: it holds every piece of
  state, talks to main over the preload bridge, drives the **engine**
  (`renderer/engine/`, Web Audio + `<audio>`), and renders the **UI**
  (`renderer/ui/`, hand-built DOM and canvas, no framework).
- **Shared contracts** (`src/shared/contracts.ts`) — the only types the three
  concerns meet through. Read this file first.

```
directory (Radio Browser, over HTTPS)
   │  listIndex / search              main process: src/main/directory
   ▼
host.refreshScope ── rows ──▶ register (facets, sort, CUT BAND)   renderer/ui/components/register.ts
   │                              │
   │        cutBands()            ▼
   └──────────────────────▶ Cut → Band → drum + tuning knob        src/main/tuning/bandLayout.ts (pure; also bundled into the renderer)
                                          │ tune(station)
                                          ▼
                              engine.tune ── resolve(url) ──▶ main: src/main/resolver   (PLS/M3U, redirects, sniffing)
                                          │ PlayableStream[]
                                          ▼
                              proxy.createSession ──▶ main: src/main/proxy   (raw socket upstream, ICY metadata, stall detector, stats at 5 Hz)
                                          │ http://127.0.0.1:<port>/stream?…
                                          ▼
                              <audio> ─▶ bass ─▶ treble ─▶ stationGain ─▶ master ─▶ limiter ─▶ analyser ─▶ speakers
                                          │
                                          ▼
                              PlaybackState (10 Hz, measured) ──▶ host.onEngineState ──▶ UI.render
```

Three rules that everything above obeys (Design Laws 2–4, in practice):

1. **Nothing on the panel is asserted.** `PlaybackState.phase` is derived in
   `engine/phase.ts` from media-element events, proxy byte flow and the
   analyser. A button press *requests*; only measurement *reports*.
2. **Late answers lose.** Every async path carries a generation counter and
   drops results that arrive after a newer request: `engine.generation`
   (tune/reconnect), `host.scopeGeneration` (directory fetch),
   `host.indexGeneration` (index pull), `ProxyLink.sessionId` (proxy
   telemetry). Rows also travel with the `key` of the scope they answer, and
   the register refuses to print rows for a key it did not ask for.
3. **Failure is a designed state.** Every failure is a closed-set kind
   (`ResolveFailure`, `PlaybackError`, `SignalLoss`, `DirectoryFailure`) and
   the sentence is composed from the kind, never from raw error text.

## State: who owns what, and what is on disk

| State | Owner | Persisted where |
|---|---|---|
| Knob settings, `scope` (the register's cards), `cutScope` (the scope of the standing band), `cutBandIndex` | `host.settings` | `settings.json`, debounced 400 ms, flushed on `pagehide` |
| Presets C/B/P, last station, the 12-line log | `host.memory` | `memory.json`, debounced 250 ms |
| The index (subjects/origins/tongues), the rows, the cut, the band | host, in memory | never — re-derived from `scope`/`cutScope` on launch |
| Playback state | engine → host | never |

Both files live in Electron's `userData` directory for the product name —
`~/.config/Weltempfänger` on Linux; `/test/state` prints the exact path when
test hooks are on. Both are
read through a coercion (`coerceSettings`, `coerceMemory` in
`src/main/index.ts`) that defaults every missing or malformed field, so a
truncated or hand-edited file cannot stop the app; it is simply treated as
absent. Neither file is rewritten until something changes.

**`cutScope` replaced `cutStanding: boolean` in 0.3.** A file carrying
`cutStanding: true` is read as "the throw was the scope on disk" and rewritten
in the new shape on the next save. Rolling back to 0.2 against a 0.3 file
loses the standing band (0.2 ignores `cutScope` and finds no `cutStanding`);
nothing else in either file changed shape.

The band on the drum is never stored — only the scope it was cut from. A launch
with no network therefore comes up with an empty drum and says so; the band
comes back with the first successful pull.

## Run

```bash
npm ci
npm run build        # tsc for main, vite for the renderer → dist/
npm start            # build, then electron .
npm run dev          # vite dev server + tsc --watch + electron, with reload
```

Useful launch environment:

| Variable | Effect |
|---|---|
| `PSPPCPR_DEVTOOLS=1` | open DevTools detached (dev server only) |
| `PSPPCPR_TEST_HOOKS=1` | expose the evidence channel (below) on the proxy port and write its descriptor to `PSPPCPR_TEST_HOOKS_FILE` (default `<userData>/test-hooks.json`) |
| `PSPPCPR_DIRECTORY_MIRRORS=http://…,http://…` | pin the directory to these base URLs and skip mirror discovery |
| `PSPPCPR_PROXY_ALLOW_PRIVATE=1` | let the proxy and resolver open loopback/private upstreams (normally refused) |
| `--user-data-dir=<dir>` | a throwaway profile; the smoke test uses one |

## Test

```bash
npm run typecheck    # main, renderer AND the test tree (tsconfig.test.json)
npm test             # vitest: 900+ deterministic tests, no network, ~15 s
npm run test:live    # opens real sockets to Radio Browser and a live stream; smoke checks, not gates
```

What the suite covers, and where to add to it:

- `test/unit`, `test/resolver`, `test/proxy`, `test/directory` — main-process
  modules against fixtures in `test/fixtures` and a local fixture server
  (`test/helpers/fixtureServer.ts`).
- `test/engine` — the playback engine against a fake `<audio>` element and a
  fake proxy (`test/helpers/fakeDeck.ts`). Any rule about what the panel may
  claim belongs here.
- `test/ui/*.dom.test.ts` — the host and the real UI components in jsdom with
  a fake bridge. `host.dom.test.ts` is the integration seam: it boots the real
  host against a scripted directory and asserts what reached the panel.
- `test/ui/no-mock-in-production.test.ts` walks the import graph so the
  harness's mock engine can never be reached from the shipping bundle.

## Debug: look at the real thing

### The evidence channel

With `PSPPCPR_TEST_HOOKS=1` the proxy serves a handful of routes, all requiring
the token from the descriptor file (`?t=<token>`):

| Route | What it gives you |
|---|---|
| `GET /test/state` | app info, the last `PlaybackState` the renderer published, every live proxy session with byte counts, stall flag and sniffed format |
| `POST /test/exec` | evaluates the body in the renderer and returns the value — `window.__weltempfaenger` is the host (settings, memory, cut, band, engine) |
| `GET /test/screenshot` | the window as PNG |
| `GET /test/window?state=hidden|shown&w=&h=` | hide/show or resize the window |
| `GET /test/quit` | clean exit |

`tools/smoke.mjs` is the reference client: it launches a packaged binary under
a throwaway profile, waits for the descriptor, and runs 30-odd assertions.
`node tools/smoke.mjs --help` for the options. It is also the cheapest way to
drive the app from a script: launch with the environment above, poll the
descriptor file, then call the routes.

From inside the renderer, `window.__weltempfaenger.engine.diagnostics()` holds
what the panel deliberately does not print: the browser's own `MediaError`
text, AFC attempt counts, the raw fault.

### A directory and a station you control

`tools/rig.mjs` starts a stand-in Radio Browser directory and an ICY stream
server on loopback, with knobs to make either misbehave — a 500, a 429, a
malformed body, a stream that stalls, drops, turns to noise, or serves an HTML
parking page. It prints the two environment variables to launch the app with:

```bash
node tools/rig.mjs --sample=some.mp3     # any MP3 file to loop as programme
# in another shell, with the printed PSPPCPR_DIRECTORY_MIRRORS and PSPPCPR_PROXY_ALLOW_PRIVATE:
npm start
# then, while it runs:
curl 'http://127.0.0.1:<dirport>/ctl?dir=http500'         # the directory starts failing
curl 'http://127.0.0.1:<dirport>/ctl?stream=3:stall'      # station 3 stops sending
curl 'http://127.0.0.1:<dirport>/ctl?drop=all'            # every live socket is severed
```

Every resilience fix in the history was found and verified this way. If you
change anything under `engine/`, `proxy/` or the host's directory handling,
run the app against the rig and provoke the failure you are reasoning about.

### Reading a fault on the panel

- **Annunciator** (the strip under the readout): host notices — directory
  faults, station faults, what to press. Composed in `host/notices.ts`;
  directory faults in `host/faults.ts`, which say RETRYING ON ITS OWN while
  the host's bounded re-pull is still running and PRESS RECONNECT once it
  has stopped. One line, no wrapping: keep sentences short enough that the
  key to press survives at 860 px.
- **Readout badge**: the engine's phase in the listener's words — `STANDBY`,
  `TUNING` (resolving or connecting), `BUFFERING`, `LOCKED` (playing),
  `RE-LOCKING` (AFC), `FAULT` with a short reason. A stall is named by its
  cause, from `signalLoss`: `SIGNAL LOST` (`flow-stopped`, bytes stopped),
  `OFF STATION` (`detuned`, the listener's own dial — standby ink, RECONNECT
  dark), `DEAD AIR` (station sends silence), `NOT DECODING` (`undecodable`,
  bytes arrive, nothing plays). `describePhase` in
  `ui/components/readout.ts` is the one composer; the screen-reader line
  uses it too.
- **Register fault strip**: the same verdict in prose, from the same composer
  (`stalledWords` in `ui/components/readout.ts`).
- If a sentence on the panel looks wrong, the measurement it came from is in
  `/test/state` — compare them before touching the words.

## Release

CI (`.github/workflows/build.yml`) packages all three platforms on every push
to `main`, every pull request and every `v*` tag, and uploads the artifacts
(14-day retention). It does not publish.

1. Bump `version` in `package.json`. That number is what `/test/state` and the
   smoke test compare against, and what names the artifacts.
2. Commit, tag `vX.Y.Z`, push the tag.
3. Wait for the `build` workflow. Linux and Windows must be green including
   their smoke step. The macOS smoke step is advisory (see the workflow's own
   comment): the platform is **built**, not launched, until someone with a Mac
   proves otherwise with `tools/smoke.mjs`.
4. Download the three artifact bundles, create the GitHub Release for the tag
   and attach them. The README's platform table is the public claim; keep it
   equal to what was actually verified.

Playback cannot be proved by CI (runners have no audio device). On Linux,
`node tools/verify-audible.mjs` captures the PipeWire sink while the app plays
and exits non-zero on silence; that is how the Linux row earns "playback
tested".

## Rollback

There is no server side. Rolling back is installing the previous release's
artifact; it is listed under Releases. The profile files are forward- and
backward-tolerant by construction (unknown keys dropped, missing keys
defaulted). The only visible consequence of going back across 0.3 → 0.2 is the
standing band not being restored, per the `cutScope` note above.

## Footguns

- `build/icon*` and `build/icons/` are committed inputs, regenerated by
  `node tools/make-icons.mjs`; CI regenerates them too, so a stale icon is
  caught, but do not hand-edit them.
- `docs/media/*.png` are README images. Do not commit screenshots or profiling
  output anywhere else; `docs/progress/` is gitignored for that reason.
- The renderer bundle includes `src/main/tuning/bandLayout.ts` and
  `src/main/directory/tags.ts` directly (pure modules). They must stay free of
  Node imports.
- `noUnusedLocals`/`noUnusedParameters` are on. Unreferenced exports fail the
  typecheck; that is the intended way to notice dead code.
- The test hooks evaluate arbitrary JavaScript in the renderer. They are off
  unless `PSPPCPR_TEST_HOOKS=1` and the descriptor is written `0600`; never
  set the variable in a shipped launcher.
- `electron-builder.yml` sets `mac.identity: null` (no signing). The
  workflow's ad-hoc `codesign --deep` is the only signature the macOS bundle
  gets.
