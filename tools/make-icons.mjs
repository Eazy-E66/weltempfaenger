#!/usr/bin/env node
/**
 * Procedural app-icon generator for Weltempfänger.
 *
 * No ImageMagick, no native image libs, no npm dependencies — this writes the
 * three container formats byte by byte:
 *
 *   build/icon.png    512x512 RGBA          (Linux / generic)
 *   build/icon.ico    real ICO, 6 PNG-payload entries   (Windows)
 *   build/icon.icns   real ICNS, 10 PNG-payload chunks  (macOS)
 *   build/icons/*.png 16..1024 size set     (electron-builder Linux/deb)
 *
 * Both .ico and .icns are genuine containers with correct headers and directory
 * structures — NOT a PNG with a renamed extension. Verify with `file`.
 *
 * The artwork: a Sony ICF-6800W-flavoured tuning meter — dark warm cabinet,
 * champagne dial face behind a brushed bezel, printed tick scale, a slim red
 * needle, chrome hub, and two amber signal arcs radiating out of the dial.
 * Lit from the upper left, per docs/REFERENCE-BRIEF.md.
 *
 * Usage: node tools/make-icons.mjs
 */

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BUILD = path.join(ROOT, 'build')
const ICONS = path.join(BUILD, 'icons')

const MASTER = 1024

// ---------------------------------------------------------------------------
// PNG encoding
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

/** @param {Uint8Array} rgba 8-bit straight-alpha RGBA, width*height*4 */
function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filtering
  ihdr[12] = 0 // no interlace

  // Filter type 0 (None) on every scanline. Icons are small; the extra
  // compression from adaptive filtering is not worth the complexity.
  const raw = Buffer.alloc(height * (1 + width * 4))
  for (let y = 0; y < height; y++) {
    const o = y * (1 + width * 4)
    raw[o] = 0
    rgba.subarray(y * width * 4, (y + 1) * width * 4).forEach((v, i) => {
      raw[o + 1 + i] = v
    })
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------------------------------------------------------------------------
// Tiny SDF rasteriser (float RGBA canvas, straight alpha, "over" compositing)
// ---------------------------------------------------------------------------

function canvas(size) {
  return { size, data: new Float32Array(size * size * 4) }
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
const mix = (a, b, t) => a + (b - a) * t

/** Coverage from a signed distance in pixels: <0 inside. */
const cov = (d) => clamp(0.5 - d, 0, 1)

function over(cv, x, y, r, g, b, a) {
  if (a <= 0) return
  const i = (y * cv.size + x) * 4
  const d = cv.data
  const da = d[i + 3]
  const oa = a + da * (1 - a)
  if (oa <= 0) return
  d[i] = (r * a + d[i] * da * (1 - a)) / oa
  d[i + 1] = (g * a + d[i + 1] * da * (1 - a)) / oa
  d[i + 2] = (b * a + d[i + 2] * da * (1 - a)) / oa
  d[i + 3] = oa
}

const hex = (h) => [
  parseInt(h.slice(1, 3), 16) / 255,
  parseInt(h.slice(3, 5), 16) / 255,
  parseInt(h.slice(5, 7), 16) / 255,
]

// --- signed distance functions (all in pixel units) ---

function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r)
  const qy = Math.abs(py - cy) - (hh - r)
  const ax = Math.max(qx, 0)
  const ay = Math.max(qy, 0)
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r
}

const sdCircle = (px, py, cx, cy, r) => Math.hypot(px - cx, py - cy) - r

/** Ring/annulus: distance to the band between rInner and rOuter. */
function sdRing(px, py, cx, cy, rInner, rOuter) {
  const d = Math.hypot(px - cx, py - cy)
  const mid = (rInner + rOuter) / 2
  const half = (rOuter - rInner) / 2
  return Math.abs(d - mid) - half
}

/** Rounded line segment (capsule) from (ax,ay) to (bx,by) with radius r. */
function sdCapsule(px, py, ax, ay, bx, by, r) {
  const pax = px - ax
  const pay = py - ay
  const bax = bx - ax
  const bay = by - ay
  const h = clamp((pax * bax + pay * bay) / (bax * bax + bay * bay), 0, 1)
  return Math.hypot(pax - bax * h, pay - bay * h) - r
}

/**
 * Paint every pixel through a callback that returns [r,g,b,a] or null.
 * `shade` receives pixel centre coords.
 */
