/**
 * The MW/SW drum dial.
 *
 * The scale is printed on a cylinder standing on a vertical axis, seen through a
 * glass window from slightly above. Four things make it read as a drum rather
 * than a scrolling strip:
 *
 *  1. NON-LINEAR SWEEP. Screen x is sin(theta), so ticks bunch up towards both
 *     edges as the surface turns away. A flat strip has constant spacing; a
 *     cylinder never does.
 *  2. FORESHORTENING. Everything is horizontally squeezed by cos(theta) —
 *     numerals compress into the edges instead of just fading out.
 *  3. FIXED LIGHTING. The shading gradient does NOT move with the scale. The
 *     hot band sits where the lamp hits the barrel and stays there while the
 *     print slides underneath. This is the single strongest cue.
 *  4. A REAL PROJECTION, not a warp filter. A point on a vertical-axis cylinder
 *     at drum angle t, height q, seen orthographically by a camera pitched down
 *     by phi, lands at
 *
 *         x = R sin t
 *         y = -q cos phi + R sin phi cos t
 *
 *     so a printed row bows by R sin(phi) (cos t - 1): flat across the useful
 *     centre, curling hard in the last few degrees. Differentiating that gives
 *     the glyph transform — a horizontal squeeze cos(t) plus a VERTICAL SHEAR
 *     -sin(phi) sin(t). It is not a rotation. Printed vertical strokes stay
 *     plumb at every angle and only the baseline tilts; rotating the glyphs
 *     tips the stems, which is the classic tell of a bitmap with a transform on
 *     it.
 *
 * Density is a law, not a taste — see ui/density.ts. Graduation pitch is a
 * constant in pixels, the interval steps down the 1/2/5 ladder as the window
 * grows, and type stops growing at 1400 px. A bigger window prints MORE, never
 * BIGGER.
 *
 * Static layers (backlit ground, barrel shading, the bowed lips where the drum
 * rolls under the bezel) are cached in offscreen canvases and blitted; only the
 * printed vector content — the ticks and a handful of glyphs — is redrawn per
 * frame.
 */

import type { Band, DialSlot } from '../../../shared/contracts';
import { clamp, el } from '../dom';
import { displayStationName, dialStationName } from '../stationName';
import {
  ANG_MAX,
  SIN_MAX,
  COS_MAX,
  DRUM_W_MIN,
  DRUM_W_INSTRUMENT,
  drumPlan,
  formatValue,
  type DrumPlan,
} from '../density';

/** Where the lamp lands on the barrel, in drum degrees. Upper left. */
const LIGHT_ANG = (-27 * Math.PI) / 180;

/**
 * How hard the fixed barrel lamp hits the screen-x fraction `u` (0..1), 1 at
 * the hot band and falling away either side.
 *
 * This is `paintGround`'s shading band read analytically. Anything PRINTED on
 * the barrel has to be lit by the lamp that lights the paper it is printed on,
 * and that lamp does not travel with the print — so a chip's brightness is a
 * function of where it currently stands on the screen, never of which station
 * it is. Asymmetric, because past the hot band the surface keeps turning away
 * while before it the surface is still rolling into view.
 */
function barrelLight(u: number): number {
  const xl = (Math.sin(LIGHT_ANG) / SIN_MAX + 1) / 2;
  const k = (u - xl) / (u < xl ? 0.45 : 0.72);
  return Math.exp(-1.6 * k * k);
}

/**
 * The blip's pigment: a chip of amber lacquer printed on the barrel, in three
 * levels — the facet that faces the lamp, the body, and the return that faces
 * away from it. A level, never an alpha: ink leaving the lamp's band gets
 * DARKER, it does not become transparent.
 */
type Ink = readonly [number, number, number];
const BLIP_LIT: Ink = [255, 219, 138];
const BLIP_BODY: Ink = [246, 164, 46];
const BLIP_DEEP: Ink = [174, 102, 18];
const ACTIVE_LIT: Ink = [255, 234, 172];
const ACTIVE_BODY: Ink = [255, 188, 70];
const ACTIVE_DEEP: Ink = [196, 116, 20];

const shade = (c: Ink, k: number): string =>
  `rgb(${Math.round(c[0] * k)},${Math.round(c[1] * k)},${Math.round(c[2] * k)})`;

/** The instrument's numeral cut: heavier, condensed, near-zero tracking. */
const FONT_NUM = "'Liberation Sans Narrow','Nimbus Sans Narrow','Arial Narrow',sans-serif";
/** Printed labels: same family, lighter weight, wide track. */
const FONT_LABEL = "'Liberation Sans Narrow','Nimbus Sans Narrow','Arial Narrow',sans-serif";

