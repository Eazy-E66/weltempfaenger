#!/usr/bin/env node
/**
 * Bundles the silkscreen face.
 *
 * WHY THIS EXISTS
 * ---------------
 * `--font-silk` (src/renderer/styles/tokens.css) used to name only fonts that
 * happen to be installed on the user's machine:
 *
 *     Liberation Sans Narrow -> Nimbus Sans Narrow -> Arial Narrow
 *       -> Roboto Condensed -> Helvetica Neue -> ui-sans-serif
 *
 * On Linux the first one is nearly always present. On Windows `Arial Narrow`
 * usually is. On macOS NONE of the first four ship with the OS, so the stack
 * falls all the way through to a NON-condensed grotesque. Measured on this
 * machine with the app's own rules (see the header of make-font's `--report`
 * output), the 8.5px/0.17em hint line goes from 317.7px to 368.7px — 16.0%
 * wider. 97% of this app's text is 6.5-9.5px tracked caps inside fixed-width
 * plates, so that is a reflow-and-clip layout failure on a platform nobody on
 * this project can test. Not a taste problem.
 *
 * The fix is to stop asking. This script subsets ONE open-licensed condensed
 * face into the bundle and tokens.css names it first.
 *
 * WHICH FACE, AND WHY THAT ONE
 * ----------------------------
 * Archivo Narrow, by Omnibus-Type, SIL Open Font License 1.1 (redistribution
 * explicitly permitted, including bundled inside other software). It was picked
 * by MEASUREMENT, not taste: of eight open-licensed condensed candidates it is
 * the only one that is metrically indistinguishable from Liberation Sans Narrow,
 * which is what the layout was designed and tuned against on Linux. A-Z advance
 * at 100px: Liberation Sans Narrow 1444.14, Archivo Narrow 1444.31 (+0.01%).
 * Every real label in the app measures within 0.5%. So bundling it does not move
 * a single pixel of the Linux layout, and it gives macOS and Windows the same
 * one.
 *
 * WHAT IT PRODUCES
 * ----------------
 *   src/renderer/assets/fonts/archivo-narrow-<weight>-subset.woff
 *   src/renderer/assets/fonts/OFL.txt          (the licence, verbatim)
 *
 * WOFF1, not WOFF2: WOFF1 compresses with zlib, which Node has built in.
 * WOFF2 needs Brotli *font-transform* encoding, which it does not. Keeping this
 * script dependency-free is worth ~4 kB, in a file that is already an order of
 * magnitude smaller than a single Electron locale .pak. Chromium 130 (Electron
 * 33) supports WOFF1 everywhere.
 *
 * WHAT THE SUBSETTER DOES
 * -----------------------
 * A real, if minimal, TrueType subsetter — no npm dependency, in the same spirit
 * as tools/make-icons.mjs:
 *   - closes the wanted-codepoint set over composite glyph components
 *   - renumbers glyph ids densely and rewrites composite component references
 *   - rebuilds cmap (format 4) so that codepoints we did NOT keep are genuinely
 *     ABSENT. This is load-bearing: a codepoint still mapped to a now-empty
 *     glyph renders as a blank, whereas an unmapped one falls through to the
 *     next family in `--font-silk`, which is exactly what we want for a Cyrillic
 *     or CJK station name.
 *   - KEEPS every TrueType instruction, and cvt/fpgm/prep/gasp with them
 *   - drops GSUB/GPOS/GDEF/kern/hdmx/VDMX/LTSH/DSIG and glyph names (post 3.0)
 *   - keeps name IDs 0/1/2/3/4/6/13/14 so the copyright and the licence URL
 *     travel inside the font file itself
 *
 * HINTING — MEASURED, NOT ASSUMED
 * -------------------------------
 * The first version of this script stripped instructions, which is what every
 * "make it smaller" instinct says to do. It was wrong, and the font-proof
 * caught it. Advance widths of the SAME 44-letter label, subset vs upstream,
 * both loaded as webfonts in the same Chromium:
 *
 *     fontconfig                  subset      upstream
 *     the machine's own           269.53 px   266.86 px   (+1.0%)
 *     a bare config (hintfull)    253.03 px   279.03 px   (-9.3%)
 *
 * Whether a host applies TrueType hinting to advances is a property of the
 * HOST, not of us: fontconfig hintstyle on Linux, DirectWrite on Windows,
 * CoreText (which ignores TT hinting) on macOS. An unhinted subset therefore
 * measures differently from the face it was cut from on some of those hosts and
 * not others — which is precisely the class of untestable, platform-specific
 * width drift this whole exercise exists to remove. Keeping the instructions
 * costs ~9 kB across both weights and makes the subset metrically identical to
 * upstream under every hint style tested. Do not "optimise" them back out.
 *
 * Usage:
 *   node tools/make-font.mjs               # download (cached) + subset + write
 *   node tools/make-font.mjs --report      # also print a coverage/size report
 *   node tools/make-font.mjs --ttf         # also emit the raw subset .ttf
 *   node tools/make-font.mjs --src=DIR     # take upstream TTFs from DIR instead
 *   node tools/make-font.mjs --offline     # fail instead of downloading
 */

