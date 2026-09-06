/**
 * MATERIALS — procedural surface generators.
 *
 * Everything here is *painted once* into an offscreen canvas and handed to the
 * compositor as a flat bitmap. Nothing in this file runs per frame: a knob
 * turning is one `drawImage` from a sprite sheet that is already in VRAM.
 * `bake()` marks every generator so the startup cost is measurable rather than
 * asserted — see `materials.ts`, which schedules the baking off the first
 * paint, and `textures.ts`, which still owns the SVG filters.
 *
 * Three techniques, chosen per surface for a reason:
 *
 *   1. PER-PIXEL SHADERS (domes, jewels, knurl) — for small round parts, a real
 *      shading model evaluated per pixel is both cheaper and more correct than a
 *      stack of six CSS gradients. A 46px dome is 8.5k pixels at DPR 2. A CSS
 *      gradient stack cannot express Fresnel, an environment horizon, or a
 *      transmission caustic at all; a shader gets them for three lines each.
 *
 *   2. GEOMETRY RASTERISED WITH ANALYTIC ANTIALIASING (grille, knurl) — the
 *      failure mode of `repeating-conic-gradient` and tiled radial gradients is
 *      that they have no notion of pixel footprint, so once a feature drops
 *      below Nyquist they alias into moiré. Computing the feature's angular or
 *      linear footprint per pixel and fading contrast toward the local mean is
 *      exactly what a mip-map does, and it is four lines of arithmetic.
 *
 *   3. SEAMLESS NOISE TILES (brushed grain, wear) — anisotropic grain is a
 *      stochastic field, not a pattern. A periodic gradient will always read as
 *      corduroy. One seamless tile of real noise, repeated, does not.
 *
 * No bitmaps ship. Everything regenerates at the window's DPI.
 */


/* ------------------------------------------------------------------- types */

/** A colour, linear 0..1 (or 0..255 for the grille's sheet). */
export type RGB = [number, number, number];
/** Which case edge a wear map should rub through along. */
export type Edge = 'left' | 'right' | 'top' | 'bottom';
/** A control on a worn surface: the hand sweeps an arc around it. */
export interface WearControl {
  x: number;
  y: number;
  r: number;
}
/** The driver cone sitting behind a punched grille. */
export interface Driver {
  x: number;
  y: number;
  r: number;
}

export interface BrushedOptions {
  w?: number;
  h?: number;
  seed?: number;
  amp?: number;
}
export interface GrilleOptions {
  w: number;
  h: number;
  dpr?: number;
  /**
   * The sheet's size in DEVICE pixels, when the caller knows it exactly.
   *
   * `w * dpr` is only an estimate: a CSS box is a fractional number of layout
   * pixels, an ancestor transform rescales it, and a fractional DPR rounds it.
   * Whenever the backing store ends up a different size from the box the
   * compositor draws it into, the browser resamples — and a resample along one
   * axis only is what turns a punched hole into an oval. `ResizeObserver`
   * reports the true device box in `devicePixelContentBoxSize`; pass it here
   * and the sheet is 1:1 with the screen at every width and every DPR.
   */
  wDev?: number;
  hDev?: number;
  pitch?: number;
  holeRatio?: number;
  seed?: number;
  sheet?: RGB;
  driver?: Driver | null;
  grain?: HTMLCanvasElement | null;
  lampAt?: [number, number];
}
export interface KnurlOptions {
  d: number;
  dpr?: number;
  phase?: number;
  r0?: number;
  r1?: number;
  pitchPx?: number;
  flank?: number;
  cone?: number;
  depth?: number;
  teeth?: number;
  albedo?: RGB;
  spec?: number;
  /**
   * Area-sampling factor. The contrast fade below fixes MOIRÉ; it does not fix
   * the staircase on a radial edge, because a tooth boundary is still a hard
   * geometric edge inside one pixel. Averaging the shading over ss × ss
   * subsamples in LINEAR light (before the gamma encode, which is the only
   * order that is correct) is what removes it. Baked once, so the cost is
   * startup, not frame time.
   */
  ss?: number;
}
export interface DomeOptions {
  d: number;
  dpr?: number;
  tint?: RGB;
  cap?: number;
  shine?: number;
  gloss?: number;
  peel?: number;
  lamp?: number;
  glow?: number;
  lampColor?: RGB;
  sigma?: number;
  glassy?: boolean;
  seat?: number;
  seed?: number;
}
export interface BezelOptions {
  d: number;
  dpr?: number;
  r0?: number;
  r1?: number;
  pitchPx?: number;
  smooth?: boolean;
  /**
   * How polished the ring is. 1 = the machined bezel a jewel sits in; ~1.9 is
   * the bright plated band around the upper edge of a tone knob, which is a
   * near-mirror and therefore mostly a picture of the room.
   */
  polish?: number;
  /** Tilt of the band's surface, radians-ish. Higher = more of the room in it. */
  tilt0?: number;
  tilt1?: number;
  /** Area-sampling factor, as `knurlSprite`. */
  ss?: number;
}
export interface DiscOptions {
  d: number;
  dpr?: number;
  groovePx?: number;
  rough?: number;
  tone?: RGB;
  rim?: number;
  dimple?: number;
  seed?: number;
  /** Area-sampling factor, as `knurlSprite`. */
  ss?: number;
}
export interface WearOptions {
  w: number;
  h: number;
  dpr?: number;
  seed?: number;
  controls?: WearControl[];
  strength?: number;
  edges?: Edge[];
}
export interface DustOptions {
  w: number;
  h: number;
  dpr?: number;
  seed?: number;
  n?: number;
}
export interface BarOptions {
  w: number;
  h: number;
  dpr?: number;
  axis?: 'v' | 'h';
  radius?: number;
  tone?: RGB;
  shine?: number;
  gloss?: number;
  seed?: number;
  scuff?: number;
  /** Draw a real fold-out bracket: mounting feet, pivot knuckles, ribbed grip. */
  bracket?: boolean;
  /** Mounting-foot length in CSS px. The fastener is centred on `footPx / 2`. */
  footPx?: number;
  /** Grip rib pitch in CSS px. Ribs fade out below Nyquist rather than alias. */
  ribPx?: number;
}
export interface ScrewOptions {
  d: number;
  dpr?: number;
  slot?: 'phillips' | 'slot';
  angle?: number;
}
/** A knurl sprite sheet: every rotation phase in one canvas. */
export interface KnurlSheet extends HTMLCanvasElement {
  teeth: number;
  phases: number;
  cell: number;
}

/* ------------------------------------------------------------------ helpers */

interface Mark {
  name: string;
  ms: number;
}
const marks: Mark[] = [];
export function bake<T>(name: string, fn: () => T): T {
  const t0 = performance.now();
  const out = fn();
  marks.push({ name, ms: +(performance.now() - t0).toFixed(2) });
  return out;
}
export function timings(): Mark[] {
  return marks.slice();
}

/** Deterministic PRNG — the same case must have the same scratches every launch. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** Cheap integer hash, for per-hole / per-tooth variation without storing an array. */
function hash2(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >> 13)) * 1274126177 | 0;
  return ((h ^ (h >> 16)) >>> 0) / 4294967296;
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/* -------------------------------------------------------------- the one light
   Shared by every shader here. Screen space, y down, +z toward the viewer.
   Upper left, well above the plane: this is tokens.css --lit-x/--lit-y made
   into a vector so that domes, knurl and holes cannot silently disagree.       */

const L = (() => {
  const v = [-0.46, -0.60, 0.655];
  const m = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / m, v[1] / m, v[2] / m];
})();
/* Half-vector for a viewer at (0,0,1). */
const H = (() => {
  const v = [L[0], L[1], L[2] + 1];
  const m = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / m, v[1] / m, v[2] / m];
})();

/* THE ROOM.

   A two-band environment: bright sky above the horizon, dark desk below, and a
   hard horizon line between them. This is the single thing that separates a
   render of a dome from a photograph of one. A web-2.0 orb is a colour ramp
   with a blurred white blob on it; a photographed dome is mostly a picture of
   the room it is sitting in, and rooms have a horizon.

   `metal` raises the contrast hard, because a polished part is close to a
   mirror: almost everything you see in chrome is the room, not the chrome.  */
function envSample(ry: number, warm: boolean, metal: boolean): [number, number, number] {
  // ry: y component of the reflection vector, -1 (up) .. +1 (down)
  const sky = smoothstep(0.10, -0.75, ry);
  const desk = smoothstep(0.02, 0.55, ry);
  const band = Math.exp(-((ry - 0.02) * (ry - 0.02)) / (metal ? 0.0022 : 0.006));
  let v;
  if (metal) {
    /* bright ceiling, a hot horizon, a near-black desk, and a second dim
       bounce low down off whatever the set is standing on */
    v = sky * 1.35 + band * 0.75 + desk * 0.045 + 0.035
      + smoothstep(0.55, 0.95, ry) * 0.10;
  } else {
    v = sky * 0.95 + band * 0.5 + desk * 0.06;
  }
  return [v * (warm ? 1.0 : 0.985), v * (warm ? 0.975 : 0.99), v * (warm ? 0.92 : 1.0)];
}

/* An AREA light, not a point.

   A point light gives a round Phong dot, which is the giveaway on every CG
   sphere ever rendered. A real lamp or window is an extended source, and the
   specular you see is a picture of its SHAPE. Five samples across a small
   rectangular source is enough to turn the round dot into a shaped, soft-edged
   highlight with a defined boundary — the boundary is what says "sharp", the
   shape is what says "photograph". */