export interface DrumDialHandle {
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  setBand(band: Band): void;
  setPosition(position: number): void;
  setLamp(on: boolean): void;
  setPowered(on: boolean): void;
  setActiveStation(id: string | undefined): void;
  /** The live print plan, for evidence and tests. Null before the first paint. */
  readonly plan: DrumPlan | null;
  /** Repaint on the next frame. Safe to call many times per frame. */
  invalidate(): void;
  destroy(): void;
}

export function createDrumDial(opts: {
  onScrubStart(): void;
  onScrub(deltaPosition: number, fine: boolean): void;
  onScrubEnd(): void;
  onPickStation(id: string): void;
}): DrumDialHandle {
  const canvas = el('canvas', { class: 'drum__canvas', 'aria-hidden': 'true' });
  const ctx = canvas.getContext('2d')!;
  /** A throwaway context purely for text metrics — never painted. */
  const measureCtx = document.createElement('canvas').getContext('2d')!;

  const cursor = el('div', { class: 'drum__cursor' }, [
    el('div', { class: 'drum__cursor-rail drum__cursor-rail--l' }),
    el('div', { class: 'drum__cursor-rail drum__cursor-rail--r' }),
    el('div', { class: 'drum__pointer' }),
  ]);

  const unit = el('div', { class: 'drum__unit silk silk--xs' }, ['kHz']);

  const root = el('div', { class: 'drum recess' }, [
    canvas,
    el('div', { class: 'drum__glass mat-glass' }),
    cursor,
    unit,
  ]);

  let band: Band = { genre: '', stationCount: 0, slots: [], scaleMin: 0, scaleMax: 1, scaleUnit: 'kHz' };
  let position = 0.5;
  let lampOn = true;
  let powered = false;
  let activeId: string | undefined;

  let w = 0;
  let h = 0;
  let dpr = 1;
  let raf = 0;

  let bg: HTMLCanvasElement | null = null;
  let fg: HTMLCanvasElement | null = null;
  let cacheKey = '';
  let plan: DrumPlan | null = null;
  let planKey = '';

  // -------------------------------------------------------------------------
  // Scale arithmetic

  /**
   * What the tuning model wants under the glass: about five or six stations,
   * with a physically larger window showing a little more of the drum, exactly
   * as a larger window on a real set does. The density law may widen this
   * further when the scale's resolution floor would otherwise leave the print
   * sparse — see drumPlan step 1. Either way the scrub stays 1:1 with the hand,
   * because it converts pixels through this same fraction.
   */
  function stationVisibleFraction(): number {
    const n = Math.max(band.slots.length, 1);
    const stations = clamp(5.5 / n, 0.075, 0.24);
    return clamp(stations * clamp(w / 620, 0.82, 1.45), 0.05, 0.42);
  }

  /** The finest unit this scale may honestly claim. */
  function resolutionOf(): number {
    return band.scaleUnit === 'MHz' ? 0.01 : 1;
  }

  function rebuildPlan(): DrumPlan {
    const range = Math.abs(band.scaleMax - band.scaleMin) || 1;
    const key = `${w}|${h}|${range}|${band.slots.length}|${band.scaleUnit}`;
    if (plan && key === planKey) return plan;
    planKey = key;
    plan = drumPlan({
      w,
      h,
      range,
      resolution: resolutionOf(),
      vf: stationVisibleFraction(),
      sample: Math.max(Math.abs(band.scaleMin), Math.abs(band.scaleMax)),
      labelWidthOf: (text, px) => {
        measureCtx.font = `600 ${px}px ${FONT_NUM}`;
        // The numerals are printed at a 0.9 horizontal squeeze, so their
        // measured width has to be squeezed too or the collision test is wrong.
        return measureCtx.measureText(text).width * 0.9;
      },
    });
    return plan;
  }

  /** Visible fraction of the band, for scrubbing and hit-testing. */
  function visibleFraction(): number {
    if (w <= 0) return stationVisibleFraction();
    return rebuildPlan().visible;
  }

  function radPerUnit(): number {
    return (2 * ANG_MAX) / visibleFraction();
  }

  // -------------------------------------------------------------------------
  // Projection

  function thetaOf(p: number): number {
    return (p - position) * radPerUnit();
  }

  /** Bow amplitude, px: how far the rim rides above the centre of a row. */
  function bowOf(): number {
    return Math.min(h * 0.2, w * 0.03);
  }

  /** The print block and both rims share this offset, so nothing escapes the
   *  window as the rows swing up at the rim. Half the bow centres the swing. */
  function shiftOf(): number {
    return bowOf() * 0.5;
  }

  /** sin(phi) implied by that bow — the camera's downward pitch. */
  function sinPhi(): number {
    const R = w / 2 / SIN_MAX;
    return bowOf() / (R * (1 - COS_MAX));
  }

  interface Placed {
    x: number;
    y: number;
    sx: number;
    shear: number;
  }

  /** The surface-to-screen transform at drum angle `t`, as a canvas matrix. */
  function place(t: number): Placed {
    const x = w / 2 + (Math.sin(t) / SIN_MAX) * (w / 2);
    const y = -bowOf() * ((1 - Math.cos(t)) / (1 - COS_MAX));
    return { x, y, sx: Math.cos(t), shear: -sinPhi() * Math.sin(t) };
  }

  function setSurface(c: CanvasRenderingContext2D, t: number): Placed {
    const p = place(t);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.transform(p.sx, p.shear, 0, 1, p.x, p.y);
    return p;
  }

  /** The y a bowed row reaches at screen x — used by the rims and the rule. */
  function curveAt(x: number): number {
    const u = (x / w) * 2 - 1;
    const t = Math.asin(clamp(u * SIN_MAX, -1, 1));
    return -bowOf() * ((1 - Math.cos(t)) / (1 - COS_MAX));
  }

  // -------------------------------------------------------------------------
  // Static layers

  function buildCaches(): void {
    const key = `${w}x${h}x${dpr}x${lampOn ? 1 : 0}x${powered ? 1 : 0}`;
    if (key === cacheKey && bg && fg) return;
    cacheKey = key;
    if (w <= 0 || h <= 0) return;

    bg = document.createElement('canvas');
    bg.width = Math.round(w * dpr);
    bg.height = Math.round(h * dpr);
    const b = bg.getContext('2d')!;
    b.scale(dpr, dpr);
    paintGround(b);

    fg = document.createElement('canvas');
    fg.width = Math.round(w * dpr);
    fg.height = Math.round(h * dpr);
    const f = fg.getContext('2d')!;
    f.scale(dpr, dpr);
    paintLips(f);
  }

  /** How many dial lamps sit behind the window.
   *
   *  A dial lamp is a bulb with a fixed falloff in millimetres, so a wider
   *  window does not get a wider bulb — it gets ANOTHER BULB. Real wide dials
   *  are lit by two or three lamps on a rail, which is why they show a gentle
   *  scallop across the scale rather than one hot end and one dark one. Same
   *  law as the graduations: more of them, not bigger ones. */
  function lampCount(): number {
    return Math.max(1, Math.round(w / 470));
  }

  /** Backlit drum face + the barrel's fixed shading. */
  function paintGround(c: CanvasRenderingContext2D): void {
    const lit = lampOn && powered;
    const n = lampCount();

    // Dead ground: what the window looks like where no lamp reaches it.
    c.fillStyle = lit ? '#7a6238' : '#221f19';
    c.fillRect(0, 0, w, h);

    // Then each bulb over it, at its own fixed falloff radius. Composited with
    // alpha rather than additively: two overlapping warm bulbs lay down the
    // same warm colour twice, they do not saturate the paper into olive.
    const reach = 780;
    for (let i = 0; i < n; i++) {
      const cx = (w * (i + 0.5)) / n;
      const lamp = c.createRadialGradient(cx - 14, -h * 0.28, h * 0.08, cx, h * 0.08, reach);
      if (lit) {
        lamp.addColorStop(0, 'rgba(255,233,194,1)');
        lamp.addColorStop(0.2, 'rgba(243,214,161,0.94)');
        lamp.addColorStop(0.45, 'rgba(206,175,122,0.7)');
        lamp.addColorStop(0.72, 'rgba(150,124,79,0.34)');
        lamp.addColorStop(1, 'rgba(96,79,49,0)');
      } else {
        lamp.addColorStop(0, 'rgba(90,83,70,0.85)');
        lamp.addColorStop(0.35, 'rgba(64,59,49,0.55)');
        lamp.addColorStop(0.75, 'rgba(40,37,31,0.22)');
        lamp.addColorStop(1, 'rgba(30,27,22,0)');
      }
      c.fillStyle = lamp;
      c.fillRect(0, 0, w, h);
    }

    // Barrel shading. Hot band at the lamp's angle, falling to near-black at
    // both edges where the surface turns away from the viewer.
    const xLight = (Math.sin(LIGHT_ANG) / SIN_MAX + 1) / 2;
    const g = c.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, 'rgba(20,14,6,0.74)');
    g.addColorStop(0.055, 'rgba(30,21,9,0.42)');
    g.addColorStop(Math.max(0.1, xLight - 0.1), 'rgba(255,240,210,0.05)');
    g.addColorStop(xLight, lit ? 'rgba(255,246,225,0.20)' : 'rgba(255,246,225,0.07)');
    g.addColorStop(Math.min(0.62, xLight + 0.16), 'rgba(255,240,210,0.03)');
    g.addColorStop(0.8, 'rgba(24,17,7,0.20)');
    g.addColorStop(0.95, 'rgba(20,14,6,0.54)');
    g.addColorStop(1, 'rgba(12,8,3,0.82)');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);

    // The drum's own brushing. Fine enough that it survives a 4x render as a
    // finish rather than becoming corduroy.
    c.globalAlpha = 0.017;
    c.strokeStyle = '#000';
    c.lineWidth = 0.6;
    for (let x = 0; x < w; x += 2.5) {
      c.beginPath();
      c.moveTo(x + 0.5, 0);
      c.lineTo(x + 0.5, h);
      c.stroke();
    }
    c.globalAlpha = 1;
  }

  /** Where the drum rolls under the bezel, top and bottom — bowed, occluding. */
  function paintLips(c: CanvasRenderingContext2D): void {
    const shift = shiftOf();

    const lip = (top: boolean) => {
      // Looking down at the drum, more of the top curl is visible than the
      // bottom one. Same cosine, different depth.
      const depth = top ? h * 0.115 : h * 0.088;
      // The curl is a stack of slices that all follow the same cosine. A single
      // filled path ends on a hard clipped edge, which reads as a gradient laid
      // over a poster; a stack falls off ALONG the rim, which is what a surface
      // turning away from you actually does.
      const SLICES = 18;
      for (let i = 1; i <= SLICES; i++) {
        const d = depth * (i / SLICES);
        c.beginPath();
        if (top) {
          c.moveTo(-2, -2);
          c.lineTo(w + 2, -2);
          for (let x = w + 2; x >= -2; x -= 3) c.lineTo(x, d + curveAt(x) + shift);
        } else {
          c.moveTo(-2, h + 2);
          c.lineTo(w + 2, h + 2);
          for (let x = w + 2; x >= -2; x -= 3) c.lineTo(x, h - d + curveAt(x) + shift);
        }
        c.closePath();
        c.fillStyle = 'rgba(0,0,0,0.145)';
        c.fill();
      }

      // The rim itself catches the lamp — a hairline of light along the curl.
      c.beginPath();
      for (let x = -2; x <= w + 2; x += 3) {
        const y = (top ? depth : h - depth) + curveAt(x) + shift;
        if (x <= -2) c.moveTo(x, y);
        else c.lineTo(x, y);
      }
      const rg = c.createLinearGradient(0, 0, w, 0);
      const strength = lampOn && powered ? 0.3 : 0.12;
      rg.addColorStop(0, 'rgba(255,238,204,0)');
      rg.addColorStop(0.16, `rgba(255,240,210,${strength})`);
      rg.addColorStop(0.45, `rgba(255,232,196,${strength * 0.45})`);
      rg.addColorStop(0.85, 'rgba(255,232,196,0)');
      c.strokeStyle = rg;
      c.lineWidth = 1;
      c.stroke();
    };

    lip(true);
    lip(false);

    // Edge falloff: the last few degrees before the drum disappears.
    const edge = c.createLinearGradient(0, 0, w, 0);
    edge.addColorStop(0, 'rgba(0,0,0,0.58)');
    edge.addColorStop(0.07, 'rgba(0,0,0,0)');
    edge.addColorStop(0.93, 'rgba(0,0,0,0)');
    edge.addColorStop(1, 'rgba(0,0,0,0.62)');
    c.fillStyle = edge;
    c.fillRect(0, 0, w, h);
  }

  // -------------------------------------------------------------------------
  // Printed content

  interface Visible {
    slot: DialSlot;
    t: number;
    sx: number;
    near: number;
    active: boolean;
  }

  function paint(): void {
    if (w <= 0 || h <= 0) return;
    // Below the floor this is not an instrument, and a comb of hairlines is
    // worse than a blank window. Print nothing rather than a smear.
    if (w < DRUM_W_MIN) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      unit.style.display = 'none';
      return;
    }

    const p = rebuildPlan();
    buildCaches();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (bg) ctx.drawImage(bg, 0, 0, w, h);

    const lit = lampOn && powered;
    // Ink darkness follows the lamp: a backlit scale has near-black print, an
    // unlit one is a grey ghost.
    const inkA = lit ? 0.92 : 0.34;
    const ink = lit ? '30,25,17' : '196,190,175';
    const shift = shiftOf();

    const lo = Math.min(band.scaleMin, band.scaleMax);
    const hi = Math.max(band.scaleMin, band.scaleMax);
    const span = hi - lo || 1;

    // Row geometry, top to bottom as on the reference: names, blips, the scale
    // rule with its ticks hanging down, the numerals, the answering foot ticks,
    // the band name. Everything carries the shared shift so the print block and
    // both rims swing together.
    const y = (f: number) => h * f + shift;
    const yName = y(0.15);
    const yBlip = y(0.195);
    const hBlip = h * 0.07;
    const yRule = y(0.355);
    const yMinor = y(0.4);
    const yInter = y(0.438);
    const yMajor = y(0.472);
    const yNum = y(0.6);
    const yFootTop = y(0.688);
    const yFoot = y(0.725);
    const yGenre = y(0.815);

    const pLo = clamp(position - p.visible * 0.62, 0, 1);
    const pHi = clamp(position + p.visible * 0.62, 0, 1);
    const vLo = lo + pLo * span;
    const vHi = lo + pHi * span;

    // --- the scale rule every graduation hangs off -------------------------
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.beginPath();
    for (let x = 0; x <= w; x += 3) {
      const yy = yRule + curveAt(x);
      if (x === 0) ctx.moveTo(x, yy);
      else ctx.lineTo(x, yy);
    }
    ctx.strokeStyle = `rgba(${ink},${inkA * 0.42})`;
    ctx.lineWidth = 1;
    ctx.stroke();

    // --- graduations -------------------------------------------------------
    const first = Math.floor(vLo / p.minor) * p.minor;
    ctx.lineCap = 'butt';
    for (let v = first; v <= vHi + p.minor; v += p.minor) {
      if (v < lo - 1e-9 || v > hi + 1e-9) continue;
      const t = thetaOf((v - lo) / span);
      if (t < -ANG_MAX || t > ANG_MAX) continue;
      const isMajor = Math.abs(v / p.major - Math.round(v / p.major)) < 1e-6;
      const isInter = !isMajor && Math.abs(v / p.intermediate - Math.round(v / p.intermediate)) < 1e-6;
      if (p.tiers === 2 && !isMajor && !isInter) continue;

      const at = setSurface(ctx, t);
      ctx.globalAlpha = inkA * (0.46 + 0.54 * at.sx);
      ctx.strokeStyle = `rgb(${ink})`;
      ctx.lineWidth = Math.max(0.55, isMajor ? 1.55 : isInter ? 1.05 : 0.8);
      // Ink spread: even a hairline graduation bleeds a little into the
      // substrate. Without it the tick field reads as vector art at 4x.
      ctx.shadowColor = `rgba(${ink},${lit ? 0.4 : 0.16})`;
      ctx.shadowBlur = 0.7;
      ctx.beginPath();
      ctx.moveTo(0, yRule);
      ctx.lineTo(0, isMajor ? yMajor : isInter ? yInter : yMinor);
      if (p.rows.foot && (isMajor || (isInter && p.rows.footIntermediates))) {
        ctx.moveTo(0, yFoot);
        ctx.lineTo(0, isMajor ? yFootTop : yFootTop + (yFoot - yFootTop) * 0.45);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // --- numerals ----------------------------------------------------------
    if (p.rows.numerals) {
      const firstN = Math.floor(vLo / p.numeralStep) * p.numeralStep;
      for (let v = firstN; v <= vHi + p.numeralStep; v += p.numeralStep) {
        if (v < lo - 1e-9 || v > hi + 1e-9) continue;
        const t = thetaOf((v - lo) / span);
        if (t < -ANG_MAX || t > ANG_MAX) continue;
        const at = setSurface(ctx, t);
        if (at.sx < 0.15) continue;
        // The numeral cut: 0.9 horizontal, 600 weight, near-zero tracking —
        // a different face from the labels, which is what instrument printing
        // does and what the app's single font stack was not doing.
        ctx.transform(0.9, 0, 0, 1, 0, 0);
        ctx.globalAlpha = inkA * (0.42 + 0.58 * at.sx);
        ctx.fillStyle = `rgb(${ink})`;
        ctx.font = `600 ${p.numeralPx.toFixed(1)}px ${FONT_NUM}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.shadowColor = `rgba(${ink},${lit ? 0.5 : 0.2})`;
        ctx.shadowBlur = Math.max(0.9, p.numeralPx * 0.1);
        ctx.fillText(formatValue(v, p.numeralStep), 0, yNum);
        ctx.shadowBlur = 0;
      }
    }

    // --- the genre, printed along the drum the way band names are ----------
    if (p.rows.genre && band.genre) {
      const text = band.genre.toUpperCase();
      const every = Math.max(p.visible * 0.55, 0.05);
      const start = Math.floor(pLo / every) * every;
      for (let q = start; q <= pHi + every; q += every) {
        if (q < 0 || q > 1) continue;
        const t = thetaOf(q);
        if (t < -ANG_MAX || t > ANG_MAX) continue;
        const at = setSurface(ctx, t);
        if (at.sx < 0.2) continue;
        ctx.globalAlpha = inkA * 0.36 * at.sx;
        ctx.fillStyle = `rgb(${ink})`;
        ctx.font = `${p.genrePx.toFixed(1)}px ${FONT_LABEL}`;
        ctx.textAlign = 'center';
        ctx.letterSpacing = '0.32em';
        ctx.fillText(text, 0, yGenre);
        ctx.letterSpacing = '0em';
      }
    }

    // --- amber station blips ------------------------------------------------
    const seen: Visible[] = [];
    for (const slot of band.slots) {
      const t = thetaOf(slot.position);
      if (t < -ANG_MAX || t > ANG_MAX) continue;
      const sx = Math.cos(t);
      if (sx < 0.1) continue;
      seen.push({
        slot,
        t,
        sx,
        near: 1 - Math.min(1, Math.abs(slot.position - position) / (p.visible * 0.5)),
        active: activeId !== undefined && slot.station.id === activeId,
      });
    }

    /* A blip is a chip of amber lacquer PRINTED ON THE BARREL, not a sticker
     * laid over a picture of one. Everything below is drawn inside the same
     * surface transform as the graduations and the numerals, so the chip's top
     * and bottom edges lie along the local printed row and its vertical edges
     * stay plumb — the same shear, the same cos(t) foreshortening.
     *
     * That geometry was already right and still read as a sticker, because a
     * flat fill gives the eye nothing to read the lean OFF. What makes a
     * surface legible is its light:
     *
     *   1. the ink bleeds into the paper fibre, as the graduations do;
     *   2. it throws a contact shadow down-right onto the paper — one light,
     *      upper left, the same one every bevel on this panel agrees with;
     *   3. the body ramps along the chip's own upper-left → lower-right
     *      diagonal, built in surface space so the ramp shears with the chip;
     *   4. the bottom and right edges take the dark return of a raised part
     *      and the top and left edges take the specular. THAT PAIR OF EDGES IS
     *      WHAT MAKES THE LEAN READABLE;
     *   5. brightness follows the FIXED barrel lamp at the chip's screen
     *      position, so sweeping the drum carries chips through the hot band
     *      instead of each chip carrying a hot band around with it;
     *   6. the leader ends ON the tick baseline, in the graduations' own ink,
     *      because a blip that stops short points at no frequency at all.
     *
     * Blips are printed on the drum, so they answer to the dial lamp like the
     * rest of the scale — turning LIGHT off must not leave them glowing. */
    const strength = (powered ? 1 : 0.5) * (lampOn ? 1 : 0.42);
    for (const v of seen) {
      // Width tracks the lock zone: a strong transmitter prints a fat blip.
      // The floor is what the light model needs to survive: below about four
      // pixels a chip cannot carry a lit edge, a body and a dark return at
      // once, and it collapses back into the flat sticker this replaced.
      const wBlip = Math.max(3.6, (v.slot.width / p.visible) * w * 0.55);
      const hw = wBlip / 2;
      const yBot = yBlip + hBlip;
      const lamp = barrelLight((0.5 + Math.sin(v.t) / SIN_MAX / 2));
      /* The lamp modulates the pigment; it does not extinguish it. A chip out
         at the rim is a DARKER amber, not a brown one — an over-deep falloff
         reads as chocolate and loses the one colour the reference names. */
      const lv = clamp(
        (0.78 + 0.22 * lamp) *
          (0.72 + 0.28 * v.sx) *
          (v.active ? 1 : 0.88 + 0.12 * v.near) *
          strength,
        0,
        1,
      );
      const cLit = v.active ? ACTIVE_LIT : BLIP_LIT;
      const cBody = v.active ? ACTIVE_BODY : BLIP_BODY;
      const cDeep = v.active ? ACTIVE_DEEP : BLIP_DEEP;

      setSurface(ctx, v.t);
      ctx.globalAlpha = 1;

      /* 1 + on-air glow. Canvas shadow offsets and blurs are specified to
         ignore the transform, so they are in device pixels and scale by dpr
         rather than by the surface matrix. Both casters are inset a third of a
         pixel so the opaque chip covers them at every angle. */
      ctx.shadowColor = `rgba(255,168,42,${clamp(
        (v.active ? 0.85 : 0.32) * strength * (0.4 + 0.6 * lamp),
        0,
        1,
      )})`;
      ctx.shadowBlur = (v.active ? 10 : 1.5) * dpr * strength;
      ctx.fillStyle = shade(cBody, lv);
      ctx.fillRect(-hw + 0.3, yBlip + 0.3, wBlip - 0.6, hBlip - 0.6);
      ctx.shadowBlur = 0;

      // 2. the contact shadow, cast from the chip's own sheared footprint.
      ctx.shadowColor = `rgba(44,28,8,${clamp(0.3 + 0.34 * lamp, 0, 1)})`;
      ctx.shadowOffsetX = 0.9 * dpr;
      ctx.shadowOffsetY = 1.35 * dpr;
      ctx.shadowBlur = 2.4 * dpr;
      ctx.fillStyle = shade(cDeep, lv);
      ctx.fillRect(-hw + 0.3, yBlip + 0.3, wBlip - 0.6, hBlip - 0.6);
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
      ctx.shadowBlur = 0;

      // 3. the body.
      const gBody = ctx.createLinearGradient(-hw, yBlip, hw, yBot);
      gBody.addColorStop(0, shade(cLit, lv));
      gBody.addColorStop(0.42, shade(cBody, lv));
      gBody.addColorStop(1, shade(cDeep, lv));
      ctx.fillStyle = gBody;
      ctx.fillRect(-hw, yBlip, wBlip, hBlip);

      // 4. the far edges fall away from the lamp; the near edges catch it.
      const eT = clamp(hBlip * 0.13, 0.6, 1.5);
      const eL = clamp(wBlip * 0.13, 0.5, 1.3);
      ctx.fillStyle = `rgba(58,32,7,${clamp(0.22 + 0.13 * lamp, 0, 1)})`;
      ctx.fillRect(-hw, yBot - eT, wBlip, eT);
      ctx.fillRect(hw - eL, yBlip, eL, hBlip);

      const specA = clamp((0.26 + 0.5 * lamp) * strength, 0, 1);
      const gTop = ctx.createLinearGradient(-hw, 0, hw, 0);
      gTop.addColorStop(0, `rgba(255,240,206,${specA})`);
      gTop.addColorStop(0.55, `rgba(255,232,186,${specA * 0.45})`);
      gTop.addColorStop(1, 'rgba(255,228,180,0)');
      ctx.fillStyle = gTop;
      ctx.fillRect(-hw, yBlip, wBlip, eT);
      const gLeft = ctx.createLinearGradient(0, yBlip, 0, yBot);
      gLeft.addColorStop(0, `rgba(255,240,206,${specA * 0.9})`);
      gLeft.addColorStop(0.6, `rgba(255,230,182,${specA * 0.3})`);
      gLeft.addColorStop(1, 'rgba(255,228,180,0)');
      ctx.fillStyle = gLeft;
      ctx.fillRect(-hw, yBlip, eL, hBlip);

      // 6. the leader, terminating ON the rule the graduations hang off.
      const stemW = clamp(wBlip * 0.065, 0.55, 1);
      ctx.globalAlpha = clamp(inkA * (0.46 + 0.54 * v.sx), 0, 1);
      ctx.fillStyle = `rgb(${ink})`;
      ctx.shadowColor = `rgba(${ink},${lit ? 0.4 : 0.16})`;
      ctx.shadowBlur = 0.7 * dpr;
      ctx.fillRect(-stemW / 2, yBot, stemW, yRule - yBot);
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    }

    /* Printed call signs.
     *
     * A real dial has its names laid out at design time so they never collide;
     * ours arrive from a directory, so we lay them out at paint time. The
     * station under the cursor is always printed — it is what you are reading.
     * Then nearest-first; anything that would collide is simply not printed,
     * which is what a draughtsman did when a name would not fit.
     *
     * Printed, never stored: `StationRef.name` is untouched. displayStationName
     * settles the data question, dialStationName the typographic one. */
    if (p.rows.names) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      const taken: [number, number][] = [];
      let printedCount = 0;
      const byProximity = [...seen].sort(
        (a, b) => Math.abs(a.slot.position - position) - Math.abs(b.slot.position - position),
      );
      for (const v of byProximity) {
        // The last few degrees are too compressed to set type in.
        if (v.sx < 0.36) continue;
        if (printedCount >= p.nameCap && !v.active) continue;
        const label = dialStationName(displayStationName(v.slot.station.name), p.nameChars);
        if (!label) continue;
        const px = v.active ? p.namePx * 1.06 : p.namePx;
        measureCtx.font = `${px}px ${FONT_LABEL}`;
        measureCtx.letterSpacing = '0.14em';
        const tw = measureCtx.measureText(label).width;
        measureCtx.letterSpacing = '0em';
        const cx = w / 2 + (Math.sin(v.t) / SIN_MAX) * (w / 2);
        const halfText = (tw * v.sx) / 2 + 6;
        if (taken.some(([a, b]) => cx - halfText < b && cx + halfText > a)) continue;
        taken.push([cx - halfText, cx + halfText]);
        printedCount++;

        setSurface(ctx, v.t);
        ctx.globalAlpha = clamp(
          inkA * (v.active ? 0.95 : 0.3 + 0.4 * v.near) * (0.3 + 0.7 * v.sx),
          0,
          1,
        );
        ctx.fillStyle = v.active ? '#3a1f04' : `rgb(${ink})`;
        ctx.font = `${px.toFixed(1)}px ${FONT_LABEL}`;
        ctx.letterSpacing = '0.14em';
        ctx.shadowColor = `rgba(${ink},0.35)`;
        ctx.shadowBlur = 0.9;
        ctx.fillText(label, 0, yName);
        ctx.shadowBlur = 0;
        ctx.letterSpacing = '0em';
      }
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    if (fg) ctx.drawImage(fg, 0, 0, w, h);

    unit.textContent = band.scaleUnit;
    unit.style.display = w >= DRUM_W_INSTRUMENT ? '' : 'none';
  }

  // -------------------------------------------------------------------------
  // Scheduling

  function invalidate(): void {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      paint();
    });
  }

  const ro = new ResizeObserver((entries) => {
    const rect = entries[0]!.contentRect;
    dpr = window.devicePixelRatio || 1;
    w = rect.width;
    h = rect.height;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    cacheKey = '';
    planKey = '';
    paint();
  });
  ro.observe(root);

  // -------------------------------------------------------------------------
  // Direct manipulation: you can also just grab the drum and sweep it.

  let dragging = false;
  let downX = 0;
  let moved = 0;

  const onDown = (ev: PointerEvent) => {
    if (ev.button !== 0 && ev.pointerType === 'mouse') return;
    dragging = true;
    moved = 0;
    downX = ev.clientX;
    root.setPointerCapture(ev.pointerId);
    root.classList.add('is-grabbed');
    opts.onScrubStart();
    ev.preventDefault();
  };
  const onMove = (ev: PointerEvent) => {
    if (!dragging) return;
    const dx = ev.clientX - downX;
    downX = ev.clientX;
    moved += Math.abs(dx);
    // Dragging the drum moves the print under your finger 1:1 — which is why
    // the scrub has to convert pixels through the SAME fraction the print is
    // laid out with, plan.visible, not the tuning model's raw ask.
    const delta = -(dx / Math.max(1, w)) * visibleFraction();
    opts.onScrub(delta, ev.shiftKey);
  };
  const onUp = (ev: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    try {
      root.releasePointerCapture(ev.pointerId);
    } catch {
      /* gone */
    }
    root.classList.remove('is-grabbed');
    opts.onScrubEnd();

    // A tap, not a sweep: pick the station you pointed at.
    if (moved < 4) {
      const rect = root.getBoundingClientRect();
      const u = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      const theta = Math.asin(clamp(u * SIN_MAX, -1, 1));
      const q = position + theta / radPerUnit();
      const hit = nearestSlotTo(q);
      if (hit) opts.onPickStation(hit.station.id);
    }
  };

  function nearestSlotTo(q: number): DialSlot | undefined {
    let best: DialSlot | undefined;
    let bestD = Infinity;
    for (const s of band.slots) {
      const d = Math.abs(s.position - q);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return bestD < visibleFraction() * 0.25 ? best : undefined;
  }

  root.addEventListener('pointerdown', onDown);
  root.addEventListener('pointermove', onMove);
  root.addEventListener('pointerup', onUp);
  root.addEventListener('pointercancel', onUp);

  return {
    root,
    canvas,
    get plan() {
      return plan;
    },
    setBand(next) {
      band = next;
      planKey = '';
      invalidate();
    },
    setPosition(next) {
      if (next === position) return;
      position = next;
      invalidate();
    },
    setLamp(on) {
      if (on === lampOn) return;
      lampOn = on;
      cacheKey = '';
      invalidate();
    },
    setPowered(on) {
      if (on === powered) return;
      powered = on;
      cacheKey = '';
      invalidate();
    },
    setActiveStation(id) {
      if (id === activeId) return;
      activeId = id;
      invalidate();
    },
    invalidate,
    destroy() {
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
      root.removeEventListener('pointerdown', onDown);
      root.removeEventListener('pointermove', onMove);
      root.removeEventListener('pointerup', onUp);
      root.removeEventListener('pointercancel', onUp);
    },
  };
}