function paint(cv, bbox, shade) {
  const x0 = Math.max(0, Math.floor(bbox[0]))
  const y0 = Math.max(0, Math.floor(bbox[1]))
  const x1 = Math.min(cv.size - 1, Math.ceil(bbox[2]))
  const y1 = Math.min(cv.size - 1, Math.ceil(bbox[3]))
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const c = shade(x + 0.5, y + 0.5)
      if (c) over(cv, x, y, c[0], c[1], c[2], c[3])
    }
  }
}

// ---------------------------------------------------------------------------
// The artwork
// ---------------------------------------------------------------------------

function drawIcon(S) {
  const cv = canvas(S)
  const u = (v) => v * S // normalised -> pixels
  const cx = u(0.5)
  const cy = u(0.5)
  const full = [0, 0, S, S]

  // --- 1. cabinet: dark warm rounded square, vertical gradient + vignette ---
  const bgTop = hex('#3a322a')
  const bgBot = hex('#141210')
  const inset = u(0.025)
  const radius = u(0.205)
  paint(cv, full, (x, y) => {
    const d = sdRoundRect(x, y, cx, cy, S / 2 - inset, S / 2 - inset, radius)
    const a = cov(d)
    if (a <= 0) return null
    const t = y / S
    // vignette: darken toward the edges
    const vig = 1 - 0.28 * clamp(Math.hypot(x - cx, y - cy) / (S * 0.72), 0, 1) ** 2
    return [
      mix(bgTop[0], bgBot[0], t) * vig,
      mix(bgTop[1], bgBot[1], t) * vig,
      mix(bgTop[2], bgBot[2], t) * vig,
      a,
    ]
  })

  // --- 2. top edge highlight (light from upper left) ---
  paint(cv, full, (x, y) => {
    const d = sdRoundRect(x, y, cx, cy, S / 2 - inset, S / 2 - inset, radius)
    // a thin band just inside the border
    const band = cov(d + u(0.006)) - cov(d + u(0.0)) // ring of ~edge thickness
    if (band <= 0) return null
    // strongest at the top-left, fading away by the bottom-right
    const dir = clamp(1 - (x / S + y / S) / 1.35, 0, 1)
    return [1, 0.97, 0.92, band * dir * 0.34]
  })

  // --- 3. warm lamp glow behind the dial ---
  const glow = hex('#e8a63c')
  paint(cv, full, (x, y) => {
    const r = Math.hypot(x - cx, y - cy)
    const a = clamp(1 - r / u(0.47), 0, 1) ** 2.2 * 0.2
    if (a <= 0.002) return null
    return [glow[0], glow[1], glow[2], a]
  })

  // --- 4. amber signal arcs radiating from behind the dial (upper right) ---
  const arcColor = hex('#eaa93f')
  const arcs = [
    { ri: 0.352, ro: 0.378 },
    { ri: 0.418, ro: 0.444 },
  ]
  for (const arc of arcs) {
    paint(cv, full, (x, y) => {
      const d = sdRing(x, y, cx, cy, u(arc.ri), u(arc.ro))
      const a = cov(d)
      if (a <= 0) return null
      // angular window, upper right; soft fade at both ends
      let ang = (Math.atan2(y - cy, x - cx) * 180) / Math.PI // -180..180, -90 = up
      const centre = -46
      const halfSpan = 30
      const off = Math.abs(ang - centre)
      if (off > halfSpan) return null
      const fade = 1 - (off / halfSpan) ** 2
      return [arcColor[0], arcColor[1], arcColor[2], a * fade * 0.95]
    })
  }

  // --- 5. bezel ring around the dial (brushed metal) ---
  const rDial = 0.3
  const rBezel = 0.338
  const bezTop = hex('#c8c2b8')
  const bezBot = hex('#4e4a45')
  paint(cv, full, (x, y) => {
    const d = sdRing(x, y, cx, cy, u(rDial) - 1, u(rBezel))
    const a = cov(d)
    if (a <= 0) return null
    const t = clamp((y - (cy - u(rBezel))) / (2 * u(rBezel)), 0, 1)
    return [mix(bezTop[0], bezBot[0], t), mix(bezTop[1], bezBot[1], t), mix(bezTop[2], bezBot[2], t), a]
  })

  // --- 6. dial face: champagne, lit from upper left ---
  const faceHi = hex('#f4e9cd')
  const faceLo = hex('#bfad86')
  paint(cv, full, (x, y) => {
    const a = cov(sdCircle(x, y, cx, cy, u(rDial)))
    if (a <= 0) return null
    const t = clamp((x - cx + (y - cy)) / (u(rDial) * 2.6) + 0.5, 0, 1)
    return [mix(faceHi[0], faceLo[0], t), mix(faceHi[1], faceLo[1], t), mix(faceHi[2], faceLo[2], t), a]
  })

  // --- 7. printed tick scale ---
  const tick = hex('#38322a')
  for (let i = 0; i < 30; i++) {
    const deg = -90 + i * 12
    const rad = (deg * Math.PI) / 180
    const major = i % 5 === 0
    const r0 = u(major ? 0.222 : 0.244)
    const r1 = u(0.274)
    const w = u(major ? 0.0105 : 0.0055)
    const ax = cx + Math.cos(rad) * r0
    const ay = cy + Math.sin(rad) * r0
    const bx = cx + Math.cos(rad) * r1
    const by = cy + Math.sin(rad) * r1
    const pad = w + 2
    paint(
      cv,
      [Math.min(ax, bx) - pad, Math.min(ay, by) - pad, Math.max(ax, bx) + pad, Math.max(ay, by) + pad],
      (x, y) => {
        const a = cov(sdCapsule(x, y, ax, ay, bx, by, w / 2))
        return a > 0 ? [tick[0], tick[1], tick[2], a * 0.92] : null
      },
    )
  }

  // --- 8. glass sheen over the upper-left of the dial ---
  paint(cv, full, (x, y) => {
    const inDial = cov(sdCircle(x, y, cx, cy, u(rDial) - 0.5))
    if (inDial <= 0) return null
    const lobe = cov(sdCircle(x, y, cx - u(0.2), cy - u(0.24), u(0.3)))
    const a = inDial * lobe * 0.16
    return a > 0.002 ? [1, 1, 0.98, a] : null
  })

  // --- 9. needle ---
  const needleDeg = -58
  const nr = (needleDeg * Math.PI) / 180
  const tipX = cx + Math.cos(nr) * u(0.252)
  const tipY = cy + Math.sin(nr) * u(0.252)
  const tailX = cx - Math.cos(nr) * u(0.055)
  const tailY = cy - Math.sin(nr) * u(0.055)
  // soft contact shadow on the dial face beneath the needle
  paint(cv, full, (x, y) => {
    const d = sdCapsule(x - u(0.008), y - u(0.012), tailX, tailY, tipX, tipY, u(0.014))
    const a = clamp(0.5 - d / (u(0.02) + 1), 0, 1) * 0.22
    const inDial = cov(sdCircle(x, y, cx, cy, u(rDial) - 0.5))
    return a > 0.002 && inDial > 0 ? [0.15, 0.11, 0.07, a * inDial] : null
  })
  const needle = hex('#b8321f')
  paint(cv, full, (x, y) => {
    const a = cov(sdCapsule(x, y, tailX, tailY, tipX, tipY, u(0.0105)))
    return a > 0 ? [needle[0], needle[1], needle[2], a] : null
  })

  // --- 10. chrome hub ---
  const hubHi = hex('#f6f3ed')
  const hubLo = hex('#7d786f')
  paint(cv, full, (x, y) => {
    const a = cov(sdCircle(x, y, cx, cy, u(0.052)))
    if (a <= 0) return null
    const t = clamp((x - cx + (y - cy)) / (u(0.052) * 2.4) + 0.5, 0, 1)
    return [mix(hubHi[0], hubLo[0], t), mix(hubHi[1], hubLo[1], t), mix(hubHi[2], hubLo[2], t), a]
  })
  paint(cv, full, (x, y) => {
    const a = cov(sdRing(x, y, cx, cy, u(0.052), u(0.058)))
    return a > 0 ? [0.16, 0.13, 0.1, a * 0.55] : null
  })

  return cv
}