const AREA = (() => {
  const out = [];
  const wide = 0.085, tall = 0.045;      // the source, in direction-space
  for (const [ox, oy, k] of [[0, 0, 1], [-wide, -tall, 0.8], [wide, tall, 0.8], [-wide * 0.6, tall, 0.55], [wide * 0.6, -tall, 0.55]]) {
    const v = [L[0] + ox, L[1] + oy, L[2]];
    const m = Math.hypot(v[0], v[1], v[2]);
    const l = [v[0] / m, v[1] / m, v[2] / m];
    const h = [l[0], l[1], l[2] + 1];
    const hm = Math.hypot(h[0], h[1], h[2]);
    out.push({ h: [h[0] / hm, h[1] / hm, h[2] / hm], w: k });
  }
  const tot = out.reduce((a, b) => a + b.w, 0);
  for (const s of out) s.w /= tot;
  return out;
})();

function areaSpec(nx: number, ny: number, nz: number, exp: number): number {
  let s = 0;
  for (const { h, w } of AREA) {
    const d = nx * h[0] + ny * h[1] + nz * h[2];
    if (d > 0) s += w * Math.pow(d, exp);
  }
  return s;
}

/* ============================================================================
   1. BRUSHED ALUMINIUM — a seamless anisotropic grain tile.

   Why not `repeating-linear-gradient`: it is periodic, and the eye is a very
   good periodicity detector. Three coprime periods still beat into a visible
   corduroy because all three are exactly periodic; coprimality only lengthens
   the repeat, it does not remove it.

   What a linisher actually leaves is a stochastic field of long, thin, mostly
   parallel scratches of varying depth, on top of a slow across-grain luminance
   drift from the belt's own wear. So: draw that.

   Seamless in x (scratches wrap) and in y (the drift is a sum of sines with
   integer periods). One tile serves every aluminium surface in the app.
   ========================================================================== */

export function brushedTile({ w = 1024, h = 512, seed = 11, amp = 1 }: BrushedOptions = {}): HTMLCanvasElement {
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: false })!;
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const rand = rng(seed);

  /* AMPLITUDE. Measured off a photograph of a brushed 6800W front panel, the
     across-grain luminance spread is about +-6 levels out of 255 with a long
     bright tail from the deep scratches. That is much quieter than it feels
     like it should be: grain you can consciously see at 1x is already too
     strong, and the shipping repeating-gradient sits at nearly +-24. So the
     tile is built to sigma ~4 and given its visibility by the SHEEN, not by
     contrast. */
  const harm = [];
  for (let k = 0; k < 6; k++) {
    harm.push({ f: [1, 2, 3, 5, 8, 13][k], a: (2.1 / (k + 1.2)) * amp, p: rand() * Math.PI * 2 });
  }
  const rowBase = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    let v = 0;
    for (const { f, a, p } of harm) v += a * Math.sin((y / h) * Math.PI * 2 * f + p);
    rowBase[y] = v;
  }

  /* Base field: 128 is neutral for the `overlay` blend this layer is used with,
     so the tile modulates the surface colour rather than replacing it. */
  for (let y = 0; y < h; y++) {
    const rb = rowBase[y];
    /* per-row offset: adjacent brush passes sit at slightly different depths */
    const rj = (hash2(0, y) - 0.5) * 3.4 * amp;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) << 2;
      /* fine tooth, correlated along x over ~4px so it reads as drawn metal
         rather than as television snow */
      const n = (hash2(x >> 2, y * 7) - 0.5) * 3.4 + (hash2(x, y) - 0.5) * 1.5;
      const v = 128 + rb + rj + n * amp;
      d[i] = d[i + 1] = d[i + 2] = clamp(v, 0, 255);
      d[i + 3] = 255;
    }
  }

  /* The scratches. Length is heavy-tailed: mostly short passes, a few that run
     right across the panel. Ends taper, because a scratch does not stop dead.
     These are sparse and mostly faint; the handful of strong ones are what
     catch the sheen and make the surface read as linished. */
  const paint = (x0: number, len: number, y: number, val: number, alpha: number, thickness: number): void => {
    for (let t = 0; t < len; t++) {
      const a = alpha * smoothstep(0, 1, Math.min(t, len - t) / (len * 0.34 + 1));
      const x = ((x0 + t) % w + w) % w;
      for (let ty = 0; ty < thickness; ty++) {
        const yy = (y + ty) % h;
        const i = (yy * w + x) << 2;
        const nv = clamp(mix(d[i], val, a * (ty === 0 ? 1 : 0.4)), 0, 255);
        d[i] = d[i + 1] = d[i + 2] = nv;
      }
    }
  };

  /* DENSITY. The previous figure — one scratch per 900 px² — put about one
     pass on every row of the tile, which on the front face (seen at 1:1, not
     foreshortened like the cheeks) measured 2.1% peak-to-peak across a 60 px
     run: a surface with no grain in it. A linisher belt makes one pass every
     fraction of a millimetre, so the correct density is "several per row, most
     of them faint", and the visible ones are the handful the sheen catches. */
  const nScratch = Math.round((w * h) / 260);
  for (let s = 0; s < nScratch; s++) {
    const y = (rand() * h) | 0;
    const len = Math.round(20 + Math.pow(rand(), 2.6) * w * 1.05);
    const x0 = (rand() * w) | 0;
    const strength = (0.05 + Math.pow(rand(), 2.4) * 0.30) * amp;
    paint(x0, Math.min(len, w), y, rand() < 0.55 ? 255 : 0, strength, 1);
  }
  /* the deep ones — perhaps one row in twenty-two. These are the passes that
     read as grain at arm's length; everything above them is what stops the
     surface looking ruled. */
  for (let s = 0; s < Math.round(h / 22); s++) {
    const y = (rand() * h) | 0;
    paint((rand() * w) | 0, w, y, rand() < 0.66 ? 255 : 20, (0.12 + rand() * 0.2) * amp, 1);
  }

  ctx.putImageData(img, 0, 0);
  return c;
}

/* ============================================================================
   2. SPEAKER GRILLE — real punched geometry, per hole.

   The current implementation is four tiled radial gradients. That buys a
   perfectly regular lattice of identical cells whose "hole" is a 2px dark dot
   inside a 3px bright ring — which is the signature of an embossed dome, not a
   void. Measured on the shipping screenshot: sheet luminance ~150, hole core
   ~45. A hole with a cabinet behind it should bottom out near 12.

   Here each hole is drawn individually so it can have its own jitter, radius,
   void depth and dirt. The order of operations is the physics:

     a. the sheet keeps its brushed grain (the web between holes is metal)
     b. the punch's rolled entry lip: bright arc on the UPPER-LEFT (its normal
        tilts toward the light), dark arc on the lower-right
     c. the bore's inner wall: the wall you can see lit is the one OPPOSITE the
        light, i.e. a thin warm crescent low-right inside the hole; the
        upper-left inner wall is in the lip's shadow
     d. the void: near-black, varying hole to hole, with the faintest lift where
        the raking light reaches the cone behind

   Antialiasing is analytic (coverage from the distance field), not canvas arc
   AA, because at a 4.4px hole diameter canvas AA is not good enough.
   ========================================================================== */