import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = path.join(ROOT, 'build', '.cache')
const OUT = path.join(ROOT, 'src', 'renderer', 'assets', 'fonts')

// Pinned to a commit, not a branch: a font that silently changes under you is a
// layout that silently changes under you. sha256 is checked after download.
const UPSTREAM_REPO = 'https://github.com/Omnibus-Type/ArchivoNarrow'
const UPSTREAM_COMMIT = '9793ec77b6682a26bc7a6ed523ca65cc3cb90aec'
const RAW = `https://raw.githubusercontent.com/Omnibus-Type/ArchivoNarrow/${UPSTREAM_COMMIT}`

const SOURCES = [
  {
    weight: 400,
    file: 'ArchivoNarrow-Regular.ttf',
    url: `${RAW}/fonts/ttf/ArchivoNarrow-Regular.ttf`,
    sha256: '8b2f285c60e450933c7deb3ad5acba00e5b34fb1b36f07490ab23d3f5e6df9e0',
    out: 'archivo-narrow-400-subset.woff',
  },
  {
    // The panel really does use 700 for the annunciator head, the logbook name
    // and the urging hint. Shipping only the 400 face would hand those to
    // Chromium's synthetic emboldener, which is both uglier and slightly wider
    // than the real bold at 8-9px. The bold subset costs ~9 kB. Worth it.
    weight: 700,
    file: 'ArchivoNarrow-Bold.ttf',
    url: `${RAW}/fonts/ttf/ArchivoNarrow-Bold.ttf`,
    sha256: 'e1b016241fd2bf89796152d7875464ab0be7181160caa8a794b77cb94493fc1d',
    out: 'archivo-narrow-700-subset.woff',
  },
]

const LICENCE = {
  file: 'OFL.txt',
  url: `${RAW}/OFL.txt`,
  sha256: null, // informational only; the text is committed alongside the fonts
}

// ---------------------------------------------------------------------------
// The character set.
//
// Derived from what the app can actually put on screen, not from a guess:
//   - every character in every string literal under src/ (script-extracted)
//   - the fixture directory + the genre tag table
//   - the accented glyphs in the product name itself (Weltempfaenger)
//   - Latin-1 and the common Latin Extended-A/B letters, because station and
//     genre names come from the live Radio Browser directory and are full of
//     European diacritics. Anything outside this set is deliberately left
//     UNMAPPED so it falls through to the rest of the stack rather than
//     rendering as a blank box.
// ---------------------------------------------------------------------------

function range(a, b) {
  const out = []
  for (let c = a; c <= b; c++) out.push(c)
  return out
}

