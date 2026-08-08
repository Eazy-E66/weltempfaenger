import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { defineConfig, type Plugin } from 'vite'

/**
 * Dev-mode Electron supervisor.
 *
 * `npm run dev` is plain `vite`, so the dev server is the thing that owns the
 * session. This plugin hangs the desktop shell off it:
 *
 *   1. runs `tsc -p tsconfig.main.json --watch` for the main/preload side
 *   2. every time that watch build reports 0 errors, (re)launches Electron
 *   3. hands Electron `VITE_DEV_SERVER_URL`, which the main process reads to
 *      decide between loadURL(devserver) and loadFile(dist/renderer/index.html)
 *
 * The renderer keeps normal Vite HMR — only the main process is restarted, and
 * only when its own sources actually recompile.
 *
 * Escape hatches: set WELTEMPFAENGER_NO_ELECTRON=1 to run the dev server
 * headless (useful in containers/CI). Skipped automatically under Vitest.
 */
function electronDev(): Plugin {
  let projectRoot = process.cwd()
  let electron: ChildProcess | null = null
  let tsc: ChildProcess | null = null
  let shuttingDown = false

  const log = (msg: string) => console.log(`\x1b[35m[electron]\x1b[0m ${msg}`)

  function launchElectron(url: string) {
    if (shuttingDown) return
    if (electron) {
      const dying = electron
      electron = null
      dying.kill()
    }
    log(`launching with VITE_DEV_SERVER_URL=${url}`)
    const child = spawn(
      process.execPath,
      [path.join(projectRoot, 'node_modules', 'electron', 'cli.js'), '.'],
      {
        cwd: projectRoot,
        stdio: 'inherit',
        env: { ...process.env, VITE_DEV_SERVER_URL: url, NODE_ENV: 'development' },
      },
    )
    electron = child
    child.on('exit', (code) => {
      // Only a *self-initiated* exit (window closed) ends the session; exits we
      // caused by killing for a restart are ignored.
      if (electron === child && !shuttingDown) {
        log(`exited (code ${code ?? 0}) — stopping dev server`)
        shuttingDown = true
        process.exit(code ?? 0)
      }
    })
  }

  function startMainWatch(url: string) {
    tsc = spawn(
      process.execPath,
      [
        path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
        '-p',
        'tsconfig.main.json',
        '--watch',
        '--preserveWatchOutput',
        '--pretty',
        'false',
      ],
      { cwd: projectRoot, stdio: ['ignore', 'pipe', 'inherit'] },
    )

    tsc.stdout?.setEncoding('utf8')
    tsc.stdout?.on('data', (chunk: string) => {
      process.stdout.write(`\x1b[36m[main:tsc]\x1b[0m ${chunk}`)
      // tsc --watch prints "Found N errors." at the end of every build pass.
      const match = /Found (\d+) error/.exec(chunk)
      if (match && match[1] === '0') launchElectron(url)
    })
  }

  function shutdown() {
    shuttingDown = true
    electron?.kill()
    tsc?.kill()
  }

  return {
    name: 'weltempfaenger:electron-dev',
    apply: 'serve',

    configResolved(config) {
      // config.root is <project>/src/renderer — walk back up to the package root.
      projectRoot = path.resolve(config.root, '..', '..')
    },

    configureServer(server) {
      if (process.env.VITEST || process.env.WELTEMPFAENGER_NO_ELECTRON === '1') return

      server.httpServer?.once('listening', () => {
        // NOTE: server.resolvedUrls is still null at 'listening' — Vite fills it
        // in later, during listen()'s own post-processing. Derive the URL from
        // the bound socket instead, and only use resolvedUrls if it happens to
        // be ready. `base` is './' for packaging, but Vite always serves the dev
        // server from '/', so the origin is all we need.
        const address = server.httpServer?.address()
        const port =
          typeof address === 'object' && address ? address.port : server.config.server.port
        const protocol = server.config.server.https ? 'https' : 'http'
        const url = server.resolvedUrls?.local[0] ?? `${protocol}://localhost:${port}/`
        startMainWatch(url)
      })

      server.httpServer?.once('close', shutdown)
      process.once('SIGINT', shutdown)
      process.once('SIGTERM', shutdown)
    },
  }
}

export default defineConfig({
  // The renderer is its own little web app rooted at src/renderer.
  root: 'src/renderer',

  // Critical for packaging: the built renderer is loaded via file:// from
  // inside app.asar, so every asset reference must be relative, not /absolute.
  base: './',

  plugins: [electronDev()],

  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    // Electron 33 ships Chromium 130 — no legacy browser to support.
    target: 'chrome130',
    sourcemap: true,
    assetsDir: 'assets',
    chunkSizeWarningLimit: 1500,
  },

  server: {
    port: 5173,
    strictPort: false,
    fs: {
      // root is src/renderer, so src/shared lives outside it and must be
      // explicitly allowed for the dev server to serve those modules.
      allow: ['../..'],
    },
  },

  clearScreen: false,
})
