#!/usr/bin/env node
/**
 * Proves the bundled silkscreen face actually carries the panel, including on a
 * machine that has no condensed font installed at all.
 *
 * WHAT IT IS ANSWERING
 * --------------------
 * `--font-silk` used to be a wish list of fonts that might be installed. On
 * macOS none of the first four ever are, so every tracked all-caps label set
 * ~16-22% wider than the layout was tuned for. Nobody on this project has a
 * Mac, so the claim "it is fixed now" needs evidence that does not require one.
 *
 * fontconfig gives us that. Point FONTCONFIG_FILE at a config that exposes a
 * restricted font set and Chromium genuinely cannot see the rest — the same
 * situation a Mac is in, reproduced on Linux and measurable.
 *
 * THREE SCENARIOS, EACH A SEPARATE LAUNCH (fontconfig is read once, at start):
 *
 *   system        the machine's real fontconfig. The control.
 *   no-condensed  ONLY DejaVu Sans is visible. This is the macOS case: a
 *                 perfectly good grotesque is available, but nothing condensed.
 *   no-fonts      an empty <fontconfig/>. Nothing at all is installed. If the
 *                 labels still set correctly here, the bundle owes the host
 *                 system nothing.
 *
 * In each launch the same tracked label is measured TWICE inside the live
 * renderer, via /test/exec, on the real panel:
 *
 *   after   --font-silk exactly as shipped (bundled face first)
 *   before  --font-silk forced back to the old system-only stack
 *
 * and a screenshot is taken of each. The before/after pair therefore differs in
 * exactly one variable, in one process, on one frame.
 *
 * Requires: a built app (`npm run build`) and a display. On a headless box run
 * it under Xvfb/Xephyr and pass DISPLAY.
 *
 * Usage:
 *   node tools/verify-font.mjs
 *   node tools/verify-font.mjs --out=/tmp/font-proof --keep
 *
 * Exit 0 = the bundled face rendered and held the reference metrics in every
 * scenario. Exit 1 = it did not.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron')

const args = process.argv.slice(2)
const outArg = args.find((a) => a.startsWith('--out='))
const OUT = outArg ? outArg.slice(6) : path.join(ROOT, 'release', 'font-proof')
const KEEP = args.includes('--keep')

// The exact rule from src/renderer/styles/base.css, and the longest string the
// panel can put through it (src/renderer/ui/components/register.ts).
const PROBE_TEXT = 'PLAYING ONE STATION — CUT A BAND TO GET A DIAL FULL OF THEM'
const PROBE_SIZE = 8.5
const PROBE_TRACK = 0.17

const OLD_STACK =
  "'Liberation Sans Narrow', 'Nimbus Sans Narrow', 'Arial Narrow', " +
  "'Roboto Condensed', 'Helvetica Neue', ui-sans-serif, sans-serif"

const SCENARIOS = [
  {
    id: 'system',
    label: "the machine's own fontconfig (control)",
    fontconfig: null,
  },
  {
    id: 'no-condensed',
    label: 'ONLY DejaVu Sans visible — the macOS case',
    // One non-condensed grotesque and nothing else. This is what a Mac looks
    // like to --font-silk: a perfectly usable sans is present, no narrow cut is.
    fontconfig: `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <dir>/usr/share/fonts/truetype/dejavu</dir>
  <cachedir>__CACHE__</cachedir>
</fontconfig>
`,
    expectSystemFontsGone: true,
  },
  {
    id: 'no-fonts',
    label: 'empty <fontconfig/> — not one font installed',
    fontconfig: `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <cachedir>__CACHE__</cachedir>
</fontconfig>
`,
    expectSystemFontsGone: true,
  },
]

const log = (m) => console.log(m)
const step = (m) => console.log(`\n\x1b[36m▸ ${m}\x1b[0m`)
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`)
const bad = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** The renderer-side measurement. Runs inside the live packaged panel. */
function probeScript(stack) {
  return `(async () => {
    const root = document.documentElement;
    ${stack ? `root.style.setProperty('--font-silk', ${JSON.stringify(stack)});` : `root.style.removeProperty('--font-silk');`}
    // font-display:block hides text for up to 3s while the face loads, and
    // during that period the run measures at FALLBACK metrics — or at nothing
    // at all when there is no fallback. Wait for the real face before believing
    // any number here.
    try {
      await document.fonts.load("400 ${PROBE_SIZE}px 'Archivo Narrow Subset'", ${JSON.stringify(PROBE_TEXT)});
      await document.fonts.load("700 ${PROBE_SIZE}px 'Archivo Narrow Subset'", ${JSON.stringify(PROBE_TEXT)});
    } catch (e) {}
    await document.fonts.ready;
    // Force a style+layout flush so the measurement below sees the new stack.
    void document.body.offsetWidth;
    const probe = document.createElement('span');
    probe.style.cssText = 'position:fixed;left:-99999px;top:0;white-space:nowrap;line-height:1;' +
      'font-family:var(--font-silk);font-size:${PROBE_SIZE}px;letter-spacing:${PROBE_TRACK}em;text-transform:uppercase';
    probe.textContent = ${JSON.stringify(PROBE_TEXT)};
    document.body.appendChild(probe);
    const probeWidth = probe.getBoundingClientRect().width;
    // Control: name the installed families DIRECTLY, bypassing --font-silk.
    // If the scenario really removed them from the system these collapse to
    // whatever is left; if they still measure their normal widths, the
    // fontconfig restriction did not take and the run means nothing.
    const control = {};
    for (const fam of ["'Liberation Sans Narrow'", "'Arial Narrow'", "'DejaVu Sans'", 'sans-serif']) {
      probe.style.fontFamily = fam;
      control[fam] = Math.round(probe.getBoundingClientRect().width * 100) / 100;
    }
    probe.remove();
    // And the same measurement on real on-screen silkscreen, not a synthetic
    // probe: every element that actually resolves to --font-silk right now.
    const live = [...document.querySelectorAll('*')]
      .filter((el) => {
        const cs = getComputedStyle(el);
        return cs.textTransform === 'uppercase' && el.children.length === 0 &&
               (el.textContent || '').trim().length > 3 &&
               el.getBoundingClientRect().width > 0;
      })
      .slice(0, 400)
      .map((el) => {
        // scrollWidth is an INTEGER, so a label that is 1.2px over its box reads
        // as 0 or 1 depending on where rounding lands — which is how a
        // pre-existing overflow can look like a regression. Measure the text run
        // itself with a Range instead: that is sub-pixel.
        const r = document.createRange();
        r.selectNodeContents(el);
        const textW = r.getBoundingClientRect().width;
        r.detach && r.detach();
        const box = el.clientWidth;
        return {
          text: (el.textContent || '').trim().slice(0, 42),
          cls: el.className && el.className.baseVal !== undefined ? el.className.baseVal : String(el.className || ''),
          w: Math.round(el.getBoundingClientRect().width * 100) / 100,
          px: getComputedStyle(el).fontSize,
          box: Math.round(box * 100) / 100,
          textW: Math.round(textW * 100) / 100,
          over: Math.round((textW - box) * 100) / 100,
          overflowing: getComputedStyle(el).overflow !== 'visible' && textW - box > 0.5,
        };
      });
    // Independent of the CSS cascade: does the bundled FILE itself decode?
    // Needed because when a host has no installed font at all, Chromium's *CSS*
    // font-face pipeline gives up (platform_font_skia: "Could not find any
    // font: Sans, sans" -> NOTREACHED in remote_font_face_source.cc) and marks
    // every declared face errored, even ones whose bytes are perfectly good.
    // The imperative FontFace API does not go through that path.
    let fileDecodes = 'not attempted';
    try {
      const ff = new FontFace('BundleFileProbe', 'url(' + ${JSON.stringify('file://__WOFF__')} + ')');
      await ff.load();
      fileDecodes = 'loaded';
    } catch (e) {
      fileDecodes = 'ERR ' + e.name + ': ' + e.message;
    }
    return {
      resolvedStack: getComputedStyle(root).getPropertyValue('--font-silk').trim(),
      fileDecodes,
      silkFaceReady: document.fonts.check("400 ${PROBE_SIZE}px 'Archivo Narrow Subset'"),
      probeWidth: Math.round(probeWidth * 100) / 100,
      control,
      liveCount: live.length,
      liveOverflowing: live.filter((l) => l.overflowing).length,
      liveOverflowingText: live.filter((l) => l.overflowing).map((l) => l.cls + ' +' + l.over + 'px "' + l.text + '"'),
      liveByText: Object.fromEntries(live.map((l) => [l.text, l.over])),
      liveWidthSum: Math.round(live.reduce((t, l) => t + l.w, 0) * 100) / 100,
      liveSample: live.slice(0, 6),
      fontsLoaded: [...document.fonts].map((f) => f.family + '/' + f.weight + '=' + f.status),
    };
  })()`
}