export function grilleSheet({
  w, h, dpr = 1, wDev = 0, hDev = 0, pitch = 9.2, holeRatio = 0.60,
  sheet = [146, 141, 131],          // lit sheet colour
  driver = null,                     // {x,y,r} in CSS px — the cone behind
  grain = null,                      // a brushedTile() canvas — the web between
                                     // holes is the SAME metal as the case, so
                                     // it must carry the same grain, not a
                                     // private noise field
  lampAt = [0.26, 0.12],
}: GrilleOptions): HTMLCanvasElement {
  const W = Math.max(1, Math.round(wDev > 0 ? wDev : w * dpr));
  const Hh = Math.max(1, Math.round(hDev > 0 ? hDev : h * dpr));
  const c = makeCanvas(W, Hh);
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(W, Hh);
  const d = img.data;

  /* THE PITCH IS PHYSICAL. A punch press has one tool and one feed, so the hole
     spacing is a property of the sheet, never of how much sheet there is. It is
     stated in device pixels and it does not move: widening the cabinet adds
     COLUMNS, it does not stretch the ones already there. That is only true so
     long as the backing store is exactly the size the compositor draws it at —
     hence `wDev`/`hDev` above. */
  const P = pitch * dpr;                 // pitch in device px
  const rowH = P * Math.sin(Math.PI / 3);
  const R = (P * holeRatio) / 2;         // nominal hole radius, device px
  /* The rolled entry lip needs at least a device pixel of room on each side or
     it cannot be seen; below that, widen the hole rather than lose the lip. */
  const lipW = Math.max(1.15 * dpr, R * 0.34);

  /* --- 1. the sheet, with a shading field ------------------------------- */
  let gd: Uint8ClampedArray | null = null;
  let gw = 0;
  let gh = 0;
  if (grain) {
    gw = grain.width; gh = grain.height;
    gd = grain.getContext('2d')!.getImageData(0, 0, gw, gh).data;
  }
  for (let y = 0; y < Hh; y++) {
    for (let x = 0; x < W; x++) {
      const u = x / W, v = y / Hh;
      const dl = Math.hypot((u - lampAt[0]) * 0.9, v - lampAt[1]);
      /* the same anisotropic sheen band the rest of the case carries: wide in
         x, tight in y, so the punched field belongs to the same sheet */
      const sheen = Math.exp(-Math.pow((v - 0.20) * 2.3, 2)) * 0.11 * (1.15 - u * 0.5);
      const lamp = 1.01 + sheen - smoothstep(0.05, 1.10, dl) * 0.30;
      /* overlay the shared grain, at the same scale the case uses */
      let g = 1;
      if (gd) {
        const gi = (((y % gh) * gw + (x % gw)) << 2);
        g = 1 + (gd[gi] - 128) / 128 * 0.50;
      }
      const k = lamp * g;
      const i = (y * W + x) << 2;
      d[i] = clamp(sheet[0] * k, 0, 255);
      d[i + 1] = clamp(sheet[1] * k, 0, 255);
      d[i + 2] = clamp(sheet[2] * k, 0, 255);
      d[i + 3] = 255;
    }
  }

  /* --- 2. the holes ------------------------------------------------------ */
  const cols = Math.ceil(W / P) + 2;
  const rows = Math.ceil(Hh / rowH) + 2;

  const put = (x: number, y: number, r: number, g: number, b: number, a: number): void => {
    if (x < 0 || y < 0 || x >= W || y >= Hh || a <= 0) return;
    const i = (y * W + x) << 2;
    d[i] = mix(d[i], r, a);
    d[i + 1] = mix(d[i + 1], g, a);
    d[i + 2] = mix(d[i + 2], b, a);
  };

  for (let ry = -1; ry < rows; ry++) {
    for (let cx = -1; cx < cols; cx++) {
      const odd = ry & 1;
      const hx = cx * P + (odd ? P / 2 : 0);
      const hy = ry * rowH;

      /* per-hole variation — a punch press is not a printer */
      const j1 = hash2(cx + 97, ry + 13);
      const j2 = hash2(cx + 311, ry + 701);
      const j3 = hash2(cx + 7, ry + 4099);
      const jx = hx + (j1 - 0.5) * 0.62 * dpr;
      const jy = hy + (j2 - 0.5) * 0.62 * dpr;
      const rr = R * (0.90 + j3 * 0.19);

      /* how dark this particular void is: what is behind varies (cone, felt,
         the frame, a bit of dust). ~1.5% of holes are half blocked by paint. */
      const clogged = j1 * j2 > 0.955;
      /* What is behind a given hole varies a lot in a real cabinet — cone,
         felt, frame, dust — and uniform black voids are exactly what makes a
         perforated field read as a printed halftone. */
      let voidL = 7 + Math.pow(j3, 1.6) * 27;
      if (driver) {
        const dd = Math.hypot(hx / dpr - driver.x, hy / dpr - driver.y) / driver.r;
        voidL += smoothstep(1.0, 0.25, dd) * 9;  // the cone catches a little light
      }
      if (clogged) voidL += 48 + j2 * 30;

      const outer = rr + lipW + 1.2 * dpr;
      const x0 = Math.max(0, Math.floor(jx - outer)), x1 = Math.min(W - 1, Math.ceil(jx + outer));
      const y0 = Math.max(0, Math.floor(jy - outer)), y1 = Math.min(Hh - 1, Math.ceil(jy + outer));

      for (let y = y0; y <= y1; y++) {
        const dy = y + 0.5 - jy;
        for (let x = x0; x <= x1; x++) {
          const dx = x + 0.5 - jx;
          const dist = Math.hypot(dx, dy);
          if (dist > outer) continue;
          const ang = dist > 1e-6 ? [dx / dist, dy / dist] : [0, -1];
          /* how much this direction faces the light, in plan */
          /* How much this bit of rim faces the lamp. The outward radial
             direction at this point is `ang`; the rolled lip's normal tilts
             along it, so ang . L is the Lambert term directly. NOTE the sign:
             L points from the surface TOWARD the light (up and to the left, so
             both components negative), and `ang` at the upper-left of the hole
             is also negative in both — their dot product is positive there.
             Negating this is the difference between a punched hole and an
             embossed pimple, and it is invisible until you look at 4x. */
          const facing = ang[0] * L[0] + ang[1] * L[1];   // +1 = upper-left side

          /* (b) rolled entry lip, OUTSIDE the bore. The punch rolls the sheet
             down into the hole all the way round, so the lip's normal tilts
             toward whatever direction that bit of rim faces. Upper-left rim
             turns into the light and goes bright; lower-right rim turns away
             and goes dark. This is the pair of crescents that says "punched". */
          const lip = smoothstep(rr + lipW, rr + lipW * 0.10, dist) *
                      smoothstep(rr - 0.7 * dpr, rr + 0.4 * dpr, dist);
          if (lip > 0) {
            const t = lip * (0.16 + 0.84 * Math.abs(facing));
            if (facing > 0) {
              /* the rolled edge is polished by the punch, so it does not just get
                 lighter, it takes a specular — that hot 1px arc is what makes
                 the eye read a hole rather than a printed dot */
              put(x, y, 255, 253, 245, clamp(t * 1.15 * facing, 0, 0.92));
            } else {
              put(x, y, 24, 22, 20, t * 0.72 * -facing);
            }
          }

          /* coverage of the bore, analytically antialiased */
          const cov = clamp(rr + 0.5 - dist, 0, 1);
          if (cov <= 0) continue;

          /* (c) inner wall. The wall you can see LIT is the one opposite the
             light: the beam comes in over the upper-left rim and lands on the
             lower-right bore wall. The near wall is in the lip's own shadow and
             is darker than the void behind it. Getting this backwards is what
             turns a hole into a dome. */
          const wallBand = Math.min(lipW * 1.15, rr * 0.46);
          const wall = smoothstep(rr - wallBand, rr, dist);   // 0 centre .. 1 rim
          let lr, lg, lb;
          if (facing < 0) {
            const k = wall * Math.pow(-facing, 1.25);
            lr = mix(voidL, 186, k * 0.95);
            lg = mix(voidL, 176, k * 0.95);
            lb = mix(voidL, 154, k * 0.95);
          } else {
            const k = wall * Math.pow(facing, 1.1);
            lr = lg = lb = Math.max(3, voidL - k * 8);
          }
          /* the void floor itself, with a hair of noise so it is not a flat fill */
          const gn = (hash2(x * 3, y * 5) - 0.5) * 4.5;
          put(x, y, lr + gn, lg + gn, lb + gn, cov);
        }
      }
    }
  }

  ctx.putImageData(img, 0, 0);
  return c;
}

/* ============================================================================
   3. KNURLING — per-pixel, with analytic antialiasing and a real facet normal.

   Two things are wrong with `repeating-conic-gradient`:

     - The angular period is constant, so the arc-length period shrinks toward
       the middle of the annulus. On a 56px knob the shipping value (2.2deg =>
       164 teeth) puts the tooth pitch at 0.5 device px. Nothing can render that;
       it moires.
     - A conic gradient has no pixel footprint, so it cannot fade out when it
       drops below Nyquist.

   Fixes: (a) choose the tooth count from the pixels — pitch ~3.2 device px at
   the outer radius; (b) compute each pixel's angular footprint and lerp the
   tooth contrast to the local mean as it approaches half a period. That is a
   mip-map, done analytically. (c) shade from the actual flank normal, so the
   flank that catches the light swaps sides as you go round the knob, and the
   contrast decays toward the shaded quadrant on its own instead of being
   masked down by hand.

   ROTATION. An N-tooth knurl is N-fold rotationally symmetric, so the lit
   appearance at rotation phi equals the lit appearance at phi mod (2pi/N).
   One tooth period of pre-baked phases therefore covers the whole travel
   exactly — 6 sprites, not 360. The light stays fixed while the metal turns,
   which is the whole point.
   ========================================================================== */

/**
 * How many flutes fit on a knurl of this size before they stop resolving.
 *
 * The tooth count comes off the TIGHTEST arc on the band, which is the inner
 * radius, not the outer one. Deriving it from `Rout` — as this did — puts the
 * inner third of every small knob below Nyquist, and the analytic fade then
 * does exactly what it is supposed to: it collapses the teeth to the period
 * mean. The result is a smooth grey ring, which is precisely what the tone
 * knobs were rendering. Physically this is also the right derivation: the
 * flutes are parallel to the knob's axis, so their ANGULAR spacing is constant
 * and the arc pitch grows outward, exactly as on a real rolled knurl.
 */
function knurlTeeth(dPx: number, r0: number, pitchPx: number): number {
  return Math.max(10, Math.round((2 * Math.PI * ((dPx / 2) * r0)) / pitchPx));
}