const CHARSET = new Set([
  ...range(0x20, 0x7e), // ASCII printable — the whole silkscreen alphabet
  0x00a0, // NBSP
  ...range(0x00a1, 0x00bf), // ¡¢£¤¥¦§¨©ª«¬­®¯°±²³´µ¶·¸¹º»¼½¾¿
  ...range(0x00c0, 0x00ff), // À..ÿ — includes ä ö ü Ä Ö Ü ß é è ñ ç
  // Latin Extended-A: the letters that actually turn up in European station
  // and city names in the Radio Browser directory.
  0x0100, 0x0101, 0x0102, 0x0103, 0x0104, 0x0105, 0x0106, 0x0107,
  0x010c, 0x010d, 0x010e, 0x010f, 0x0110, 0x0111, 0x0112, 0x0113,
  0x0116, 0x0117, 0x0118, 0x0119, 0x011a, 0x011b, 0x011e, 0x011f,
  0x0122, 0x0123, 0x012a, 0x012b, 0x012e, 0x012f, 0x0130, 0x0131,
  0x0136, 0x0137, 0x0139, 0x013a, 0x013b, 0x013c, 0x013d, 0x013e,
  0x0141, 0x0142, 0x0143, 0x0144, 0x0145, 0x0146, 0x0147, 0x0148,
  0x014c, 0x014d, 0x0150, 0x0151, 0x0152, 0x0153, 0x0154, 0x0155,
  0x0156, 0x0157, 0x0158, 0x0159, 0x015a, 0x015b, 0x015e, 0x015f,
  0x0160, 0x0161, 0x0162, 0x0163, 0x0164, 0x0165, 0x016a, 0x016b,
  0x016e, 0x016f, 0x0170, 0x0171, 0x0172, 0x0173, 0x0178, 0x0179,
  0x017a, 0x017b, 0x017c, 0x017d, 0x017e,
  // Latin Extended-B: Romanian comma-below.
  0x0218, 0x0219, 0x021a, 0x021b,
  // General punctuation the UI emits or a station name may carry.
  0x2013, 0x2014, // – —   (register ranges, notice em-dashes)
  0x2018, 0x2019, 0x201a, 0x201c, 0x201d, 0x201e, // ‘’‚“”„
  0x2020, 0x2021, 0x2022, 0x2026, // †‡•…  (… is used by the directory + notices)
  0x2030, 0x2039, 0x203a, 0x2044, 0x2032, 0x2033,
  0x20ac, // €
  // Maths / instrument marks.
  0x2122, // ™
  0x2212, // −  (ui/index.ts uses a real minus, not a hyphen)
  0x2260, 0x2264, 0x2265, // ≠ ≤ ≥  (≥ is used by the register facets)
  0x2248, // ≈
  0x00d7, 0x00f7, // × ÷  (meter.ts uses ×)
  0x2190, 0x2192, 0x2191, 0x2193, // ← → ↑ ↓
  0x25b2, 0x25bc, 0x25cf, 0x25a0, // ▲ ▼ ● ■
  0xfffd, // �  — icy.ts substitutes this for undecodable ICY metadata
])

// ---------------------------------------------------------------------------
// sfnt reading
// ---------------------------------------------------------------------------

const tag = (buf, off) => buf.toString('latin1', off, off + 4)

function readSfnt(buf) {
  const numTables = buf.readUInt16BE(4)
  const tables = new Map()
  for (let i = 0; i < numTables; i++) {
    const p = 12 + i * 16
    tables.set(tag(buf, p), {
      checksum: buf.readUInt32BE(p + 4),
      offset: buf.readUInt32BE(p + 8),
      length: buf.readUInt32BE(p + 12),
    })
  }
  const get = (name) => {
    const t = tables.get(name)
    return t ? buf.subarray(t.offset, t.offset + t.length) : null
  }
  return { flavor: buf.readUInt32BE(0), tables, get }
}

/** codepoint -> glyph id, from cmap subtable format 4 and/or 12. */
function readCmap(cmap) {
  const n = cmap.readUInt16BE(2)
  let best = null
  let bestScore = -1
  for (let i = 0; i < n; i++) {
    const p = 4 + i * 8
    const platform = cmap.readUInt16BE(p)
    const encoding = cmap.readUInt16BE(p + 2)
    const offset = cmap.readUInt32BE(p + 4)
    const format = cmap.readUInt16BE(offset)
    // Prefer a full-repertoire (3,10 fmt12) table, then Unicode BMP (3,1 fmt4).
    let score = -1
    if (platform === 3 && encoding === 10 && format === 12) score = 3
    else if (platform === 0 && format === 12) score = 3
    else if (platform === 3 && encoding === 1 && format === 4) score = 2
    else if (platform === 0 && format === 4) score = 2
    if (score > bestScore) {
      bestScore = score
      best = { offset, format }
    }
  }
  if (!best) throw new Error('no usable cmap subtable')
  const map = new Map()
  if (best.format === 4) {
    const o = best.offset
    const segX2 = cmap.readUInt16BE(o + 6)
    const seg = segX2 >> 1
    const endO = o + 14
    const startO = endO + segX2 + 2
    const deltaO = startO + segX2
    const rangeO = deltaO + segX2
    for (let s = 0; s < seg; s++) {
      const end = cmap.readUInt16BE(endO + s * 2)
      const start = cmap.readUInt16BE(startO + s * 2)
      const delta = cmap.readInt16BE(deltaO + s * 2)
      const rangeOffset = cmap.readUInt16BE(rangeO + s * 2)
      if (start === 0xffff) continue
      for (let c = start; c <= end && c !== 0x10000; c++) {
        let g
        if (rangeOffset === 0) {
          g = (c + delta) & 0xffff
        } else {
          const gi = rangeO + s * 2 + rangeOffset + (c - start) * 2
          if (gi + 1 >= cmap.length) continue
          g = cmap.readUInt16BE(gi)
          if (g !== 0) g = (g + delta) & 0xffff
        }
        if (g !== 0) map.set(c, g)
      }
    }
  } else {
    const o = best.offset
    const nGroups = cmap.readUInt32BE(o + 12)
    for (let i = 0; i < nGroups; i++) {
      const p = o + 16 + i * 12
      const start = cmap.readUInt32BE(p)
      const end = cmap.readUInt32BE(p + 4)
      const startGid = cmap.readUInt32BE(p + 8)
      for (let c = start; c <= end; c++) map.set(c, startGid + (c - start))
    }
  }
  return map
}

