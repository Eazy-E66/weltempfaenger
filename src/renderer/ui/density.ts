/**
 * PRINTED DENSITY — one law, both instruments.
 *
 * A dial's engraving is not a proportion of the dial. It is ink at a physical
 * pitch: the engraver's rule says "a graduation every 2 mm", and when Sony made
 * a longer scale they cut MORE graduations, they did not spread the same ones
 * further apart. Everything below follows from that single sentence.
 *
 *   pitch is a constant in CSS pixels;
 *   the SCALE INTERVAL is whatever 1/2/5 step lands nearest that pitch;
 *   the interval therefore steps DOWN in discrete jumps as the dial grows —
 *   which is exactly what "switches to a finer subdivision at larger sizes"
 *   means on real engraved and printed scales.
 *
 * Type does the opposite. A numeral is read by an eye at a desk, so it holds a
 * near-constant physical size and only creeps up a little on a big instrument,
 * then stops. Uniform scale-up is the cartoon failure mode: it keeps the ratio
 * of type to dial and so keeps the numeral COUNT fixed, which is the density
 * collapse this module exists to fix.
 *
 * Pure arithmetic — no DOM, no canvas, no state. Text measurement arrives as an
 * injected `labelWidthOf`, so the whole law is unit-testable in Node.
 *
 * All widths here are CSS pixels of the instrument itself. If a chassis-level
 * zoom is ever applied, pass the PRE-ZOOM width or every rule below runs twice.
 */

/* --- the one constant ----------------------------------------------------- */

/** Where a printed minor graduation wants to sit, in CSS px, measured at the
 *  reading point (drum: window centre; meter: the tick radius). 8 px at a
 *  normal desk viewing distance is about 2 mm of ink — the reference pitch. */
export const PITCH_TARGET = 8;
/** Below this two adjacent graduations stop resolving and the field turns grey. */
export const PITCH_MIN = 5.6;
/** Above this the scale is visibly sparse; the answer is more scale, not more paper. */
export const PITCH_MAX = 15;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/* --- 1/2/5 ladder --------------------------------------------------------- */

/** Every rung of the 1/2/5 ladder within four decades of `raw`. */
function ladder(raw: number): number[] {
  const out: number[] = [];
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-9))) - 1);
  for (let d = 0; d < 4; d++) {
    const m = mag * Math.pow(10, d);
    out.push(1 * m, 2 * m, 5 * m);
  }
  return out;
}

export interface StepChoice {
  step: number;
  pitch: number;
  /** True when the resolution floor, not the eye, chose the step — the signal
   *  that the only way left to hold the pitch is to show more scale. */
  clamped: boolean;
}

/**
 * The ladder rung whose resulting pitch is closest to `PITCH_TARGET`, never
 * finer than `resolution` (the smallest unit the scale can honestly claim —
 * 1 kHz on a kHz dial) and never tighter than `PITCH_MIN`.
 */
export function bestStep(pxPerUnit: number, resolution: number): StepChoice {
  let best: { step: number; pitch: number; err: number } | null = null;
  for (const step of ladder(PITCH_TARGET / pxPerUnit)) {
    if (step < resolution - 1e-12) continue;
    const pitch = step * pxPerUnit;
    if (pitch < PITCH_MIN) continue;
    // Asymmetric: too tight is worse than too loose, because ink closes up and
    // a comb reads as a grey band, whereas a slightly open scale still reads
    // as a scale. Erring below target is penalised 1.6x.
    const err = pitch < PITCH_TARGET ? (PITCH_TARGET - pitch) * 1.6 : pitch - PITCH_TARGET;
    if (!best || err < best.err) best = { step, pitch, err };
  }
  if (!best) {
    return { step: resolution, pitch: resolution * pxPerUnit, clamped: true };
  }
  return { step: best.step, pitch: best.pitch, clamped: best.step <= resolution + 1e-12 };
}

/* --- type ramps ----------------------------------------------------------- */

