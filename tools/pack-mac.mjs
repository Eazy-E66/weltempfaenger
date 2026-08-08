#!/usr/bin/env node
/**
 * macOS .app cross-builder for Weltempfänger.
 *
 * WHY THIS EXISTS
 * ---------------
 * electron-builder cannot produce a macOS bundle from Linux — it needs macOS
 * host tooling for the .app layout, DMG creation and signing. This script does
 * the bundle assembly by hand, correctly, from the official Electron release.
 *
 * WHAT IT PRODUCES
 * ----------------
 *   release/mac/<product>-<version>-<arch>.zip   containing <product>.app
 *
 * A .zip, NOT a .dmg. A DMG is an HFS+/APFS disk image; creating one requires
 * hdiutil (macOS only). There is no honest way to fake it on Linux.
 *
 * WHAT YOU MUST KNOW BEFORE SHIPPING THIS
 * ---------------------------------------
 *   - UNSIGNED. No Developer ID certificate exists for this project.
 *   - NOT NOTARIZED.
 *   - CROSS-BUILT on Linux and NEVER LAUNCHED — no macOS machine is available
 *     to this build. Verification here is structural only.
 *   - On a real Mac it will be quarantined by Gatekeeper. A user would have to
 *     strip the quarantine attribute by hand:
 *         xattr -dr com.apple.quarantine /Applications/Weltempfänger.app
 *   - The real path to a trustworthy macOS build is CI on macos-latest
 *     (.github/workflows/build.yml), where electron-builder runs natively.
 *
 * Usage:
 *   node tools/pack-mac.mjs                 # both arches
 *   node tools/pack-mac.mjs --arch=arm64    # one arch
 *   node tools/pack-mac.mjs --keep-app      # leave the unzipped .app in place
 */

import { execFileSync, spawnSync } from 'node:child_process'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  readdirSync,
  lstatSync,
  readlinkSync,
} from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = path.join(ROOT, 'build', '.cache')
const OUT = path.join(ROOT, 'release', 'mac')
const STAGE = path.join(ROOT, 'release', '.mac-stage')

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const builderCfg = readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8')