function readLoca(loca, numGlyphs, longFormat) {
  const out = new Array(numGlyphs + 1)
  for (let i = 0; i <= numGlyphs; i++) {
    out[i] = longFormat ? loca.readUInt32BE(i * 4) : loca.readUInt16BE(i * 2) * 2
  }
  return out
}

/** Glyph ids a composite glyph points at (one level). */
function componentsOf(glyphData) {
  const out = []
  if (glyphData.length < 10) return out
  if (glyphData.readInt16BE(0) >= 0) return out // simple glyph
  let p = 10
  for (;;) {
    const flags = glyphData.readUInt16BE(p)
    const gid = glyphData.readUInt16BE(p + 2)
    out.push(gid)
    p += 4
    p += flags & 1 ? 4 : 2 // ARG_1_AND_2_ARE_WORDS
    if (flags & 8) p += 2 // WE_HAVE_A_SCALE
    else if (flags & 0x40) p += 4 // X_AND_Y_SCALE
    else if (flags & 0x80) p += 8 // TWO_BY_TWO
    if (!(flags & 0x20)) break // MORE_COMPONENTS
    if (p >= glyphData.length) break
  }
  return out
}

/**
 * Rewrite a glyph: renumber composite component references, in place.
 *
 * TrueType instructions are KEPT, and that is not laziness — it is the whole
 * reason this font measures the same as its upstream. See the HINTING note at
 * the top of the file. Instructions never reference glyph ids (only points, cvt
 * entries, storage and function numbers), so renumbering cannot invalidate
 * them, and cvt/fpgm/prep are copied through untouched.
 */
function rewriteGlyph(data, gidMap) {
  if (data.length === 0) return data
  const numContours = data.readInt16BE(0)
  if (numContours >= 0) return data // simple glyph: nothing references a gid
  const out = Buffer.from(data)
  let p = 10
  for (;;) {
    const flags = out.readUInt16BE(p)
    const oldGid = out.readUInt16BE(p + 2)
    const newGid = gidMap.get(oldGid)
    if (newGid === undefined) throw new Error(`composite references unkept gid ${oldGid}`)
    out.writeUInt16BE(newGid, p + 2)
    p += 4
    p += flags & 1 ? 4 : 2
    if (flags & 8) p += 2
    else if (flags & 0x40) p += 4
    else if (flags & 0x80) p += 8
    if (!(flags & 0x20)) break // no MORE_COMPONENTS
    if (p >= out.length) break
  }
  return out
}

// ---------------------------------------------------------------------------
// sfnt writing
// ---------------------------------------------------------------------------

const pad4 = (n) => (n + 3) & ~3

function checksum(buf) {
  let sum = 0
  const padded = pad4(buf.length)
  for (let i = 0; i < padded; i += 4) {
    const v =
      ((i < buf.length ? buf[i] : 0) << 24) |
      ((i + 1 < buf.length ? buf[i + 1] : 0) << 16) |
      ((i + 2 < buf.length ? buf[i + 2] : 0) << 8) |
      (i + 3 < buf.length ? buf[i + 3] : 0)
    sum = (sum + (v >>> 0)) >>> 0
  }
  return sum >>> 0
}