/**
 * Type size against instrument width. Linear from `w0` to `w1`, then FLAT.
 * The flat section is the whole point: past `w1` a bigger dial gets more
 * numerals, never bigger ones.
 */
export function typeRamp(w: number, w0: number, w1: number, px0: number, px1: number): number {
  if (w <= w0) return px0;
  if (w >= w1) return px1;
  return px0 + (px1 - px0) * ((w - w0) / (w1 - w0));
}

export function formatValue(v: number, step: number): string {
  const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  return v.toFixed(decimals);
}

/* ===========================================================================
   DRUM DIAL
   ===========================================================================

   Geometry recap (unchanged, and honest): screen x = sin(theta)/sin(ANG_MAX),
   so the reading point at the window centre is magnified relative to the mean
   by K = ANG_MAX / sin(ANG_MAX). Every pitch below is measured there, because
   that is where the eye and the cursor are.
   ------------------------------------------------------------------------- */

export const ANG_MAX = (64 * Math.PI) / 180;
export const SIN_MAX = Math.sin(ANG_MAX);
export const COS_MAX = Math.cos(ANG_MAX);
/** Centre magnification, 1.2428. */
export const K_CENTRE = ANG_MAX / SIN_MAX;

/** Hard floors. Below these the window is not an instrument. */
export const DRUM_W_INSTRUMENT = 260; // below: ticks + pointer only, no numerals
export const DRUM_W_MIN = 190; // below: not a dial at all, print nothing
export const DRUM_H_MIN_FOOT = 96; // below: no answering foot-tick row
export const DRUM_H_MIN_NAMES = 78; // below: blips only, no printed station names
export const DRUM_H_MIN_GENRE = 104; // below: no genre watermark
/** Never show more than this much of a band at once, whatever the width. */
export const VF_CAP = 0.42;

export interface DrumPlanInput {
  /** CSS px of the dial window. */
  w: number;
  h: number;
  /** Scale units across the whole band (e.g. 1071 for 531..1602 kHz). */
  range: number;
  /** Finest unit the scale may honestly claim (1 kHz, 0.01 MHz). */
  resolution: number;
  /** Visible fraction the tuning model asks for. */
  vf: number;
  /** Measured px width of a numeral at the given size. */
  labelWidthOf(text: string, px: number): number;
  /** A representative value, so 4-digit kHz and 3-digit MHz self-adapt. */
  sample?: number;
}

export interface DrumPlan {
  visible: number;
  /** The density law took more drum than the tuning model asked for. */
  widened: boolean;
  /**
   * The pitch could not be held: the scale's honest resolution is the floor and
   * the visible-fraction cap is the ceiling, and between them there was nothing
   * left to give. A real 195 kHz shortwave band on a 1000 px window is exactly
   * this case — it is a bandspread dial, and a bandspread dial genuinely does
   * have widely-spaced graduations. Reported rather than hidden, because the
   * alternative would be to engrave finer than the band can honestly claim.
   */
  sparse: boolean;
  pxPerUnit: number;
  minor: number;
  intermediate: number;
  major: number;
  tiers: 2 | 3;
  minorPitch: number;
  intermediatePitch: number;
  majorPitch: number;
  numeralStep: number;
  numeralPitch: number;
  numeralPx: number;
  namePx: number;
  nameCap: number;
  nameChars: number;
  genrePx: number;
  rows: {
    ticks: boolean;
    numerals: boolean;
    foot: boolean;
    footIntermediates: boolean;
    names: boolean;
    genre: boolean;
  };
  counts: { minors: number; intermediates: number; majors: number; numerals: number };
}

/**
 * Everything the drum prints, for a given window and band. Nothing in the
 * result is a constant × w.
 */