export function knurlSprite({
  d: diameter, dpr = 1, phase = 0,
  r0 = 0.54, r1 = 0.86,          // annulus, fraction of radius
  pitchPx = 6.4,                 // MINIMUM tooth pitch, device px, at r0
  flank = 0.92,                  // flank angle from the knob axis, radians
  cone = 0.55,                   // how far the knurled band tilts outward
  depth = 1,                     // groove contrast
  teeth = 0,                     // 0 = derive from pitch
  albedo = [0.042, 0.042, 0.048],// BLACK plastic, and black means black: 0.125
                                 // linear encodes to 36% grey, which is why a
                                 // knurl built on it read as a steel gear. The
                                 // diffuse term is multiplied by the part's own
                                 // colour and only the speculars may go bright.
  spec = 1,
  ss = 2,
}: KnurlOptions): HTMLCanvasElement {
  const S = Math.round(diameter * dpr);
  const c = makeCanvas(S, S);
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(S, S);
  const dd = img.data;

  const cxy = S / 2;
  const Rout = cxy * r1, Rin = cxy * r0;
  const N = teeth || knurlTeeth(S, r0, pitchPx);

  const sinF = Math.sin(flank), cosF = Math.cos(flank);
  const sinC = Math.sin(cone), cosC = Math.cos(cone);
  const sub = Math.max(1, Math.round(ss));
  const nSub = sub * sub;
  const step = 1 / sub;

  /** Radiance at one point on the band, linear. Returns [r,g,b,coverage]. */
  const shade = (px: number, py: number, out: number[]): void => {
    const r = Math.hypot(px, py);
    const edgeIn = smoothstep(Rin - 0.5, Rin + 1.6, r);
    const edgeOut = 1 - smoothstep(Rout - 1.2, Rout + 0.5, r);
    const alpha = clamp(edgeIn * edgeOut, 0, 1);
    if (alpha <= 0) { out[0] = out[1] = out[2] = out[3] = 0; return; }

    const th = Math.atan2(py, px);
    const ct = Math.cos(th), st = Math.sin(th);

    /* base normal of the cone band: radial tilt + axis */
    const bx = ct * sinC, by = st * sinC, bz = cosC;
    /* tangent */
    const tx = -st, ty = ct;

    /* tooth phase and its footprint in phase units (1px subtends 1/r rad) */
    const ph = (th * N) / (2 * Math.PI) + phase * N / (2 * Math.PI);
    const f = ph - Math.floor(ph);
    const foot = N / (2 * Math.PI * Math.max(r, 0.5));
    /* below Nyquist -> collapse to the period mean. This is the moire fix. */
    const sharp = 1 - smoothstep(0.16, 0.46, foot);

    /* V groove: two flanks meeting at f=0 (groove floor) and f=0.5 (crest) */
    const side = f < 0.5 ? 1 : -1;
    const u = f < 0.5 ? f * 2 : (1 - f) * 2;      // 0 at floor, 1 at crest

    /* flank normal = cone normal rotated by +-flank about the radial axis */
    let nx = bx * cosF + tx * sinF * side;
    let ny = by * cosF + ty * sinF * side;
    let nz = bz * cosF;
    const nm = Math.hypot(nx, ny, nz);
    nx /= nm; ny /= nm; nz /= nm;

    const ndl = Math.max(0, nx * L[0] + ny * L[1] + nz * L[2]);

    /* ambient occlusion down in the groove; the crest is exposed */
    const ao = 0.24 + 0.76 * Math.pow(u, 0.8);
    /* the crest is rolled over, so it carries a thin sharp specular */
    const crest = Math.pow(clamp(u, 0, 1), 22);

    /* per-tooth variation: rolled knurling is not a milled gear */
    const ti = Math.floor(ph);
    const vary = 0.90 + hash2(ti, 3) * 0.19;

    /* Diffuse is multiplied by the part's albedo; only the two speculars are
       allowed to reach white. The flank facing the lamp therefore reads as a
       thin bright line on a dark body, which is what knurled black plastic
       actually looks like — not as a bright tooth on a grey gear. */
    const dif = ndl * 1.15 * ao * vary;
    const sp = (areaSpec(nx, ny, nz, 34) * 0.46 * ao + crest * areaSpec(nx, ny, nz, 9) * 0.95) * spec;

    /* the period mean, for the antialiased fallback */
    const mndl = Math.max(0, bx * L[0] + by * L[1] + bz * L[2]);
    const meanDif = mndl * 0.62;
    const meanSp = Math.pow(Math.max(0, bx * H[0] + by * H[1] + bz * H[2]), 22) * 0.10 * spec;

    const kd = mix(meanDif, dif, sharp * depth);
    const ks = mix(meanSp, sp, sharp * depth);

    /* the arris: the rolled-over top edge of the knob catches a hard 1px
       highlight where it faces the lamp and nothing at all where it does not.
       An unbroken ring of highlight all the way round is the classic tell of
       a border-radius rather than an object. */
    const facing = ct * L[0] + st * L[1];
    const arris = Math.exp(-Math.pow((r - (Rout - 0.9)) * 1.5, 2)) * Math.max(0, facing) * 0.55;

    for (let ch = 0; ch < 3; ch++) {
      out[ch] = albedo[ch] * (0.22 + kd) + ks * (0.97 + 0.03 * ch) + arris;
    }
    out[3] = alpha;
  };

  const acc = [0, 0, 0, 0];
  const one = [0, 0, 0, 0];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) << 2;
      acc[0] = acc[1] = acc[2] = acc[3] = 0;
      for (let sy = 0; sy < sub; sy++) {
        const py = y + (sy + 0.5) * step - cxy;
        for (let sx = 0; sx < sub; sx++) {
          shade(x + (sx + 0.5) * step - cxy, py, one);
          /* Radiance is averaged premultiplied by coverage, so a subsample that
             falls off the silhouette contributes darkness to neither channel. */
          acc[0] += one[0] * one[3];
          acc[1] += one[1] * one[3];
          acc[2] += one[2] * one[3];
          acc[3] += one[3];
        }
      }
      const a = acc[3] / nSub;
      if (a <= 0) { dd[i + 3] = 0; continue; }
      for (let ch = 0; ch < 3; ch++) {
        /* un-premultiply, then encode — averaging in linear light and gamma
           encoding once is the only order that does not lighten the grooves. */
        dd[i + ch] = clamp(Math.pow(clamp(acc[ch] / acc[3], 0, 3), 1 / 1.9) * 255, 0, 255);
      }
      dd[i + 3] = a * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/* ============================================================================
   4. DOMES AND JEWELS — a per-pixel shading model.

   What makes the shipping power button read as "glossy web 2.0" is precisely
   what a soft radial-gradient highlight is: one blurred white blob on a smooth
   colour ramp. Real domed plastic under one lamp has, in order of how much each
   one matters:

     - a SHARP specular whose *shape* is soft but whose *edge* is not, broken up
       by the moulding's orange peel
     - a Fresnel rim: at grazing angles the surface reflects almost everything,
       so there is a thin bright ring at the silhouette, brightest toward the
       light and never fully absent
     - an environment horizon — the dark desk reflected across the lower third,
       a hard-ish line, not a gradient
     - transmission: the view path through coloured plastic is longer at the rim,
       so the colour deepens and desaturates outward
     - when lit from inside, a caustic: the lamp's light refocuses low in the
       dome, so the lower inner half is BRIGHTER than the middle, the opposite
       of a top-lit gradient

   All five are two or three lines here and none of them are expressible as a
   CSS gradient stack.
   ========================================================================== */

export function domeSprite({
  d: diameter, dpr = 1,
  tint = [0.80, 0.13, 0.09],      // body absorption colour
  cap = 0.96,                      // sin of the cap half-angle; 1 = hemisphere
  shine = 120,                     // specular exponent
  gloss = 0.85,
  peel = 0.5,                      // orange-peel amplitude
  lamp = 0,                        // internal lamp 0..1
  glow = 1,                        // how much of the lamp gets through; a
                                   // diffused jewel scatters far more than a
                                   // clear moulded button does
  lampColor = [1.0, 0.30, 0.16],
  sigma = 2.4,                     // absorption strength; higher = more saturated
  glassy = false,                  // true = jewel (harder spec, stronger Fresnel)
  seat = 0.10,                     // fraction of radius given to the seating shadow
  seed = 3,
}: DomeOptions): HTMLCanvasElement {
  const S = Math.round(diameter * dpr);
  const c = makeCanvas(S, S);
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(S, S);
  const dd = img.data;
  const cxy = S / 2;
  const R = cxy - 0.5;
  const Rd = R * (1 - seat);
  const F0 = glassy ? 0.075 : 0.05;
  const shininess = glassy ? shine * 2.2 : shine;

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) << 2;
      const px = (x + 0.5 - cxy), py = (y + 0.5 - cxy);
      const rr = Math.hypot(px, py);
      if (rr > Rd + 1) { dd[i + 3] = 0; continue; }
      const u = px / Rd, v = py / Rd;
      const q = clamp(u * u + v * v, 0, 1);

      /* spherical cap normal */
      let nx = u * cap, ny = v * cap;
      const nz = Math.sqrt(Math.max(1e-5, 1 - clamp(q * cap * cap, 0, 1)));

      /* orange peel: perturb the normal with a little value noise. This is what
         breaks the specular's edge into something photographic. */
      if (peel > 0) {
        const s = 0.16 * peel;
        const k = 6.5;
        nx += (hash2(Math.round(px * k) + seed, Math.round(py * k)) - 0.5) * s * 0.30;
        ny += (hash2(Math.round(px * k) + 51, Math.round(py * k) + seed) - 0.5) * s * 0.30;
      }
      const nm = Math.hypot(nx, ny, nz);
      const Nx = nx / nm, Ny = ny / nm, Nz = nz / nm;

      const ndv = clamp(Nz, 0, 1);
      const ndl = Math.max(0, Nx * L[0] + Ny * L[1] + Nz * L[2]);

      /* Fresnel (Schlick) */
      const fres = F0 + (1 - F0) * Math.pow(1 - ndv, 5);

      /* environment reflection: R = 2(N.V)N - V, V = (0,0,1) */
      /* Push the reflected horizon BELOW the dome's equator. On a real button
         the desk edge sits low in the reflection because the part is above eye
         level of the desk; a horizon through the middle bisects the dome and
         reads as a graphic device. */
      const ry = 2 * ndv * Ny - 0.30;
      const env = envSample(ry, false, false);

      /* transmission through the body: longer path at the rim */
      const path = 1 / Math.max(ndv, 0.16);
      const ab = [
        Math.exp(-(1 - tint[0]) * sigma * path),
        Math.exp(-(1 - tint[1]) * sigma * path),
        Math.exp(-(1 - tint[2]) * sigma * path),
      ];

      /* what is behind the dome. Off: a dark reflector cup, darkest at the rim.
         On: the lamp, plus a caustic that pools LOW because light entering the
         top refracts down and refocuses against the lower inner wall. */
      /* WHAT IS BEHIND THE PLASTIC.

         Off: a dark reflector cup, darkest where you look deepest into it.
         On: an EMITTER, not a fill. Three distinct things, because that is what
         a photograph of a lit dome shows and a uniform glow is what a render
         shows:
           - the die itself, a small hard core sitting low and slightly left of
             centre, where the lamp actually is
           - a diffuse spread through the moulding, falling off with distance
           - a caustic ring: light that entered the top of the dome refracts
             down and pools against the LOWER inner wall, so the bottom edge is
             brighter than the middle. A top-lit gradient does the opposite, and
             getting it upside down is half of why the shipping button reads as
             a web-2.0 orb. */
      const cup = 0.045 + 0.085 * (1 - q);
      let die = 0, spread = 0, ring = 0;
      if (lamp > 0) {
        die = Math.exp(-(Math.pow((u + 0.06) * 2.4, 2) + Math.pow((v - 0.36) * 2.4, 2))) * 0.55;
        spread = 0.20 * (1 - 0.48 * q);
        ring = Math.exp(-Math.pow((rr / Rd - 0.87) * 8.5, 2)) * Math.pow(clamp(v, 0, 1), 1.3) * 0.62;
      }
      const inner = cup + lamp * glow * (die + spread + ring);

      /* Two reflections, from two directions.
         The primary is the lamp: small, hard-edged, shaped like the source.
         The secondary is the room behind the viewer — broad, weak, lower right.
         One highlight is a render. Two is a photograph. */
      const spec = areaSpec(Nx, Ny, Nz, shininess) * gloss;
      const core = areaSpec(Nx, Ny, Nz, shininess * 5) * gloss * 0.9;
      const l2 = 0.5015 * Nx + 0.2007 * Ny + 0.8414 * Nz;   // normalize(.55,.22,.92) . N
      const spec2 = l2 > 0 ? Math.pow(l2, 26) * 0.085 : 0;

      let r = 0, g = 0, b = 0;
      for (let ch = 0; ch < 3; ch++) {
        const body = inner * ab[ch];
        const lampC = lamp * glow * (die * 0.85 + ring * 0.55) * lampColor[ch] * ab[ch];
        const diff = ndl * 0.14 * ab[ch];
        const val =
          body * (1 - fres) +
          lampC +
          diff +
          env[ch] * fres * (glassy ? 2.4 : 1.5) +
          /* the Fresnel rim: at grazing angles a dielectric reflects almost
             everything, so there is always a thin bright ring at the
             silhouette. Its absence is why a CG dome looks like it was cut out
             of the background. */
          Math.pow(clamp(1 - ndv, 0, 1), 3.5) * 0.42 * (0.55 + 0.45 * ndl) +
          (spec + core + spec2) * (0.95 + 0.05 * ch);
        if (ch === 0) r = val; else if (ch === 1) g = val; else b = val;
      }

      /* the moulding's parting ring, and the seating: a hard dark contact line
         where the dome drops into its collar, plus the collar's own bounce */
      const part = Math.exp(-Math.pow((rr / Rd - 0.94) * 26, 2)) * 0.10;
      r *= 1 - part; g *= 1 - part; b *= 1 - part;
      const contact = smoothstep(Rd - 1.9, Rd + 0.4, rr);
      r = mix(r, 0.030, contact * 0.82);
      g = mix(g, 0.026, contact * 0.82);
      b = mix(b, 0.026, contact * 0.82);

      const cov = clamp(Rd + 0.5 - rr, 0, 1);
      dd[i] = clamp(Math.pow(clamp(r, 0, 4), 1 / 1.9) * 255, 0, 255);
      dd[i + 1] = clamp(Math.pow(clamp(g, 0, 4), 1 / 1.9) * 255, 0, 255);
      dd[i + 2] = clamp(Math.pow(clamp(b, 0, 4), 1 / 1.9) * 255, 0, 255);
      dd[i + 3] = cov * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/* ============================================================================
   5. MACHINED BEZEL — the ring the jewel sits in.

   The shipping bezel is a `repeating-conic-gradient` at 2.2deg on a 26px
   circle: 164 teeth around an 82px circumference. That is 0.5px per tooth, so
   it renders as noise — the critic's word was "lichen". Same analytic-AA
   treatment as the knurl, plus a conic environment so the ring reads as turned
   metal reflecting a room rather than a striped disc.
   ========================================================================== */