function buildSfnt(flavor, tables) {
  const names = [...tables.keys()].sort()
  const numTables = names.length
  let searchRange = 1
  let entrySelector = 0
  while (searchRange * 2 <= numTables) {
    searchRange *= 2
    entrySelector++
  }
  searchRange *= 16
  const rangeShift = numTables * 16 - searchRange

  const header = Buffer.alloc(12 + numTables * 16)
  header.writeUInt32BE(flavor, 0)
  header.writeUInt16BE(numTables, 4)
  header.writeUInt16BE(searchRange, 6)
  header.writeUInt16BE(entrySelector, 8)
  header.writeUInt16BE(rangeShift, 10)

  const chunks = [header]
  let offset = header.length
  const dir = []
  names.forEach((name, i) => {
    const body = tables.get(name)
    const p = 12 + i * 16
    header.write(name, p, 4, 'latin1')
    header.writeUInt32BE(checksum(body), p + 4)
    header.writeUInt32BE(offset, p + 8)
    header.writeUInt32BE(body.length, p + 12)
    dir.push({ name, offset, length: body.length, checksum: checksum(body) })
    const padded = pad4(body.length)
    chunks.push(body)
    if (padded > body.length) chunks.push(Buffer.alloc(padded - body.length))
    offset += padded
  })

  const sfnt = Buffer.concat(chunks)
  // head.checkSumAdjustment
  const headEntry = dir.find((d) => d.name === 'head')
  if (headEntry) {
    sfnt.writeUInt32BE(0, headEntry.offset + 8)
    const total = checksum(sfnt)
    sfnt.writeUInt32BE((0xb1b0afba - total) >>> 0, headEntry.offset + 8)
  }
  return { sfnt, dir }
}

function buildWoff(flavor, tables) {
  const { sfnt } = buildSfnt(flavor, tables)
  const names = [...tables.keys()].sort()
  const numTables = names.length
  const header = Buffer.alloc(44)
  const entries = Buffer.alloc(numTables * 20)
  const bodies = []
  let offset = 44 + entries.length

  names.forEach((name, i) => {
    const orig = tables.get(name)
    const comp = deflateSync(orig, { level: 9 })
    const use = comp.length < orig.length ? comp : orig
    const p = i * 20
    entries.write(name, p, 4, 'latin1')
    entries.writeUInt32BE(offset, p + 4)
    entries.writeUInt32BE(use.length, p + 8)
    entries.writeUInt32BE(orig.length, p + 12)
    entries.writeUInt32BE(checksum(orig), p + 16)
    bodies.push(use)
    const padded = pad4(use.length)
    if (padded > use.length) bodies.push(Buffer.alloc(padded - use.length))
    offset += padded
  })

  header.write('wOFF', 0, 4, 'latin1')
  header.writeUInt32BE(flavor, 4)
  header.writeUInt32BE(offset, 8) // total WOFF length
  header.writeUInt16BE(numTables, 12)
  header.writeUInt16BE(0, 14)
  header.writeUInt32BE(sfnt.length, 16) // totalSfntSize
  header.writeUInt16BE(1, 20) // majorVersion
  header.writeUInt16BE(0, 22) // minorVersion
  // metaOffset/Length/OrigLength and privOffset/Length stay zero.
  return { woff: Buffer.concat([header, entries, ...bodies]), sfnt }
}

// ---------------------------------------------------------------------------
// The subsetter
// ---------------------------------------------------------------------------