export function drumPlan({
  w,
  h,
  range,
  resolution,
  vf,
  labelWidthOf,
  sample,
}: DrumPlanInput): DrumPlan {
  /* --- 1. how much drum to show.
       Two claims compete. The tuning model wants about five stations under the
       glass. The density law wants the graduation pitch held at target, and on
       a scale with a resolution floor (1 kHz cannot be subdivided honestly) the
       only remaining way to hold it on a very wide window is to show MORE DRUM.
       A physically larger window on a real set does exactly that. The larger of
       the two wins, capped, so the drum never turns into a whole-band overview.

       This is the one place the density law reaches into tuning gearing. It
       does not change the feel: the print still tracks the hand 1:1, because
       the scrub converts pixels through this same fraction. */
  const vfForPitch = (resolution * w * K_CENTRE) / (PITCH_TARGET * range);
  let visible = Math.min(Math.max(vf, vfForPitch), VF_CAP);
  const widened = visible > vf + 1e-9;
  let pxPerUnit = (w * K_CENTRE) / (visible * range);

  /* --- 2. the minor graduation -------------------------------------------- */
  let g = bestStep(pxPerUnit, resolution);

  /* --- 3. last resort: the band is simply too narrow for this window. Show
           as much of it as the cap allows rather than printing whitespace. */
  if (g.clamped && g.pitch > PITCH_MAX && visible < VF_CAP - 1e-9) {
    visible = VF_CAP;
    pxPerUnit = (w * K_CENTRE) / (visible * range);
    g = bestStep(pxPerUnit, resolution);
  }

  /* --- 4. tick tiers.
       Three tiers is the printed-dial standard: minor, intermediate at 5,
       major at 10. The intermediate tier is what carries density at large
       sizes; it costs nothing to drop it when there is no room, which is why
       small panel scales look plain. */
  const minor = g.step;
  const intermediate = minor * 5;
  const major = minor * 10;
  const tiers: 2 | 3 = g.pitch >= PITCH_MIN * 1.12 ? 3 : 2;

  /* --- 5. numerals: the finest tier that will not collide.
       1.9x the widest numeral is the printed-dial convention — a numeral needs
       roughly its own width of clear paper either side to read as a mark on a
       scale rather than as a word. */
  const numeralPx = Math.min(typeRamp(w, 320, 1400, 10.5, 16), h * 0.155);
  const probe = sample !== undefined ? sample : Math.max(Math.abs(range), 1);
  const labelW = labelWidthOf(formatValue(probe, minor), numeralPx);
  let numeralStep: number | null = null;
  for (const cand of [intermediate, major, major * 2, major * 5, major * 10]) {
    if (cand * pxPerUnit >= labelW * 1.9) {
      numeralStep = cand;
      break;
    }
  }
  if (numeralStep === null) numeralStep = major * 10;
  // Never label a tier finer than the tick tiers we actually printed.
  if (tiers === 2 && numeralStep < major) numeralStep = major;

  /* --- 6. station names.
       A dial with 40 names is a spreadsheet. One legible name per ~140 px of
       window is the density at which printed call signs still read as
       annotations on a scale. */
  const namePx = clamp(numeralPx * 0.62, 7, 10.5);
  const nameCap = Math.max(2, Math.floor(w / 140));
  /** Printed characters a drum can carry. Grows, but slowly, and stops. */
  const nameChars = Math.round(typeRamp(w, 320, 1400, 11, 18));

  /* --- 7. rows that only exist when there is height for them -------------- */
  const rows = {
    ticks: true,
    numerals: w >= DRUM_W_INSTRUMENT,
    foot: h >= DRUM_H_MIN_FOOT,
    footIntermediates: h >= DRUM_H_MIN_FOOT,
    names: h >= DRUM_H_MIN_NAMES && w >= 300,
    genre: h >= DRUM_H_MIN_GENRE && w >= 420,
  };

  return {
    visible,
    widened,
    sparse: g.clamped && g.pitch > PITCH_MAX,
    pxPerUnit,
    minor,
    intermediate,
    major,
    tiers,
    minorPitch: g.pitch,
    intermediatePitch: g.pitch * 5,
    majorPitch: g.pitch * 10,
    numeralStep,
    numeralPitch: numeralStep * pxPerUnit,
    numeralPx,
    namePx,
    nameCap,
    nameChars,
    genrePx: clamp(numeralPx * 0.55, 6.5, 9.5),
    rows,
    counts: {
      minors: Math.round((visible * range) / minor),
      intermediates: Math.round((visible * range) / intermediate),
      majors: Math.round((visible * range) / major),
      numerals: Math.round((visible * range) / numeralStep),
    },
  };
}