const PRODUCT = pkg.productName ?? pkg.name
const VERSION = pkg.version
const APP_ID = (/^appId:\s*(\S+)/m.exec(builderCfg) ?? [, 'org.psppcpr.weltempfaenger'])[1]
const ELECTRON_VERSION = JSON.parse(
  readFileSync(path.join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8'),
).version

// ASCII slug for filenames; the bundle itself keeps the umlaut.
const SLUG = 'weltempfaenger'

const args = process.argv.slice(2)
const archArg = args.find((a) => a.startsWith('--arch='))
const ARCHES = archArg ? [archArg.split('=')[1]] : ['x64', 'arm64']
const KEEP_APP = args.includes('--keep-app')

const log = (m) => console.log(m)
const step = (m) => console.log(`\n\x1b[36m▸ ${m}\x1b[0m`)
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`)
const warn = (m) => console.log(`  \x1b[33m!\x1b[0m ${m}`)

function fail(m) {
  console.error(`\n\x1b[31m✗ ${m}\x1b[0m`)
  process.exit(1)
}

function have(bin) {
  return spawnSync('command', ['-v', bin], { shell: true }).status === 0
}

// ---------------------------------------------------------------------------
// 1. Download the official Electron darwin build
// ---------------------------------------------------------------------------

async function fetchElectron(arch) {
  const name = `electron-v${ELECTRON_VERSION}-darwin-${arch}.zip`
  const dest = path.join(CACHE, name)
  if (existsSync(dest) && statSync(dest).size > 1_000_000) {
    ok(`cached ${name} (${(statSync(dest).size / 1e6).toFixed(1)} MB)`)
    return dest
  }
  const url = `https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/${name}`
  mkdirSync(CACHE, { recursive: true })
  const tmp = `${dest}.part`

  // ~100 MB from GitHub's CDN drops often enough that a bare fetch makes this
  // script look flaky. Retry with backoff before giving up.
  const ATTEMPTS = 4
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      log(`  downloading ${url}${attempt > 1 ? ` (attempt ${attempt}/${ATTEMPTS})` : ''}`)
      const res = await fetch(url, { redirect: 'follow' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp))
      break
    } catch (err) {
      rmSync(tmp, { force: true })
      const reason = err?.cause?.message ?? err?.message ?? String(err)
      if (attempt === ATTEMPTS) fail(`download failed after ${ATTEMPTS} attempts: ${reason}`)
      const waitMs = 2000 * attempt
      warn(`download failed (${reason}) — retrying in ${waitMs / 1000}s`)
      await new Promise((r) => setTimeout(r, waitMs))
    }
  }
  renameSync(tmp, dest)
  ok(`downloaded ${name} (${(statSync(dest).size / 1e6).toFixed(1)} MB)`)
  return dest
}

// ---------------------------------------------------------------------------
// 2. app.asar — same payload electron-builder ships
// ---------------------------------------------------------------------------

function buildAsar() {
  const dist = path.join(ROOT, 'dist')
  if (!existsSync(dist)) fail('dist/ not found — run `npm run build` first')

  const stageApp = path.join(STAGE, 'app')
  rmSync(stageApp, { recursive: true, force: true })
  mkdirSync(stageApp, { recursive: true })

  // Mirror electron-builder's `files` allowlist: dist/** + package.json, no maps.
  cpFiltered(dist, path.join(stageApp, 'dist'))
  const meta = { ...pkg }
  // Match the homepage electron-builder injects via extraMetadata.
  meta.homepage ??= 'https://github.com/psppcpr/weltempfaenger'
  writeFileSync(path.join(stageApp, 'package.json'), JSON.stringify(meta, null, 2))

  const asarBin = path.join(ROOT, 'node_modules', '@electron', 'asar', 'bin', 'asar.js')
  if (!existsSync(asarBin)) fail('@electron/asar not found in node_modules')
  const asarOut = path.join(STAGE, 'app.asar')
  rmSync(asarOut, { force: true })
  execFileSync(process.execPath, [asarBin, 'pack', stageApp, asarOut], { stdio: 'inherit' })
  ok(`app.asar built (${statSync(asarOut).size} bytes)`)
  return asarOut
}

function cpFiltered(src, dst) {
  mkdirSync(dst, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name)
    const d = path.join(dst, entry.name)
    if (entry.isDirectory()) cpFiltered(s, d)
    else if (!entry.name.endsWith('.map')) writeFileSync(d, readFileSync(s))
  }
}

// ---------------------------------------------------------------------------
// 3. Info.plist rewriting (XML plist, targeted key replacement)
// ---------------------------------------------------------------------------

function setPlistString(xml, key, value) {
  const esc = value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  const re = new RegExp(`(<key>${key}</key>\\s*<string>)([\\s\\S]*?)(</string>)`)
  if (re.test(xml)) return xml.replace(re, `$1${esc}$3`)
  // Key absent — insert before the closing </dict> of the root dict.
  return xml.replace(/\n?<\/dict>\n<\/plist>/, `\n\t<key>${key}</key>\n\t<string>${esc}</string>\n</dict>\n</plist>`)
}

function readPlist(p) {
  const buf = readFileSync(p)
  if (buf.subarray(0, 6).toString('latin1') === 'bplist') {
    fail(`${p} is a BINARY plist; this script only rewrites XML plists.`)
  }
  return buf.toString('utf8')
}

// ---------------------------------------------------------------------------
// 4. Assemble the bundle
// ---------------------------------------------------------------------------

function assemble(arch, zipPath, asarPath) {
  const work = path.join(STAGE, arch)
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })

  step(`unpacking Electron (${arch})`)
  // `unzip` restores symlinks and the executable bit; Node's own zip readers
  // generally do not. A flattened Electron Framework symlink silently breaks
  // the bundle, so this must not be swapped for a JS unzipper casually.
  execFileSync('unzip', ['-q', zipPath, '-d', work], { stdio: 'inherit' })

  const srcApp = path.join(work, 'Electron.app')
  if (!existsSync(srcApp)) fail('Electron.app not found in the downloaded zip')
  const appDir = path.join(work, `${PRODUCT}.app`)
  renameSync(srcApp, appDir)
  ok(`Electron.app → ${PRODUCT}.app`)

  const contents = path.join(appDir, 'Contents')
  const macos = path.join(contents, 'MacOS')
  const resources = path.join(contents, 'Resources')
  const frameworks = path.join(contents, 'Frameworks')

  // --- main executable ---
  step('renaming executable and rewriting Info.plist')
  renameSync(path.join(macos, 'Electron'), path.join(macos, PRODUCT))
  ok(`Contents/MacOS/Electron → Contents/MacOS/${PRODUCT}`)

  let plist = readPlist(path.join(contents, 'Info.plist'))
  plist = setPlistString(plist, 'CFBundleName', PRODUCT)
  plist = setPlistString(plist, 'CFBundleDisplayName', PRODUCT)
  plist = setPlistString(plist, 'CFBundleIdentifier', APP_ID)
  plist = setPlistString(plist, 'CFBundleExecutable', PRODUCT)
  plist = setPlistString(plist, 'CFBundleIconFile', 'icon.icns')
  plist = setPlistString(plist, 'CFBundleShortVersionString', VERSION)
  plist = setPlistString(plist, 'CFBundleVersion', VERSION)
  writeFileSync(path.join(contents, 'Info.plist'), plist)
  ok('Info.plist: name/displayName/identifier/executable/icon/version rewritten')

  // --- icon ---
  const icns = path.join(ROOT, 'build', 'icon.icns')
  if (existsSync(icns)) {
    writeFileSync(path.join(resources, 'icon.icns'), readFileSync(icns))
    rmSync(path.join(resources, 'electron.icns'), { force: true })
    ok('icon.icns installed, stock electron.icns removed')
  } else {
    warn('build/icon.icns missing — run `node tools/make-icons.mjs`')
  }

  // --- app payload ---
  rmSync(path.join(resources, 'default_app.asar'), { force: true })
  writeFileSync(path.join(resources, 'app.asar'), readFileSync(asarPath))
  ok('Contents/Resources/app.asar injected, default_app.asar removed')

  // --- helper apps ---
  // Chromium locates its child processes by a name derived from the main
  // bundle, so the helpers must be renamed in lockstep with the app or the
  // renderer/GPU processes will not spawn. This mirrors electron-builder.
  step('renaming helper apps')
  for (const entry of readdirSync(frameworks)) {
    if (!entry.endsWith('.app') || !entry.includes('Helper')) continue
    const suffix = entry.replace(/^Electron Helper/, '').replace(/\.app$/, '') // '' | ' (GPU)' | ...
    const newName = `${PRODUCT} Helper${suffix}`
    const oldDir = path.join(frameworks, entry)
    const newDir = path.join(frameworks, `${newName}.app`)
    renameSync(oldDir, newDir)

    const hMacos = path.join(newDir, 'Contents', 'MacOS')
    const oldExe = readdirSync(hMacos)[0]
    renameSync(path.join(hMacos, oldExe), path.join(hMacos, newName))

    const hPlistPath = path.join(newDir, 'Contents', 'Info.plist')
    let hPlist = readPlist(hPlistPath)
    const idSuffix = suffix.replace(/[ ()]/g, '') // '' | 'GPU' | 'Plugin' | 'Renderer'
    hPlist = setPlistString(hPlist, 'CFBundleName', newName)
    hPlist = setPlistString(hPlist, 'CFBundleDisplayName', newName)
    hPlist = setPlistString(hPlist, 'CFBundleExecutable', newName)
    hPlist = setPlistString(
      hPlist,
      'CFBundleIdentifier',
      `${APP_ID}.helper${idSuffix ? '.' + idSuffix : ''}`,
    )
    writeFileSync(hPlistPath, hPlist)
    ok(`${entry} → ${newName}.app`)
  }

  return appDir
}

// ---------------------------------------------------------------------------
// 5. Structural verification (this is NOT a launch test)
// ---------------------------------------------------------------------------

function verify(appDir, arch) {
  step(`verifying bundle structure (${arch})`)
  let bad = 0
  const need = (rel, kind = 'file') => {
    const p = path.join(appDir, rel)
    let good
    try {
      const st = lstatSync(p)
      good = kind === 'dir' ? st.isDirectory() : kind === 'link' ? st.isSymbolicLink() : st.isFile()
    } catch {
      good = false
    }
    if (good) ok(`${kind.padEnd(4)} ${rel}`)
    else {
      console.log(`  \x1b[31m✗\x1b[0m ${kind.padEnd(4)} ${rel} MISSING`)
      bad++
    }
    return good
  }

  need('Contents/Info.plist')
  need('Contents/MacOS/' + PRODUCT)
  need('Contents/Resources/app.asar')
  need('Contents/Resources/icon.icns')
  need('Contents/Frameworks/Electron Framework.framework', 'dir')
  // The framework's top-level entries are symlinks into Versions/A. If these
  // came back as regular files or directories the bundle is corrupt.
  need('Contents/Frameworks/Electron Framework.framework/Electron Framework', 'link')
  need('Contents/Frameworks/Electron Framework.framework/Versions/Current', 'link')
  need('Contents/Frameworks/Electron Framework.framework/Resources', 'link')
  need(`Contents/Frameworks/${PRODUCT} Helper.app/Contents/MacOS/${PRODUCT} Helper`)

  // executable bit on the main binary
  const exe = path.join(appDir, 'Contents', 'MacOS', PRODUCT)
  if (existsSync(exe)) {
    const mode = statSync(exe).mode & 0o777
    if (mode & 0o111) ok(`executable bit set on main binary (mode ${mode.toString(8)})`)
    else {
      console.log(`  \x1b[31m✗\x1b[0m main binary not executable (mode ${mode.toString(8)})`)
      bad++
    }
    // Mach-O magic: feedfacf (64-bit LE) / cffaedfe as stored
    const magic = readFileSync(exe).subarray(0, 4).toString('hex')
    const known = { cffaedfe: 'Mach-O 64-bit LE', feedfacf: 'Mach-O 64-bit BE', cafebabe: 'Mach-O universal' }
    if (known[magic]) ok(`main binary magic ${magic} (${known[magic]})`)
    else {
      console.log(`  \x1b[31m✗\x1b[0m unexpected binary magic ${magic}`)
      bad++
    }
  }

  // Info.plist must actually parse, and carry the values we wrote.
  const plistPath = path.join(appDir, 'Contents', 'Info.plist')
  if (have('python3')) {
    const r = spawnSync(
      'python3',
      [
        '-c',
        'import plistlib,sys;d=plistlib.load(open(sys.argv[1],"rb"));' +
          'print("|".join(str(d.get(k,"<missing>")) for k in ' +
          '["CFBundleName","CFBundleDisplayName","CFBundleIdentifier","CFBundleExecutable","CFBundleIconFile","CFBundleShortVersionString"]))',
        plistPath,
      ],
      { encoding: 'utf8' },
    )
    if (r.status === 0) {
      ok(`Info.plist parses (plistlib): ${r.stdout.trim()}`)
      const vals = r.stdout.trim().split('|')
      if (vals[0] !== PRODUCT || vals[3] !== PRODUCT) {
        console.log('  \x1b[31m✗\x1b[0m plist values do not match product name')
        bad++
      }
    } else {
      console.log(`  \x1b[31m✗\x1b[0m Info.plist failed to parse: ${r.stderr.trim()}`)
      bad++
    }
  } else {
    warn('python3 unavailable — skipped strict plist parse')
  }

  // app.asar must be readable and contain our entry point.
  const asarBin = path.join(ROOT, 'node_modules', '@electron', 'asar', 'bin', 'asar.js')
  const r = spawnSync(process.execPath, [asarBin, 'list', path.join(appDir, 'Contents/Resources/app.asar')], {
    encoding: 'utf8',
  })
  if (r.status === 0 && r.stdout.includes('/dist/main/index.js')) {
    ok(`app.asar readable, ${r.stdout.trim().split('\n').length} entries, dist/main/index.js present`)
  } else {
    console.log('  \x1b[31m✗\x1b[0m app.asar unreadable or missing dist/main/index.js')
    bad++
  }

  return bad
}

// ---------------------------------------------------------------------------
// 6. Zip preserving symlinks + permissions, then re-verify the round trip
// ---------------------------------------------------------------------------

function zipApp(appDir, arch) {
  step(`zipping (${arch})`)
  mkdirSync(OUT, { recursive: true })
  const zipName = `${SLUG}-${VERSION}-${arch}-mac.zip`
  const zipPath = path.join(OUT, zipName)
  rmSync(zipPath, { force: true })
  // -y stores symlinks AS symlinks instead of following them. Without it the
  // Electron Framework symlinks become duplicate copies and the .app is
  // silently unlaunchable. -r recurse, -q quiet, -X drop extra attrs.
  execFileSync('zip', ['-q', '-y', '-r', '-X', zipPath, path.basename(appDir)], {
    cwd: path.dirname(appDir),
    stdio: 'inherit',
  })
  ok(`${path.relative(ROOT, zipPath)} (${(statSync(zipPath).size / 1e6).toFixed(1)} MB)`)

  // Round-trip: extract into a scratch dir and confirm the symlinks survived.
  const rt = path.join(STAGE, `roundtrip-${arch}`)
  rmSync(rt, { recursive: true, force: true })
  mkdirSync(rt, { recursive: true })
  execFileSync('unzip', ['-q', zipPath, '-d', rt])
  const fw = path.join(
    rt,
    path.basename(appDir),
    'Contents/Frameworks/Electron Framework.framework',
  )
  let links = 0
  for (const e of readdirSync(fw)) {
    if (lstatSync(path.join(fw, e)).isSymbolicLink()) {
      links++
      log(`    symlink survived: ${e} -> ${readlinkSync(path.join(fw, e))}`)
    }
  }
  const exeRt = path.join(rt, path.basename(appDir), 'Contents/MacOS', PRODUCT)
  const exeMode = statSync(exeRt).mode & 0o777
  if (links >= 3) ok(`${links} framework symlinks preserved through zip round trip`)
  else warn(`only ${links} symlinks survived the round trip — expected >= 3`)
  if (exeMode & 0o111) ok(`executable bit preserved through zip (mode ${exeMode.toString(8)})`)
  else warn(`executable bit LOST through zip (mode ${exeMode.toString(8)})`)
  rmSync(rt, { recursive: true, force: true })

  return zipPath
}

// ---------------------------------------------------------------------------

async function main() {
  for (const bin of ['unzip', 'zip']) {
    if (!have(bin)) fail(`required tool \`${bin}\` not found on PATH`)
  }

  log(`Weltempfänger macOS cross-build`)
  log(`  product  ${PRODUCT} ${VERSION}`)
  log(`  appId    ${APP_ID}`)
  log(`  electron ${ELECTRON_VERSION}`)
  log(`  arches   ${ARCHES.join(', ')}`)

  step('building app.asar from dist/')
  const asarPath = buildAsar()

  let problems = 0
  const made = []
  for (const arch of ARCHES) {
    step(`fetching Electron ${ELECTRON_VERSION} darwin-${arch}`)
    const zipPath = await fetchElectron(arch)
    const appDir = assemble(arch, zipPath, asarPath)
    problems += verify(appDir, arch)
    made.push(zipApp(appDir, arch))
    if (!KEEP_APP) rmSync(path.dirname(appDir), { recursive: true, force: true })
  }

  console.log('\n' + '─'.repeat(72))
  for (const m of made) console.log(`  ${path.relative(ROOT, m)}`)
  console.log('─'.repeat(72))
  console.log(
    '\n\x1b[33mUNSIGNED, CROSS-BUILT ON LINUX, NEVER LAUNCHED, NEVER PLAYBACK-TESTED.\x1b[0m\n' +
      'Verification above is structural only. On macOS this bundle is Gatekeeper-\n' +
      'quarantined; it has not been run on any Mac. Use the macos-latest CI job for\n' +
      'a natively built and actually launchable artifact.',
  )
  if (problems > 0) fail(`${problems} structural check(s) failed`)
}

main().catch((e) => fail(e?.stack ?? String(e)))