function subset(buf, charset) {
  const font = readSfnt(buf)
  const head = Buffer.from(font.get('head'))
  const hhea = Buffer.from(font.get('hhea'))
  const maxp = Buffer.from(font.get('maxp'))
  const os2 = font.get('OS/2')
  const nameT = font.get('name')
  const hmtx = font.get('hmtx')
  const glyf = font.get('glyf')
  const locaRaw = font.get('loca')
  const cmapRaw = font.get('cmap')
  if (!glyf || !locaRaw) throw new Error('not a TrueType-outline font (no glyf/loca)')

  const numGlyphs = maxp.readUInt16BE(4)
  const longLoca = head.readInt16BE(50) === 1
  const loca = readLoca(locaRaw, numGlyphs, longLoca)
  const cmap = readCmap(cmapRaw)
  const numberOfHMetrics = hhea.readUInt16BE(34)

  // 1. wanted glyph ids, closed over composite components
  const keep = new Set([0])
  const mapped = new Map() // codepoint -> old gid
  for (const cp of charset) {
    const g = cmap.get(cp)
    if (g !== undefined && g < numGlyphs) {
      mapped.set(cp, g)
      keep.add(g)
    }
  }
  const stack = [...keep]
  while (stack.length) {
    const g = stack.pop()
    const data = glyf.subarray(loca[g], loca[g + 1])
    for (const c of componentsOf(data)) {
      if (!keep.has(c)) {
        keep.add(c)
        stack.push(c)
      }
    }
  }

  // 2. dense renumbering, gid 0 stays gid 0
  const oldGids = [...keep].sort((a, b) => a - b)
  const gidMap = new Map()
  oldGids.forEach((old, i) => gidMap.set(old, i))
  const n = oldGids.length

  // 3. glyf + loca
  const glyphBufs = []
  const newLoca = [0]
  let acc = 0
  for (const old of oldGids) {
    let data = glyf.subarray(loca[old], loca[old + 1])
    if (data.length) data = rewriteGlyph(data, gidMap)
    const padded = pad4(data.length)
    glyphBufs.push(data)
    if (padded > data.length) glyphBufs.push(Buffer.alloc(padded - data.length))
    acc += padded
    newLoca.push(acc)
  }
  const newGlyf = Buffer.concat(glyphBufs)
  const newLocaBuf = Buffer.alloc((n + 1) * 4)
  newLoca.forEach((v, i) => newLocaBuf.writeUInt32BE(v, i * 4))
  head.writeInt16BE(1, 50) // indexToLocFormat = long

  // 4. hmtx — all long metrics, so numberOfHMetrics === numGlyphs
  const newHmtx = Buffer.alloc(n * 4)
  oldGids.forEach((old, i) => {
    const mi = Math.min(old, numberOfHMetrics - 1)
    const advance = hmtx.readUInt16BE(mi * 4)
    let lsb
    if (old < numberOfHMetrics) {
      lsb = hmtx.readInt16BE(old * 4 + 2)
    } else {
      const off = numberOfHMetrics * 4 + (old - numberOfHMetrics) * 2
      lsb = off + 1 < hmtx.length ? hmtx.readInt16BE(off) : 0
    }
    newHmtx.writeUInt16BE(advance, i * 4)
    newHmtx.writeInt16BE(lsb, i * 4 + 2)
  })
  hhea.writeUInt16BE(n, 34)

  // 5. maxp — only numGlyphs changes. Every other field is a ceiling the
  //    interpreter allocates against; the kept glyphs are a subset of the
  //    original, so the original ceilings are still valid (merely generous) and
  //    lowering them by guesswork would break hinting.
  maxp.writeUInt16BE(n, 4)

  // 6. cmap — format 4 only, and ONLY the codepoints we kept.
  const cps = [...mapped.keys()].sort((a, b) => a - b)
  const segs = []
  for (const cp of cps) {
    const gid = gidMap.get(mapped.get(cp))
    const last = segs[segs.length - 1]
    if (last && cp === last.end + 1 && gid === last.gids[last.gids.length - 1] + 1) {
      last.end = cp
      last.gids.push(gid)
    } else if (last && cp === last.end + 1) {
      last.end = cp
      last.gids.push(gid)
    } else {
      segs.push({ start: cp, end: cp, gids: [gid] })
    }
  }
  segs.push({ start: 0xffff, end: 0xffff, gids: [0] })
  const segCount = segs.length
  // Every segment uses glyphIdArray (rangeOffset != 0). Simpler and always
  // correct; the cost is 2 bytes per mapped codepoint, which deflate eats.
  const glyphIdCount = segs.reduce((t, s) => t + (s.end - s.start + 1), 0)
  const sub4Len = 14 + segCount * 8 + 2 + glyphIdCount * 2
  const sub4 = Buffer.alloc(sub4Len)
  sub4.writeUInt16BE(4, 0)
  sub4.writeUInt16BE(sub4Len, 2)
  sub4.writeUInt16BE(0, 4) // language
  sub4.writeUInt16BE(segCount * 2, 6)
  let sr = 1
  let es = 0
  while (sr * 2 <= segCount) {
    sr *= 2
    es++
  }
  sub4.writeUInt16BE(sr * 2, 8)
  sub4.writeUInt16BE(es, 10)
  sub4.writeUInt16BE(segCount * 2 - sr * 2, 12)
  const endO = 14
  const startO = endO + segCount * 2 + 2
  const deltaO = startO + segCount * 2
  const rangeO = deltaO + segCount * 2
  const glyphO = rangeO + segCount * 2
  let gPos = 0
  segs.forEach((s, i) => {
    sub4.writeUInt16BE(s.end, endO + i * 2)
    sub4.writeUInt16BE(s.start, startO + i * 2)
    sub4.writeInt16BE(0, deltaO + i * 2)
    const count = s.end - s.start + 1
    if (s.start === 0xffff) {
      sub4.writeUInt16BE(0, rangeO + i * 2)
      sub4.writeInt16BE(1, deltaO + i * 2) // 0xFFFF + 1 = 0 -> .notdef
    } else {
      const byteOff = glyphO + gPos * 2 - (rangeO + i * 2)
      sub4.writeUInt16BE(byteOff, rangeO + i * 2)
      for (let k = 0; k < count; k++) sub4.writeUInt16BE(s.gids[k], glyphO + (gPos + k) * 2)
      gPos += count
    }
  })
  // One subtable, published under both (3,1) and (0,3) so every shaper finds it.
  const newCmap = Buffer.alloc(4 + 2 * 8 + sub4Len)
  newCmap.writeUInt16BE(0, 0)
  newCmap.writeUInt16BE(2, 2)
  newCmap.writeUInt16BE(0, 4) // platform 0 (Unicode)
  newCmap.writeUInt16BE(3, 6) // encoding 3 (BMP)
  newCmap.writeUInt32BE(20, 8)
  newCmap.writeUInt16BE(3, 12) // platform 3 (Windows)
  newCmap.writeUInt16BE(1, 14) // encoding 1 (UCS-2)
  newCmap.writeUInt32BE(20, 16)
  sub4.copy(newCmap, 20)

  // 7. name — keep the identity and, importantly, the licence.
  const newName = filterName(nameT, new Set([0, 1, 2, 3, 4, 6, 13, 14]))

  // 8. post 3.0 — drop glyph names entirely.
  const oldPost = font.get('post')
  const newPost = Buffer.alloc(32)
  newPost.writeUInt32BE(0x00030000, 0)
  if (oldPost && oldPost.length >= 32) oldPost.copy(newPost, 4, 4, 32)

  const tables = new Map()
  tables.set('head', head)
  tables.set('hhea', hhea)
  tables.set('maxp', maxp)
  tables.set('hmtx', newHmtx)
  tables.set('cmap', newCmap)
  tables.set('loca', newLocaBuf)
  tables.set('glyf', newGlyf)
  tables.set('name', newName)
  tables.set('post', newPost)
  if (os2) tables.set('OS/2', Buffer.from(os2))
  // The hinting programs the kept instructions call into. Copied verbatim.
  // `gasp` comes along because it is what tells the rasteriser at which sizes
  // to run them at all.
  for (const t of ['cvt ', 'fpgm', 'prep', 'gasp']) {
    const b = font.get(t)
    if (b) tables.set(t, Buffer.from(b))
  }

  return {
    tables,
    flavor: font.flavor,
    stats: {
      sourceGlyphs: numGlyphs,
      keptGlyphs: n,
      requested: charset.size,
      mapped: mapped.size,
      missing: [...charset].filter((c) => !mapped.has(c)),
    },
  }
}