/* ===========================================================================
   METER FACE
   ===========================================================================

   A moving-coil movement is a physical part. Sony fitted the same ~50 x 30 mm
   meter to a portable and to a rack tuner; the instrument does not grow with
   the cabinet. So the meter has a MAXIMUM useful size, and the interesting
   design question is what happens in the narrow band below it.
   ------------------------------------------------------------------------- */

/** The movement's physical size range, CSS px of window width. */
export const METER_W_MIN = 132;
export const METER_W_MAX = 300;
/** Sweep and tick radius in the 200-wide face coordinate system. */
const SWEEP_DEG = 108;
const R_TICK = 89;

export interface MeterPlan {
  w: number;
  arcPx: number;
  sub: number;
  pitch: number;
  marks: number;
  vb: number;
  numeralVb: number;
  titleVb: number;
  markVb: number;
  needleBaseVb: number;
  needleTipVb: number;
  tickMajorVb: number;
  tickMinorVb: number;
  showSmallPrint: boolean;
  showModel: boolean;
  showZeroDatum: boolean;
}

/**
 * What the meter face prints at width `mw`.
 *
 * The tick arc is 0.839 x mw CSS px. Sub-divisions come off the same 1/2/5
 * ladder as the drum, against the same 8 px target. The result is the argument
 * for capping the meter: s = 5 (a 50-graduation face) only becomes legal past
 * ~334 px, and a 334 px signal meter on a receiver panel is a caricature. So
 * the meter is capped BELOW the size at which it would earn a finer tier —
 * which is precisely why real panel meters have one tick tier and look the way
 * they do.
 */
export function meterPlan(mw: number): MeterPlan {
  const w = clamp(mw, METER_W_MIN, METER_W_MAX);
  const arcPx = ((SWEEP_DEG * Math.PI) / 180) * R_TICK * (w / 200);

  let sub = 1;
  let bestErr = Infinity;
  for (const s of [1, 2, 5]) {
    const p = arcPx / (10 * s);
    if (p < PITCH_MIN) continue;
    const err = p < PITCH_TARGET ? (PITCH_TARGET - p) * 1.6 : p - PITCH_TARGET;
    if (err < bestErr) {
      bestErr = err;
      sub = s;
    }
  }
  const pitch = arcPx / (10 * sub);

  /* Type and needle are specified in RENDERED px and converted into face
     units, so they do not scale with the instrument. `vb` is the face-unit
     value of one CSS px. */
  const vb = 200 / w;
  const numeralPx = typeRamp(w, METER_W_MIN, 260, 10, 12.5);
  const titlePx = typeRamp(w, METER_W_MIN, 260, 8.5, 10);
  const markPx = typeRamp(w, METER_W_MIN, 260, 6.4, 7.6);

  return {
    w,
    arcPx,
    sub,
    pitch,
    /** 11 division marks plus (sub-1) between each pair. */
    marks: 10 * sub + 1,
    vb,
    numeralVb: numeralPx * vb,
    titleVb: titlePx * vb,
    markVb: markPx * vb,
    /** A real needle is ~0.3 mm of painted aluminium at ANY meter size. */
    needleBaseVb: 2.0 * vb,
    needleTipVb: 0.62 * vb,
    tickMajorVb: 1.45 * vb,
    tickMinorVb: 0.85 * vb,
    showSmallPrint: w >= 168,
    showModel: w >= 186,
    showZeroDatum: w >= 150,
  };
}