export function bezelSprite({
  d: diameter, dpr = 1, r0 = 0.62, r1 = 1.0, pitchPx = 3.4, smooth = false,
  polish = 1, tilt0 = 0.30, tilt1 = 0.55, ss = 2,
}: BezelOptions): HTMLCanvasElement {
  const S = Math.round(diameter * dpr);
  const c = makeCanvas(S, S);
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(S, S);
  const dd = img.data;
  const cxy = S / 2, Rout = cxy * r1 - 0.5, Rin = cxy * r0;
  const N = Math.max(10, Math.round((2 * Math.PI * Rin) / pitchPx));
  const sub = Math.max(1, Math.round(ss));
  const nSub = sub * sub;
  const step = 1 / sub;

  const shade = (px: number, py: number, out: number[]): void => {
    const r = Math.hypot(px, py);
    const eo = 1 - smoothstep(Rout - 1.2, Rout + 0.5, r);
    const ei = smoothstep(Rin - 1.0, Rin + 1.0, r);
    const a = clamp(eo * ei, 0, 1);
    if (a <= 0) { out[0] = out[1] = 0; return; }
    const th = Math.atan2(py, px);
    const ct = Math.cos(th), st = Math.sin(th);

    /* the ring is a shallow bevelled band: normal tilts outward */
    const band = clamp((r - Rin) / Math.max(1e-3, Rout - Rin), 0, 1);
    const tilt = tilt0 + tilt1 * band;
    const nx = ct * tilt, ny = st * tilt, nz = Math.sqrt(Math.max(0.02, 1 - tilt * tilt));

    /* teeth */
    const ph = (th * N) / (2 * Math.PI);
    const f = ph - Math.floor(ph);
    const foot = N / (2 * Math.PI * Math.max(r, 0.5));
    /* A SMOOTH ring has no teeth to lose, so it is fully resolved by
       definition. Treating `smooth` as "below Nyquist" instead — which is what
       `sharp = 0` did — pushed it 70% of the way into the dim flat fallback,
       and that is why the tone knobs' chrome band was invisible. */
    const sharp = smooth ? 1 : 1 - smoothstep(0.16, 0.46, foot);
    const side = f < 0.5 ? 1 : -1;
    const u = smooth ? 1 : (f < 0.5 ? f * 2 : (1 - f) * 2);
    const fa = 0.62;
    const rot = smooth ? 0 : sharp;
    let mx = nx * Math.cos(fa) + (-st) * Math.sin(fa) * side * rot;
    let my = ny * Math.cos(fa) + (ct) * Math.sin(fa) * side * rot;
    let mz = nz * Math.cos(fa);
    const mm = Math.hypot(mx, my, mz);
    mx /= mm; my /= mm; mz /= mm;

    const ndl = Math.max(0, mx * L[0] + my * L[1] + mz * L[2]);
    const ao = 0.28 + 0.72 * Math.pow(u, 0.7);

    /* chrome: mostly environment. The teeth sweep the reflection through the
       room, so a tooth is bright when its flank happens to be pointing at the
       ceiling and dark when it is pointing at the desk — which is why real
       knurled chrome has high contrast on the lamp side and goes almost
       uniformly dark opposite it, with no masking needed to make it happen. */
    const ry = 2 * mz * my, rx = 2 * mz * mx;
    const env = envSample(ry, false, true);
    const lampSide = 0.45 + smoothstep(0.9, -0.9, rx) * 0.75;

    /* Directional falloff falls out of the reflection, but a ring this small
       needs it pushed: the teeth opposite the lamp see only desk. */
    const facing = clamp(0.18 + 1.25 * ndl, 0, 1.35);
    let lit = 0.022 + env[1] * 0.34 * polish * ao * lampSide * facing
            + ndl * 0.13 * ao
            + areaSpec(mx, my, mz, 90) * 1.9 * polish * ao;
    /* below Nyquist, fall back to the smooth ring rather than to noise */
    const fry = 2 * nz * ny;
    const flat = 0.028 + envSample(fry, false, true)[1] * 0.30 * polish + 0.05;
    lit = mix(flat, lit, 0.30 + 0.70 * sharp);

    out[0] = lit;
    out[1] = a;
  };

  const one = [0, 0];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) << 2;
      let sumL = 0, sumA = 0;
      for (let sy = 0; sy < sub; sy++) {
        const py = y + (sy + 0.5) * step - cxy;
        for (let sx = 0; sx < sub; sx++) {
          shade(x + (sx + 0.5) * step - cxy, py, one);
          sumL += one[0] * one[1];
          sumA += one[1];
        }
      }
      if (sumA <= 0) { dd[i + 3] = 0; continue; }
      const v = clamp(Math.pow(clamp(sumL / sumA, 0, 3), 1 / 1.85) * 255, 0, 255);
      dd[i] = v; dd[i + 1] = v * 0.995; dd[i + 2] = v * 1.01;
      dd[i + 3] = (sumA / nSub) * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/* ============================================================================
   5b. TURNED DISC — the polished centre cap.

   A spun disc is not a radial starburst and it is not a conic gradient. Its
   surface carries CONCENTRIC micro-grooves, so the normal varies only in the
   radial direction, and the specular therefore smears TANGENTIALLY into two
   opposed bright lobes on the light's axis with dark quadrants between them.
   That two-lobed bow-tie is the signature of turned metal and nothing else
   produces it.

   The grooves have a constant radial period, so their pixel footprint is
   constant too — but at the middle of a small cap that period still falls under
   Nyquist once you factor DPR, so the same analytic fade applies.
   ========================================================================== */