function filterName(nameT, wantedIds) {
  if (!nameT) return Buffer.alloc(6)
  const count = nameT.readUInt16BE(2)
  const stringOffset = nameT.readUInt16BE(4)
  const records = []
  for (let i = 0; i < count; i++) {
    const p = 6 + i * 12
    const rec = {
      platformID: nameT.readUInt16BE(p),
      encodingID: nameT.readUInt16BE(p + 2),
      languageID: nameT.readUInt16BE(p + 4),
      nameID: nameT.readUInt16BE(p + 6),
      length: nameT.readUInt16BE(p + 8),
      offset: nameT.readUInt16BE(p + 10),
    }
    // Windows / Unicode BMP / en-US only: one encoding is enough and halves the
    // table. Every platform we ship to reads platform 3.
    if (!wantedIds.has(rec.nameID)) continue
    if (rec.platformID !== 3 || rec.encodingID !== 1 || rec.languageID !== 0x409) continue
    rec.data = nameT.subarray(stringOffset + rec.offset, stringOffset + rec.offset + rec.length)
    records.push(rec)
  }
  records.sort((a, b) => a.platformID - b.platformID || a.nameID - b.nameID)
  const header = Buffer.alloc(6 + records.length * 12)
  header.writeUInt16BE(0, 0)
  header.writeUInt16BE(records.length, 2)
  header.writeUInt16BE(header.length, 4)
  const strings = []
  let off = 0
  records.forEach((r, i) => {
    const p = 6 + i * 12
    header.writeUInt16BE(r.platformID, p)
    header.writeUInt16BE(r.encodingID, p + 2)
    header.writeUInt16BE(r.languageID, p + 4)
    header.writeUInt16BE(r.nameID, p + 6)
    header.writeUInt16BE(r.data.length, p + 8)
    header.writeUInt16BE(off, p + 10)
    strings.push(r.data)
    off += r.data.length
  })
  return Buffer.concat([header, ...strings])
}