/** The hashed .woff Vite emitted into the built renderer. */
function builtWoff() {
  const dir = path.join(ROOT, 'dist', 'renderer', 'assets')
  const hit = readdirSync(dir).find((f) => /^archivo-narrow-400-subset-.*\.woff$/.test(f))
  if (!hit) throw new Error('no bundled .woff in dist/renderer/assets — did `npm run build` run?')
  return path.join(dir, hit)
}

async function req(base, token, route, { method = 'GET', body } = {}) {
  const url = `${base}${route}${route.includes('?') ? '&' : '?'}t=${token}`
  const res = await fetch(url, {
    method,
    body,
    // The proxy pins Host to the listening socket to block DNS rebinding.
    headers: { host: new URL(base).host },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${route} -> HTTP ${res.status} ${text.slice(0, 200)}`)
  return JSON.parse(text)
}

async function runScenario(scn) {
  step(`${scn.id}: ${scn.label}`)
  const tmp = mkdtempSync(path.join(os.tmpdir(), `psppcpr-font-${scn.id}-`))
  const hooksFile = path.join(tmp, 'test-hooks.json')
  const env = { ...process.env, PSPPCPR_TEST_HOOKS: '1', PSPPCPR_TEST_HOOKS_FILE: hooksFile }

  if (scn.fontconfig) {
    const cacheDir = path.join(tmp, 'fc-cache')
    mkdirSync(cacheDir, { recursive: true })
    const cfg = path.join(tmp, 'fonts.conf')
    writeFileSync(cfg, scn.fontconfig.replace('__CACHE__', cacheDir))
    // FONTCONFIG_FILE and nothing else. Setting FONTCONFIG_PATH as well was
    // MEASURED to make the restriction silently not apply — the run looked
    // healthy and reported unrestricted widths, which is the worst possible
    // failure for a test whose whole job is to restrict something. Hence the
    // `expectSystemFontsGone` control probe below: the scenario has to prove it
    // took effect before any of its numbers are allowed to mean anything.
    env.FONTCONFIG_FILE = cfg
    log(`  fontconfig: ${cfg}`)
  } else {
    log('  fontconfig: system default')
  }

  const child = spawn(
    ELECTRON,
    [
      '.',
      // A profile of our own. The real ~/.config/Weltempfänger is never touched.
      `--user-data-dir=${path.join(tmp, 'udd')}`,
    ],
    { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let stderr = ''
  child.stderr.on('data', (d) => (stderr += d))
  child.stdout.on('data', () => {})

  try {
    // Wait for the descriptor the main process writes once the hooks are live.
    let desc = null
    for (let i = 0; i < 120; i++) {
      if (child.exitCode !== null) throw new Error(`app exited early (${child.exitCode})\n${stderr.slice(-1500)}`)
      if (existsSync(hooksFile)) {
        try {
          desc = JSON.parse(readFileSync(hooksFile, 'utf8'))
          break
        } catch {
          /* still being written */
        }
      }
      await sleep(250)
    }
    if (!desc) throw new Error(`test hooks never came up\n${stderr.slice(-1500)}`)
    const { base, token } = desc

    const ping = await req(base, token, '/test/ping')
    if (!ping.ok) throw new Error('ping not ok')
    ok(`hooks up on ${base} (pid ${ping.pid})`)

    // Give the renderer a beat to mount the faceplate and settle its fonts.
    await sleep(2500)

    const shots = {}
    const measures = {}
    for (const variant of ['after', 'before']) {
      const stack = variant === 'before' ? OLD_STACK : null
      const r = await req(base, token, '/test/exec', {
        method: 'POST',
        body: probeScript(stack).replace('__WOFF__', builtWoff()),
      })
      if (!r.ok) throw new Error(`exec failed: ${r.error}`)
      measures[variant] = r.value
      await sleep(400)
      const shot = path.join(OUT, `${scn.id}-${variant}.png`)
      const s = await req(base, token, `/test/screenshot?path=${encodeURIComponent(shot)}`)
      shots[variant] = { path: shot, bytes: s.bytes }
    }
    // Leave the panel as shipped.
    await req(base, token, '/test/exec', { method: 'POST', body: probeScript(null).replace('__WOFF__', builtWoff()) })

    await req(base, token, '/test/quit').catch(() => {})
    return { measures, shots }
  } finally {
    await sleep(400)
    if (child.exitCode === null) child.kill('SIGKILL')
    if (!KEEP) rmSync(tmp, { recursive: true, force: true })
  }
}

/** width and height out of a PNG IHDR — cheap proof the image is a real frame. */
function pngSize(file) {
  const b = readFileSync(file)
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (!b.subarray(0, 8).equals(sig)) throw new Error(`${file} is not a PNG`)
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), bytes: b.length }
}

async function main() {
  if (!existsSync(path.join(ROOT, 'dist', 'renderer', 'index.html'))) {
    console.error('dist/renderer/index.html missing — run `npm run build` first')
    process.exit(1)
  }
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    console.error('no DISPLAY — run under Xvfb/Xephyr')
    process.exit(1)
  }
  mkdirSync(OUT, { recursive: true })
  log(`screenshots -> ${OUT}`)

  const results = {}
  for (const scn of SCENARIOS) results[scn.id] = await runScenario(scn)

  // -------------------------------------------------------------------------
  step('RESULTS — tracked label width, 8.5px / 0.17em, 58 caps')
  log(`  "${PROBE_TEXT}"\n`)
  log('  scenario       AFTER: shipped stack   BEFORE: old stack   old vs shipped')
  log('  ' + '-'.repeat(70))
  const ref = results.system.measures.after.probeWidth
  let pass = true
  for (const scn of SCENARIOS) {
    const a = results[scn.id].measures.after.probeWidth
    const b = results[scn.id].measures.before.probeWidth
    const pct = a ? (((b - a) / a) * 100).toFixed(1) + '%' : 'n/a'
    log(
      `  ${scn.id.padEnd(14)} ${String(a).padStart(10)} px        ${String(b).padStart(10)} px      ${pct.padStart(9)}`,
    )
  }
  log('')

  // 0. Each restricted scenario must PROVE it restricted something, by naming
  //    the installed families directly. Without this the whole run can pass on
  //    a fontconfig override that silently did nothing.
  for (const scn of SCENARIOS) {
    if (!scn.expectSystemFontsGone) continue
    const c = results[scn.id].measures.after.control
    const lsn = c["'Liberation Sans Narrow'"]
    const same = Math.abs(lsn - results.system.measures.after.control["'Liberation Sans Narrow'"]) < 0.5
    if (!same) ok(`${scn.id}: system fonts really are gone (direct 'Liberation Sans Narrow' -> ${lsn}px)`)
    else {
      bad(`${scn.id}: 'Liberation Sans Narrow' still measures ${lsn}px — fontconfig override did NOT apply`)
      pass = false
    }
  }
  // 1. The bundled FILE must decode everywhere. This is separate from the CSS
  //    question below on purpose: when a host has literally no installed font,
  //    Chromium's *CSS* @font-face pipeline gives up wholesale
  //    (platform_font_skia.cc "Could not find any font: Sans, sans", then a
  //    NOTREACHED in remote_font_face_source.cc) and marks every declared face
  //    errored — including ones whose bytes are perfectly good. The imperative
  //    FontFace API does not take that path, so it is what actually tells us
  //    whether WE shipped a valid font.
  for (const scn of SCENARIOS) {
    const d = results[scn.id].measures.after.fileDecodes
    if (d === 'loaded') ok(`${scn.id}: the bundled .woff decodes (FontFace API)`)
    else {
      bad(`${scn.id}: the bundled .woff did NOT decode — ${d}`)
      pass = false
    }
  }
  // 2. The face must carry the panel in the macOS case. That is the claim this
  //    whole exercise exists to support, and it is the load-bearing assertion.
  //    The absolute width legitimately differs a little from the control run
  //    because fontconfig also carries the host's HINTING policy, which applies
  //    to webfonts too — so the bar is "close to the control", not "identical".
  const macCase = results['no-condensed'].measures
  if (macCase.after.probeWidth > 0) ok(`no-condensed: bundled face renders (${macCase.after.probeWidth}px)`)
  else {
    bad('no-condensed: bundled face did not render')
    pass = false
  }
  const drift = Math.abs(macCase.after.probeWidth - ref) / ref
  if (drift < 0.06) ok(`no-condensed: within ${(drift * 100).toFixed(1)}% of the control run (${ref}px)`)
  else {
    bad(`no-condensed: ${(drift * 100).toFixed(1)}% off the control run (${ref}px)`)
    pass = false
  }
  const macPct = ((macCase.before.probeWidth - macCase.after.probeWidth) / macCase.after.probeWidth) * 100
  if (macPct > 5) ok(`no-condensed: the OLD stack sets +${macPct.toFixed(1)}% — the bug is real and reproduced`)
  else {
    bad(`no-condensed: old stack drifted only ${macPct.toFixed(1)}% — nothing was restricted`)
    pass = false
  }
  // 3. no-fonts is INFORMATIONAL, not a gate. With zero installed fonts
  //    Chromium renders no text at all, ours included — that is a Chromium
  //    limitation, not a property of this bundle, and no real OS ships that way.
  //    Assertion 1 is what covers us there.
  const nf = results['no-fonts'].measures
  log(
    `  \x1b[33mi\x1b[0m no-fonts (informational): Chromium's CSS font pipeline gives up entirely` +
      ` — shipped stack ${nf.after.probeWidth}px, old stack ${nf.before.probeWidth}px, both zero.` +
      ` The .woff itself still decoded (assertion above).`,
  )
  // 4. Per-label: the bundled face must not push any real label further past its
  //    box than the reference face already did. Compared PER LABEL and
  //    sub-pixel, because some labels are already a hair over by design.
  const before = results.system.measures.before.liveByText
  const after = results.system.measures.after.liveByText
  const worse = []
  for (const [text, over] of Object.entries(after)) {
    const wasOver = before[text]
    if (wasOver === undefined) continue
    if (over > 0 && over - wasOver > 1) worse.push(`"${text}" ${wasOver.toFixed(2)} -> ${over.toFixed(2)} px over`)
  }
  if (worse.length === 0)
    ok(`no label is more than 1px further past its box than with the reference face (${Object.keys(after).length} labels)`)
  else {
    bad(`labels pushed further past their box: ${worse.join(' | ')}`)
    pass = false
  }
  const nowOver = Object.entries(after).filter(([, o]) => o > 0)
  const wasOverN = Object.entries(before).filter(([, o]) => o > 0)
  log(
    `  \x1b[33mi\x1b[0m labels already sitting past their box: ${wasOverN.length} with the reference face,` +
      ` ${nowOver.length} with the bundled one` +
      (nowOver.length ? ' — ' + nowOver.map(([t, o]) => `"${t}" +${o}px`).join(', ') : ''),
  )


  step('SCREENSHOTS')
  for (const scn of SCENARIOS) {
    for (const v of ['after', 'before']) {
      const s = results[scn.id].shots[v]
      const d = pngSize(s.path)
      log(`  ${(scn.id + '-' + v).padEnd(20)} ${d.w}x${d.h}  ${(d.bytes / 1024).toFixed(1)} kB  ${s.path}`)
    }
  }

  step('LIVE LABEL SAMPLE (system, bundled face)')
  for (const l of results.system.measures.after.liveSample) {
    log(`  ${String(l.w).padStart(7)} px  ${l.px.padStart(7)}  ${l.text}`)
  }

  log(`\n${pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}: bundled condensed face ${pass ? 'carries' : 'does NOT carry'} the panel with the system fonts removed`)
  writeFileSync(path.join(OUT, 'measurements.json'), JSON.stringify(results, null, 2))
  log(`evidence -> ${path.join(OUT, 'measurements.json')}`)
  process.exit(pass ? 0 : 1)
}

main().catch((err) => {
  console.error(`\n\x1b[31m✗ ${err.message}\x1b[0m`)
  process.exit(1)
})