export function discSprite({
  d: diameter, dpr = 1, groovePx = 4.4, rough = 0.34,
  tone = [0.93, 0.935, 0.95], rim = 0.10, dimple = 0.09, seed = 5, ss = 2,
}: DiscOptions): HTMLCanvasElement {
  const S = Math.round(diameter * dpr);
  const c = makeCanvas(S, S);
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(S, S);
  const dd = img.data;
  const cxy = S / 2, R = cxy - 0.5;
  const gp = groovePx * dpr;
  const sub = Math.max(1, Math.round(ss));
  const nSub = sub * sub;
  const step = 1 / sub;
  /* THE GROOVE PERIOD IS CONSTANT IN r. A lathe advances the tool a fixed
     distance per revolution, so the radial pitch does not vary — and the fade
     below can therefore be computed from one number. The previous version
     multiplied the phase by a radius-dependent factor ramping 0.55 → 1.0 over
     the inner half, which made the LOCAL frequency up to 1.45x the nominal
     while the fade went on being computed from the nominal. Grooves 1.9 device
     px apart, rendered as though they were 2.7, is exactly the bullseye that
     sat on the flywheel's centre cap. */
  const sharp = 1 - smoothstep(0.16, 0.46, 1 / gp);

  const shade = (px: number, py: number, out: number[]): void => {
    const r = Math.hypot(px, py);
    const cov = clamp(R + 0.5 - r, 0, 1);
    if (cov <= 0) { out[0] = out[1] = 0; return; }
    const q = clamp(r / R, 0, 1);
    const ct = r > 1e-5 ? px / r : 0, st = r > 1e-5 ? py / r : 0;

    /* concentric grooves tilt the normal radially; the period is constant */
    const gph = r / gp;
    const gf = gph - Math.floor(gph);
    const tilt = Math.sin(gf * Math.PI * 2) * 0.30 * rough * sharp
               * smoothstep(0.0, 0.22, q)
               * (0.7 + hash2(Math.floor(gph), seed) * 0.6);

    /* the rim chamfer, a very slight overall dome, and the turned dimple */
    const cham = smoothstep(1 - rim, 1, q) * 1.5;
    const dish = q * 0.08;
    const dim = (1 - smoothstep(0, dimple, q)) * -1.1;
    const radialTilt = tilt + cham + dish + dim;

    let nx = ct * radialTilt, ny = st * radialTilt, nz = 1;
    const m = Math.hypot(nx, ny, nz);
    nx /= m; ny /= m; nz /= m;

    /* POLISHED METAL IS A MIRROR. Its Fresnel reflectance is ~0.9 at every
       angle, so what you see is the room, weighted by the surface colour —
       not a diffuse term with a highlight on top. Rendering chrome as
       "grey + highlight" is what makes it read as grey plastic. */
    const ndv = clamp(nz, 0, 1);
    const fres = 0.88 + 0.12 * Math.pow(1 - ndv, 4);
    const ry = 2 * ndv * ny, rx = 2 * ndv * nx;
    const env = envSample(ry, false, true);
    /* the room is brighter on the lamp's side, so the reflection is too */
    const side = 0.72 + smoothstep(0.8, -0.9, rx) * 0.55;

    /* 0.46, not 0.34: this cap is the ONLY bright material on the flywheel, and
       the whole point of the part is black knurl against polished metal. At the
       old level the disc and the skirt landed within a few levels of each other
       and the knob read as one flat mid-grey. */
    out[0] = 0.02 + env[1] * fres * side * 0.46
           + areaSpec(nx, ny, nz, 240) * 1.7
           + areaSpec(nx, ny, nz, 14) * 0.09;
    out[1] = cov;
  };

  const one = [0, 0];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) << 2;
      let sumL = 0, sumA = 0;
      for (let sy = 0; sy < sub; sy++) {
        const py = y + (sy + 0.5) * step - cxy;
        for (let sx = 0; sx < sub; sx++) {
          shade(x + (sx + 0.5) * step - cxy, py, one);
          sumL += one[0] * one[1];
          sumA += one[1];
        }
      }
      if (sumA <= 0) { dd[i + 3] = 0; continue; }
      /* a fine sparkle in the polish, at pixel scale so it does not average out */
      const lit = sumL / sumA + (hash2(x + 3, y + seed) - 0.5) * 0.035;
      for (let ch = 0; ch < 3; ch++) {
        dd[i + ch] = clamp(Math.pow(clamp(lit * tone[ch], 0, 3), 1 / 1.9) * 255, 0, 255);
      }
      dd[i + 3] = (sumA / nSub) * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/* ============================================================================
   6. WEAR — distributed by where hands and desks actually touch.

   A uniform noise layer at `opacity: .3` is not wear, it is dirt-coloured fog.
   Wear on a twenty-year-old case is: corners rubbed brighter and smoother
   (grain polished out), an arc of scuffing around every knob where the thumb
   sweeps, grime accumulating in the seam against the black panel and in the
   lower corners where a cloth never reaches, and a handful of hard scratches
   at angles that do not match the grain.

   Rendered at half resolution — every feature here is low frequency except the
   scratches, which are drawn at full resolution on top.
   ========================================================================== */