// ---------------------------------------------------------------------------
// Resampling + export
// ---------------------------------------------------------------------------

/** Area-average box filter, premultiplied to avoid dark halos. */
function resample(src, size) {
  if (size === src.size) return src
  const dst = canvas(size)
  const scale = src.size / size
  for (let y = 0; y < size; y++) {
    const sy0 = y * scale
    const sy1 = sy0 + scale
    for (let x = 0; x < size; x++) {
      const sx0 = x * scale
      const sx1 = sx0 + scale
      let r = 0, g = 0, b = 0, a = 0, w = 0
      for (let sy = Math.floor(sy0); sy < Math.ceil(sy1); sy++) {
        const wy = Math.min(sy + 1, sy1) - Math.max(sy, sy0)
        if (wy <= 0) continue
        for (let sx = Math.floor(sx0); sx < Math.ceil(sx1); sx++) {
          const wx = Math.min(sx + 1, sx1) - Math.max(sx, sx0)
          if (wx <= 0) continue
          const i = (sy * src.size + sx) * 4
          const pw = wx * wy
          const pa = src.data[i + 3] * pw
          r += src.data[i] * pa
          g += src.data[i + 1] * pa
          b += src.data[i + 2] * pa
          a += pa
          w += pw
        }
      }
      const o = (y * size + x) * 4
      if (a > 0) {
        dst.data[o] = r / a
        dst.data[o + 1] = g / a
        dst.data[o + 2] = b / a
      }
      dst.data[o + 3] = w > 0 ? a / w : 0
    }
  }
  return dst
}