// ---------------------------------------------------------------------------
// Fetch + drive
// ---------------------------------------------------------------------------

async function fetchCached(url, file, sha256, offline) {
  mkdirSync(CACHE, { recursive: true })
  const dest = path.join(CACHE, file)
  if (existsSync(dest)) {
    const got = createHash('sha256').update(readFileSync(dest)).digest('hex')
    if (!sha256 || got === sha256) return readFileSync(dest)
    console.log(`  ! cached ${file} has the wrong hash, refetching`)
  }
  if (offline) throw new Error(`${file} is not cached and --offline was given`)
  console.log(`  ↓ ${url}`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const got = createHash('sha256').update(buf).digest('hex')
  if (sha256 && got !== sha256) throw new Error(`${file}: sha256 ${got} != expected ${sha256}`)
  writeFileSync(dest, buf)
  return buf
}

const args = process.argv.slice(2)
const wantReport = args.includes('--report')
const wantTtf = args.includes('--ttf')
const offline = args.includes('--offline')
const srcDirArg = args.find((a) => a.startsWith('--src='))
const srcDir = srcDirArg ? srcDirArg.slice(6) : null

const kb = (n) => `${(n / 1024).toFixed(1)} kB`

async function main() {
  mkdirSync(OUT, { recursive: true })
  console.log(`Archivo Narrow subset — SIL OFL 1.1`)
  console.log(`upstream: ${UPSTREAM_REPO} @ ${UPSTREAM_COMMIT.slice(0, 10)}`)
  console.log(`charset : ${CHARSET.size} codepoints requested\n`)

  let total = 0
  for (const src of SOURCES) {
    const buf = srcDir
      ? readFileSync(path.join(srcDir, src.file))
      : await fetchCached(src.url, src.file, src.sha256, offline)

    const { tables, flavor, stats } = subset(buf, CHARSET)
    const { woff, sfnt } = buildWoff(flavor, tables)
    const dest = path.join(OUT, src.out)
    writeFileSync(dest, woff)
    total += woff.length
    console.log(
      `${src.out}\n` +
        `  source      ${kb(buf.length)} (${stats.sourceGlyphs} glyphs)\n` +
        `  subset ttf  ${kb(sfnt.length)} (${stats.keptGlyphs} glyphs)\n` +
        `  woff        ${kb(woff.length)}   <- written\n` +
        `  mapped      ${stats.mapped}/${stats.requested} codepoints` +
        (stats.missing.length
          ? `, not in source: ${stats.missing
              .map((c) => 'U+' + c.toString(16).toUpperCase().padStart(4, '0'))
              .join(' ')}`
          : '') +
        '\n',
    )
    if (wantTtf) {
      const ttfDest = dest.replace(/\.woff$/, '.ttf')
      writeFileSync(ttfDest, sfnt)
      console.log(`  also wrote ${path.basename(ttfDest)}\n`)
    }
    if (wantReport) {
      const covered = [...CHARSET].filter((c) => !stats.missing.includes(c))
      console.log(
        '  coverage: ' +
          covered
            .filter((c) => c >= 0x20 && c < 0x7f)
            .map((c) => String.fromCodePoint(c))
            .join('') +
          '\n',
      )
    }
  }

  // The licence travels with the fonts, in the same directory, verbatim.
  const ofl = srcDir
    ? readFileSync(path.join(srcDir, LICENCE.file))
    : await fetchCached(LICENCE.url, LICENCE.file, LICENCE.sha256, offline)
  writeFileSync(path.join(OUT, 'OFL.txt'), ofl)
  console.log(`OFL.txt      ${kb(ofl.length)}   <- written`)
  console.log(`\nTOTAL FONT PAYLOAD IN THE BUNDLE: ${kb(total)}`)
}

main().catch((err) => {
  console.error(`\n\x1b[31m✗ ${err.message}\x1b[0m`)
  process.exit(1)
})