export function wearMap({ w, h, dpr = 1, seed = 29, controls = [], strength = 1, edges = [] }: WearOptions): HTMLCanvasElement {
  const sc = 0.5;
  const W = Math.max(2, Math.round(w * dpr * sc)), Hh = Math.max(2, Math.round(h * dpr * sc));
  const c = makeCanvas(W, Hh);
  const ctx = c.getContext('2d')!;
  const rand = rng(seed);

  ctx.fillStyle = 'rgba(128,128,128,1)';   // neutral for overlay blending
  ctx.fillRect(0, 0, W, Hh);

  const px = (v: number): number => v * dpr * sc;

  /* --- rub-through at the corners and along the leading edges ------------ */
  const rub = (x: number, y: number, r: number, a: number): void => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(224,214,190,${a * strength})`);
    g.addColorStop(0.55, `rgba(196,188,168,${a * 0.42 * strength})`);
    g.addColorStop(1, 'rgba(160,160,160,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  };
  rub(0, 0, Math.min(W, Hh) * 0.55, 0.13);
  rub(W, 0, Math.min(W, Hh) * 0.42, 0.085);
  rub(0, Hh, Math.min(W, Hh) * 0.48, 0.10);
  rub(W, Hh, Math.min(W, Hh) * 0.60, 0.13);

  /* --- grime, weighted to the edges and the bottom ------------------------ */
  for (let i = 0; i < 26; i++) {
    const edge = rand();
    let x, y;
    if (edge < 0.5) { x = rand() * W; y = rand() < 0.62 ? Hh * (0.86 + rand() * 0.18) : Hh * rand() * 0.16; }
    else { x = rand() < 0.5 ? W * rand() * 0.14 : W * (0.88 + rand() * 0.16); y = rand() * Hh; }
    const r = (0.06 + rand() * 0.16) * Math.min(W, Hh) * 1.9;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const a = 0.022 + rand() * 0.045;
    g.addColorStop(0, `rgba(74,70,62,${a * strength})`);
    g.addColorStop(1, 'rgba(128,128,128,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  /* --- thumb sweep around each control ----------------------------------- */
  ctx.save();
  for (const k of controls) {
    const x = px(k.x), y = px(k.y), r = px(k.r);
    /* polished annulus just outside the knob */
    const g = ctx.createRadialGradient(x, y, r * 0.95, x, y, r * 1.9);
    g.addColorStop(0, `rgba(212,203,182,${0.10 * strength})`);
    g.addColorStop(0.35, `rgba(196,188,168,${0.055 * strength})`);
    g.addColorStop(1, 'rgba(128,128,128,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r * 1.9, 0, Math.PI * 2); ctx.fill();

    /* the sweep itself: a right hand comes in from the lower right */
    ctx.lineCap = 'round';
    for (let s = 0; s < 5; s++) {
      const rr = r * (1.02 + rand() * 0.55);
      ctx.beginPath();
      ctx.arc(x, y, rr, -0.5 + rand() * 0.5, 2.1 + rand() * 0.8);
      ctx.strokeStyle = `rgba(232,224,203,${(0.022 + rand() * 0.034) * strength})`;
      ctx.lineWidth = (0.5 + rand() * 1.3) * dpr * sc;
      ctx.stroke();
    }
  }
  ctx.restore();

  /* --- the arris: where the front face wraps to the cheek ------------------
     This is the single most worn line on a real case. Twenty years of being
     picked up, set down, and pushed against things rubs the anodising off the
     edge itself, so the arris is BRIGHTER and SMOOTHER than the faces either
     side of it, with hard dings breaking it at irregular intervals and grime
     collecting in the shallow just inboard of it. Distributing wear evenly over
     a surface never produces this; you have to know where the edge is. */
  for (const side of edges) {
    const vertical = side === 'left' || side === 'right';
    const at = side === 'left' || side === 'top' ? 0 : (vertical ? W : Hh);
    const len = vertical ? Hh : W;
    /* AN ARRIS IS A PHYSICAL WIDTH, not a fraction of the face.
       `extent * 0.42` is right on a 108 px cheek (45 px of rubbed edge) and
       nonsense on the 1918 px front, where it spread the same rub-through over
       806 px — a wash across half the panel that reads as nothing at all,
       which is why the front had no worn edge while the cheeks did. Cap it at
       roughly 26 CSS px of real edge. */
    const band = clamp((vertical ? W : Hh) * 0.42, 2, 26 * dpr * sc);
    const g = vertical
      ? ctx.createLinearGradient(at, 0, at + (side === 'left' ? band : -band), 0)
      : ctx.createLinearGradient(0, at, 0, at + (side === 'top' ? band : -band));
    g.addColorStop(0, `rgba(240,233,214,${0.42 * strength})`);
    g.addColorStop(0.22, `rgba(214,206,186,${0.16 * strength})`);
    g.addColorStop(0.6, `rgba(96,90,80,${0.10 * strength})`);   // grime in the shallow
    g.addColorStop(1, 'rgba(128,128,128,0)');
    ctx.fillStyle = g;
    ctx.fillRect(vertical ? Math.min(at, at + (side === 'left' ? band : -band)) : 0,
                 vertical ? 0 : Math.min(at, at + (side === 'top' ? band : -band)),
                 vertical ? band : W, vertical ? Hh : band);

    /* dings: the edge is not worn evenly, it is worn where it got hit */
    for (let i = 0; i < Math.round(len / (18 * dpr * sc)); i++) {
      const t = rand() * len;
      const d0 = (0.6 + rand() * 3.4) * dpr * sc;
      const x = vertical ? at + (side === 'left' ? 1 : -1) * rand() * band * 0.30 : t;
      const y = vertical ? t : at + (side === 'top' ? 1 : -1) * rand() * band * 0.30;
      const bright = rand() < 0.62;
      const gg = ctx.createRadialGradient(x, y, 0, x, y, d0 * 2.2);
      gg.addColorStop(0, bright ? `rgba(252,247,232,${(0.3 + rand() * 0.4) * strength})`
                                : `rgba(46,42,36,${(0.22 + rand() * 0.3) * strength})`);
      gg.addColorStop(1, 'rgba(128,128,128,0)');
      ctx.fillStyle = gg;
      ctx.fillRect(x - d0 * 2.2, y - d0 * 2.2, d0 * 4.4, d0 * 4.4);
    }
  }

  /* --- hard scratches, at angles the grain does not have ------------------ */
  ctx.lineCap = 'round';
  for (let i = 0; i < 34; i++) {
    /* concentrated toward edges and controls */
    let x, y;
    if (controls.length && rand() < 0.45) {
      const k = controls[(rand() * controls.length) | 0];
      const a = rand() * Math.PI * 2, rr = px(k.r) * (1 + rand() * 1.4);
      x = px(k.x) + Math.cos(a) * rr; y = px(k.y) + Math.sin(a) * rr;
    } else {
      x = rand() * W; y = rand() < 0.5 ? Hh * rand() * 0.2 : Hh * (0.8 + rand() * 0.2);
    }
    const ang = (rand() - 0.5) * 0.9 + (rand() < 0.3 ? Math.PI / 2 : 0);
    const len = (3 + rand() * 26) * dpr * sc;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    ctx.strokeStyle = rand() < 0.7
      ? `rgba(246,240,222,${(0.07 + rand() * 0.20) * strength})`
      : `rgba(48,45,40,${(0.06 + rand() * 0.14) * strength})`;
    ctx.lineWidth = (0.5 + rand() * 0.9) * dpr * sc;
    ctx.stroke();
  }

  return c;
}

/* ============================================================================
   7. GLASS — two speculars, not one.

   The tell for a real pane is that you see TWO reflections of the same source,
   from the front and back surfaces, offset by the glass thickness. It costs one
   extra gradient and it is the cheapest realism in this whole file. Plus edge
   tint (path length again), a bezel shadow thrown onto the printed face BEHIND
   the glass and therefore parallax-offset from the bezel, and a few dust motes.
   ========================================================================== */

export function glassDust({ w, h, dpr = 1, seed = 41, n = 0 }: DustOptions): HTMLCanvasElement {
  const W = Math.round(w * dpr), Hh = Math.round(h * dpr);
  const c = makeCanvas(W, Hh);
  const ctx = c.getContext('2d')!;
  const rand = rng(seed);
  const count = n || Math.max(6, Math.round((w * h) / 2600));
  for (let i = 0; i < count; i++) {
    const x = rand() * W, y = rand() * Hh;
    const r = (0.35 + Math.pow(rand(), 2.4) * 1.5) * dpr;
    const a = 0.10 + rand() * 0.34;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r * 2.4);
    g.addColorStop(0, `rgba(255,252,244,${a})`);
    g.addColorStop(0.4, `rgba(255,250,238,${a * 0.35})`);
    g.addColorStop(1, 'rgba(255,250,238,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r * 2.4, 0, Math.PI * 2); ctx.fill();
    /* every mote has a shadow on the face below it — that is what puts it ON
       the glass rather than IN the image */
    ctx.fillStyle = `rgba(0,0,0,${a * 0.30})`;
    ctx.beginPath(); ctx.arc(x + r * 0.9, y + r * 1.1, r * 0.9, 0, Math.PI * 2); ctx.fill();
  }
  return c;
}

/* ============================================================================
   8. THE CABINET AS A BOX — faces, not a background.

   With the chassis filling the window at any ratio, the excess is not margin;
   it is more of the object. A radio is a box, so the honest way to fill a wide
   window is to reveal the side cheeks, and a tall one is to reveal the top
   return and the bottom plinth. Each of those is a real plane with a real
   normal, and once you say that out loud, Law 5 does the work for you:

       base luminance of a face = ambient + kd * max(0, N . L)

   Five multipliers derived from one light vector. The left cheek faces the lamp
   and is BRIGHTER than the front. The right cheek turns away and is darker. The
   top return is brightest of all, the bottom plinth darkest. Nothing has to be
   hand-tuned and nothing can disagree.

   The second half of it is foreshortening. A cheek seen at a grazing angle
   compresses along its depth axis, so the brushed grain must compress with it —
   same tile, different `background-size`. Grain that stays square on a
   foreshortened face is the thing that makes box renders look like decals.
   ========================================================================== */

/** Normals of the visible faces of the case, in the shader's screen space. */
export const FACES: Record<string, RGB> = {
  front: [0, 0, 1],
  left: [-0.94, 0, 0.34],     // the cheek, wrapping toward the viewer
  right: [0.94, 0, 0.34],
  top: [0, -0.94, 0.34],
  bottom: [0, 0.94, 0.34],
  bevelTL: [-0.55, -0.55, 0.63],
};

/** Lambert term for a face, normalised so `front` reads 1.0. */
export function faceLight(name: string, ambient = 0.34): number {
  const n = FACES[name] || FACES.front;
  const nl = Math.max(0, n[0] * L[0] + n[1] * L[1] + n[2] * L[2]);
  const f = ambient + (1 - ambient) * nl;
  const fFront = ambient + (1 - ambient) * Math.max(0, L[2]);
  return f / fFront;
}

/* ----------------------------------------------------------------------------
   9. CARRY HANDLE / BRACKET — moulded satin plastic, not metal.

   The reference's side brackets are a different material from the shell and
   they must not be shaded like it: plastic has a broad low-exponent specular
   with a soft edge, no anisotropy, and a slight sheen that survives into the
   shadow because the material scatters.

   WHAT THIS DRAWS, and why it is not a pill.

   Seen from the front, a fold-out side handle is not a bar: it is a strap on
   hardware. Top and bottom it has a mounting FOOT bolted flat to the cheek; just
   inboard of each foot is the PIVOT KNUCKLE the strap folds about; between them
   is the GRIP, narrower than the feet and ribbed across the hand span. Drawing
   only the middle third of that — a rounded rectangle with a vertical ramp on
   it — is what makes the part read as a painted-on pill with nothing holding it.

   HOW THE SILHOUETTE IS BUILT. Every one of those pieces is a rounded rectangle
   and the part is their union, so the whole outline is one signed distance
   field: `min()` of five `rrect()`s. That buys three things at once —

     * coverage from the distance itself, `clamp(0.5 - d, 0, 1)`, which is real
       analytic antialiasing on EVERY edge. The previous version computed
       coverage across the short axis only, so the two ends were hard square
       cuts relying on a CSS `border-radius` to clip them round — and a clip
       against an unantialiased canvas edge is exactly the stair-stepping a
       critic sees on the corners.
     * the surface normal from the gradient of the same field, so the roll-off
       at a corner curves in both axes instead of only across the bar.
     * crisp corners, because a distance field has no polygon to step down.
   -------------------------------------------------------------------------- */

/** A rounded-rectangle signed distance: negative inside, in pixels. */
function rrect(
  px: number, py: number,
  cx: number, cy: number,
  hx: number, hy: number,
  r: number,
): number {
  const rr = Math.min(r, Math.min(hx, hy));
  const qx = Math.abs(px - cx) - (hx - rr);
  const qy = Math.abs(py - cy) - (hy - rr);
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - rr;
}

export function barSprite({
  w, h, dpr = 1, axis = 'v',       // 'v' = the bar runs vertically
  radius = 0.5,                     // 0.5 = fully rounded cross-section
  tone = [0.072, 0.074, 0.080],
  shine = 16, gloss = 0.30, seed = 17,
  scuff = 1,
  bracket = false,                  // draw feet, knuckles and a ribbed grip
  footPx = 24,                      // foot pad length, CSS px — see faceplate.css
  ribPx = 4.2,                      // grip rib pitch, CSS px
}: BarOptions): HTMLCanvasElement {
  const W = Math.round(w * dpr), Hh = Math.round(h * dpr);
  const c = makeCanvas(W, Hh);
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(W, Hh);
  const dd = img.data;
  const vertical = axis === 'v';

  /* --- the silhouette ---------------------------------------------------- */

  /* Along-axis and across-axis extents, so the same field serves both
     orientations without a second copy of the arithmetic. */
  const along = vertical ? Hh : W;                    // length
  const across = vertical ? W : Hh;                   // width
  const halfA = across / 2;

  const foot = Math.min(along * 0.4, Math.max(8 * dpr, footPx * dpr));
  const gripHalf = halfA * 0.72;
  const knuckleHalf = halfA * 0.95;
  const knuckleLen = Math.max(2.4 * dpr, across * 0.36);
  const kA = foot + knuckleLen * 0.55;                // knuckle centre, from the top
  const kB = along - kA;
  /* The bar's own cross-section radius, from the caller's `radius`. */
  const bev = Math.max(0.8, gripHalf * Math.min(1, radius * 2));

  /** distance field in (alongCoord, acrossCoord) space */
  const shape = (a: number, x: number): number => {
    if (!bracket) {
      /* a plain bar: one rounded rect, but now with real ends */
      return rrect(x, a, halfA, along / 2, halfA, along / 2, halfA * Math.min(1, radius * 2));
    }
    let d = rrect(x, a, halfA, foot / 2, halfA, foot / 2, Math.min(3 * dpr, halfA * 0.5));
    d = Math.min(d, rrect(x, a, halfA, along - foot / 2, halfA, foot / 2, Math.min(3 * dpr, halfA * 0.5)));
    d = Math.min(d, rrect(x, a, halfA, along / 2, gripHalf, along / 2 - 0.5, gripHalf * 0.9));
    d = Math.min(d, rrect(x, a, halfA, kA, knuckleHalf, knuckleLen / 2, knuckleLen * 0.42));
    d = Math.min(d, rrect(x, a, halfA, kB, knuckleHalf, knuckleLen / 2, knuckleLen * 0.42));
    return d;
  };

  /* Ribs stop resolving once their pitch approaches a device pixel; fade them
     into the flat grip rather than letting them alias into noise. */
  const rp = Math.max(1.6, ribPx * dpr);
  const ribAmp = 0.44 * (1 - smoothstep(3.2, 1.8, rp));
  const gripFrom = kA + knuckleLen * 0.5;
  const gripTo = kB - knuckleLen * 0.5;

  for (let y = 0; y < Hh; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) << 2;
      const px = x + 0.5, py = y + 0.5;
      const a = vertical ? py : px;                   // along the bar
      const s = vertical ? px : py;                   // across the bar

      const d = shape(a, s);
      const cov = clamp(0.5 - d, 0, 1);
      if (cov <= 0) { dd[i + 3] = 0; continue; }

      /* Normal from the field's own gradient: at a corner it turns in both
         axes, which is what a moulded radius does and what a one-axis ramp
         cannot do. */
      const ga = shape(a + 1, s) - shape(a - 1, s);
      const gs = shape(a, s + 1) - shape(a, s - 1);
      const gm = Math.hypot(ga, gs) || 1;
      const roll = 1 - clamp(-d / bev, 0, 1);         // 1 at the edge, 0 inside
      const tilt = 0.98 * Math.pow(roll, 0.55);

      let nx = (vertical ? gs : ga) / gm * tilt;
      let ny = (vertical ? ga : gs) / gm * tilt;

      /* the grip's ribs: a cosine ridge across the hand span. Light is upper
         left, so the flank ABOVE each crest is the one that lights up. */
      if (bracket && ribAmp > 0.001) {
        const inGrip = smoothstep(gripFrom, gripFrom + 2 * dpr, a) * (1 - smoothstep(gripTo - 2 * dpr, gripTo, a));
        if (inGrip > 0.002) {
          const ridge = Math.sin((2 * Math.PI * (a - gripFrom)) / rp) * ribAmp * inGrip * (1 - roll * 0.45);
          if (vertical) ny += ridge; else nx += ridge;
        }
      }

      /* moulded surface: fine tooth plus long flow marks along the bar */
      const flow = (hash2(Math.round(a / 3), 0) - 0.5) * 0.05;
      const tooth = (hash2(x * 2 + seed, y * 3) - 0.5) * 0.09;
      nx += tooth * 0.4; ny += tooth * 0.4;

      const nzr = Math.sqrt(Math.max(0.02, 1 - Math.min(0.97, nx * nx + ny * ny)));
      const m = Math.hypot(nx, ny, nzr) || 1;
      const Nx = nx / m, Ny = ny / m, Nz = nzr / m;
      const ndl = Math.max(0, Nx * L[0] + Ny * L[1] + Nz * L[2]);
      const ndv = clamp(Nz, 0, 1);
      const fres = 0.04 + 0.96 * Math.pow(1 - ndv, 5);
      const ry = 2 * ndv * Ny;
      const env = envSample(ry, true, false);

      /* Ambient occlusion where the strap meets its own hardware: the gap
         between the grip and the knuckle is a crease and takes less sky. */
      let ao = 1;
      if (bracket) {
        const seam = Math.min(Math.abs(a - kA), Math.abs(a - kB));
        ao = 0.62 + 0.38 * smoothstep(0, knuckleLen * 0.9, seam);
        /* the counterbore each fastener is let into */
        const bore = Math.min(Math.hypot(s - halfA, a - foot * 0.5), Math.hypot(s - halfA, a - (along - foot * 0.5)));
        ao *= 0.55 + 0.45 * smoothstep(halfA * 0.34, halfA * 0.66, bore);
      }

      const out = [0, 0, 0];
      for (let ch = 0; ch < 3; ch++) {
        const base = tone[ch] * (0.42 + 0.58 * (1 + flow));
        out[ch] =
          base * (0.16 + 0.78 * ndl) * ao +
          env[ch] * fres * 0.085 * ao +
          areaSpec(Nx, Ny, Nz, shine) * gloss * (0.9 + 0.1 * ch) +
          0.006;
      }
      /* scuffs: the handle is what people grab */
      if (scuff) {
        const t = hash2(Math.round(x / 1.6) + 91, Math.round(y / 1.6) + seed);
        if (t > 0.9955) { out[0] += 0.16; out[1] += 0.155; out[2] += 0.15; }
      }
      dd[i] = clamp(Math.pow(clamp(out[0], 0, 3), 1 / 1.9) * 255, 0, 255);
      dd[i + 1] = clamp(Math.pow(clamp(out[1], 0, 3), 1 / 1.9) * 255, 0, 255);
      dd[i + 2] = clamp(Math.pow(clamp(out[2], 0, 3), 1 / 1.9) * 255, 0, 255);
      dd[i + 3] = 255 * cov;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** A pan-head fastener. Small, but the thing that says "assembled". */
export function screwSprite({ d: diameter, dpr = 1, slot = 'phillips', angle = 0.35 }: ScrewOptions): HTMLCanvasElement {
  const S = Math.round(diameter * dpr);
  const c = makeCanvas(S, S);
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(S, S);
  const dd = img.data;
  const cxy = S / 2, R = cxy - 0.5;
  const ca = Math.cos(angle), sa = Math.sin(angle);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) << 2;
      const px = x + 0.5 - cxy, py = y + 0.5 - cxy;
      const r = Math.hypot(px, py);
      if (r > R + 1) { dd[i + 3] = 0; continue; }
      const q = clamp(r / R, 0, 1);
      /* shallow pan head */
      const nz = Math.sqrt(Math.max(0.02, 1 - q * q * 0.62));
      let nx = (px / R) * 0.62, ny = (py / R) * 0.62;
      /* the slot: rotate into the driver's frame */
      const rx = px * ca + py * sa, ry2 = -px * sa + py * ca;
      const inSlot = (Math.abs(ry2) < R * 0.14 && Math.abs(rx) < R * 0.66) ||
        (slot === 'phillips' && Math.abs(rx) < R * 0.14 && Math.abs(ry2) < R * 0.66);
      let m = Math.hypot(nx, ny, nz);
      let Nx = nx / m, Ny = ny / m, Nz = nz / m;
      let ndl = Math.max(0, Nx * L[0] + Ny * L[1] + Nz * L[2]);
      const ndh = Math.max(0, Nx * H[0] + Ny * H[1] + Nz * H[2]);
      let v = 0.10 + ndl * 0.42 + Math.pow(ndh, 26) * 0.55;
      if (inSlot) v *= 0.18;
      /* the seat: a dark ring where the head meets the panel */
      v = mix(v, 0.03, smoothstep(R - 1.4, R + 0.3, r));
      const cov = clamp(R + 0.5 - r, 0, 1);
      const o = clamp(Math.pow(clamp(v, 0, 2), 1 / 1.9) * 255, 0, 255);
      dd[i] = o * 1.0; dd[i + 1] = o * 0.99; dd[i + 2] = o * 0.96;
      dd[i + 3] = cov * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/* ------------------------------------------------------------------- mount */

/* toDataURL() base64-encodes a PNG, which on a 1024x512 tile costs more than
   generating the tile did. Blob + object URL skips the base64 and lets the
   decoder run off-thread. Async, but everything here is startup work. */
export function toURL(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL('image/png');
}

export function toObjectURL(canvas: HTMLCanvasElement): Promise<string> {
  return new Promise<string>((res, rej) => {
    canvas.toBlob((b) => (b ? res(URL.createObjectURL(b)) : rej(new Error('toBlob produced nothing'))), 'image/png');
  });
}

/* ----------------------------------------------------------------------------
   KNURL PHASE SHEET.

   All the rotation phases in ONE canvas, laid out horizontally. Turning the
   knob then costs a single drawImage of a d x d region — call it 0.05 ms at
   150 px — instead of re-rendering the shader or decoding a new image. And
   because an N-tooth knurl is N-fold symmetric, `phases` sprites over one tooth
   period cover the control's whole travel exactly.
   -------------------------------------------------------------------------- */

export function knurlSheet({ d, dpr = 1, phases = 4, ...opts }: KnurlOptions & { phases?: number }): KnurlSheet {
  const S = Math.round(d * dpr);
  const sheetC = makeCanvas(S * phases, S);
  const ctx = sheetC.getContext('2d')!;
  /* Must agree with `knurlSprite` exactly: this number is what `paintKnurl`
     divides the knob's rotation by, so a mismatch makes the phases jump. */
  const N = opts.teeth || knurlTeeth(S, opts.r0 ?? 0.54, opts.pitchPx ?? 6.4);
  for (let i = 0; i < phases; i++) {
    const one = knurlSprite({ d, dpr, phase: (i / phases) * ((2 * Math.PI) / N), ...opts });
    ctx.drawImage(one, i * S, 0);
  }
  const sheet = sheetC as KnurlSheet;
  sheet.teeth = N;
  sheet.phases = phases;
  sheet.cell = S;
  return sheet;
}