function toRGBA8(cv) {
  const out = new Uint8Array(cv.size * cv.size * 4)
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.round(clamp(cv.data[i], 0, 1) * 255)
  }
  return out
}

const pngCache = new Map()
function pngFor(master, size) {
  if (!pngCache.has(size)) {
    pngCache.set(size, encodePNG(size, size, toRGBA8(resample(master, size))))
  }
  return pngCache.get(size)
}

/**
 * Windows ICO. Each entry carries a PNG payload, which every Windows version
 * since Vista reads natively. Width/height byte 0 means 256.
 */
function buildICO(master, sizes) {
  const images = sizes.map((s) => ({ size: s, png: pngFor(master, s) }))
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type 1 = icon
  header.writeUInt16LE(images.length, 4)

  let offset = 6 + images.length * 16
  const entries = []
  for (const img of images) {
    const e = Buffer.alloc(16)
    e[0] = img.size >= 256 ? 0 : img.size
    e[1] = img.size >= 256 ? 0 : img.size
    e[2] = 0 // palette entries
    e[3] = 0 // reserved
    e.writeUInt16LE(1, 4) // colour planes
    e.writeUInt16LE(32, 6) // bits per pixel
    e.writeUInt32LE(img.png.length, 8)
    e.writeUInt32LE(offset, 12)
    entries.push(e)
    offset += img.png.length
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)])
}

/**
 * macOS ICNS. Modern OS types take a PNG payload directly. Each chunk is
 * <4-byte type><4-byte BE length including these 8 bytes><payload>.
 */
const ICNS_TYPES = [
  ['icp4', 16],
  ['icp5', 32],
  ['ic11', 32], // 16x16@2x
  ['ic12', 64], // 32x32@2x
  ['ic07', 128],
  ['ic08', 256],
  ['ic13', 256], // 128x128@2x
  ['ic09', 512],
  ['ic14', 512], // 256x256@2x
  ['ic10', 1024], // 512x512@2x
]

function buildICNS(master) {
  const chunks = ICNS_TYPES.map(([type, size]) => {
    const png = pngFor(master, size)
    const head = Buffer.alloc(8)
    head.write(type, 0, 4, 'ascii')
    head.writeUInt32BE(png.length + 8, 4)
    return Buffer.concat([head, png])
  })
  const body = Buffer.concat(chunks)
  const head = Buffer.alloc(8)
  head.write('icns', 0, 4, 'ascii')
  head.writeUInt32BE(body.length + 8, 4)
  return Buffer.concat([head, body])
}

// ---------------------------------------------------------------------------

function main() {
  mkdirSync(ICONS, { recursive: true })
  console.log(`rendering master at ${MASTER}x${MASTER}...`)
  const master = drawIcon(MASTER)

  const linuxSizes = [16, 32, 48, 64, 128, 256, 512, 1024]
  for (const s of linuxSizes) {
    const p = path.join(ICONS, `${s}x${s}.png`)
    writeFileSync(p, pngFor(master, s))
    console.log(`  ${path.relative(ROOT, p)}  ${pngFor(master, s).length} bytes`)
  }

  const iconPng = path.join(BUILD, 'icon.png')
  writeFileSync(iconPng, pngFor(master, 512))
  console.log(`  ${path.relative(ROOT, iconPng)}  ${pngFor(master, 512).length} bytes`)

  const ico = buildICO(master, [16, 32, 48, 64, 128, 256])
  writeFileSync(path.join(BUILD, 'icon.ico'), ico)
  console.log(`  build/icon.ico   ${ico.length} bytes (6 entries)`)

  const icns = buildICNS(master)
  writeFileSync(path.join(BUILD, 'icon.icns'), icns)
  console.log(`  build/icon.icns  ${icns.length} bytes (${ICNS_TYPES.length} chunks)`)

  console.log('done.')
}

main()
