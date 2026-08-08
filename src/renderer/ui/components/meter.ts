/**
 * The SIGNAL meter.
 *
 * A moving-coil movement is a mass on a spring in a magnetic damping field, so
 * that is what this is: a second-order system integrated per frame. It cannot
 * snap, it overshoots a little on a fast rise, and it drifts back rather than
 * dropping. Natural frequency and damping ratio are the only two knobs.
 *
 * The needle is driven by PlaybackState.signalLevel and by nothing else. There
 * is no idle animation, no fake liveliness: the rAF loop exists only while the
 * pointer is actually in motion and shuts down the moment it settles, so a dead
 * stream reads dead and costs nothing.
 *
 * THREE LAYERS, ONE INSTRUMENT.
 *
 * With real programme material the needle is always in motion, so "costs
 * nothing when settled" was never the case that mattered. The face carries a
 * turbulence pass for the paper fibre, an ink blur over the entire printed
 * group, three blurred ink-spread passes and three more turbulence passes for
 * the band's paper tooth. With the needle drawn into the same SVG, every
 * position of the needle invalidated all of that, and Blink re-recorded and
 * re-rastered the lot: 7.6 s of RasterTask per 4 s of wall clock, ~190% of a
 * core, with the main thread stuck in `WaitForCommitCompletion` and rAF down to
 * 5 fps.
 *
 * So the instrument is three stacked viewports over the same viewBox:
 *
 *   face   — paper, fibre, print. Static, promoted, rastered once.
 *   needle — the movement alone, turned by a CSS transform on the layer, so the
 *            compositor changes a matrix and nothing is repainted.
 *   boss   — the pivot cap, which has to print over the needle. Static.
 *
 * Nothing about the reading changed: `setLevel` still takes the engine's RMS ×
 * link health, the ballistics still integrate per frame, and zero is still zero.
 *
 * THE FACE.
 *
 *  1. The title says what the movement measures. `signalLevel` is decoded audio
 *     level times measured link health (see engine/meter.ts) — nothing about
 *     tuning is on this movement, so it is silkscreened SIGNAL, not TUNING.
 *     Law 1 says a control does the job it is labelled with; the same must hold
 *     for an indicator.
 *
 *  2. The scale has a zero DATUM: a heavier, unnumbered mark at the left end
 *     stop where the needle mechanically rests. `1 … 9 0` label the ten
 *     divisions above it, so the printed row is still the reference's and the
 *     needle reads zero on a printed zero when the engine reports zero.
 *
 *  3. The coloured band is printed INK, not a stroke. Three passes: a blurred
 *     spread masked at the band's outer radius so ink can only bloom inward
 *     (the edge the printer registered against the scale rule is a knife edge,
 *     the free edge feathers — what a squeegee leaves), then the ink, then a
 *     paper-tooth pass letting the fibre back through.
 *
 *  4. TYPE AND NEEDLE ARE SPECIFIED IN RENDERED PIXELS and converted into the
 *     200-wide face coordinate system, so a 300 px meter has a proportionally
 *     finer needle and only slightly larger figures rather than a 1.6x cartoon
 *     of a 192 px one. A real needle is 0.3 mm of painted aluminium whatever
 *     meter it is in. See ui/density.ts — meterPlan also caps the movement at
 *     300 px, just below the size at which it would earn a third tick tier,
 *     which is precisely why real panel meters have two. The face re-plans when
 *     the layout gives it a different width; it never simply scales.
 *
 *  5. The needle's shadow filter is `filterUnits="userSpaceOnUse"`. The default
 *     is objectBoundingBox at -10%/120%, and the needle's bounding box is two
 *     units wide, so a proportional region clipped the blur away entirely and
 *     the shadow never rendered at all.
 */

import { clamp, prefersReducedMotion, svg } from '../dom';
import { meterPlan, METER_W_MAX, METER_W_MIN, type MeterPlan } from '../density';
import { isAttended, onAttentionChange } from '../../engine/attention';

const PIVOT_X = 100;
const PIVOT_Y = 108;
const SWEEP = 108; // degrees, symmetric about vertical

const R_TICK_OUT = 89;
const R_MINOR_OUT = 84.3;
/** The hairline arc every graduation hangs off. Ticks that float free read as
 *  a dashed line rather than as a scale. */
const R_RULE = 79.5;
const R_NUM = 70.5;
const R_BAND = 58.5;
const BAND_W = 7.4;
const R_NEEDLE = 86.5;
const R_TAIL = 7.5;

/** ~2.3 Hz movement, damping ratio 0.62 — a visible but disciplined overshoot. */
const OMEGA = 2 * Math.PI * 2.3;
const ZETA = 0.62;

/* Zone edges, in scale fraction. Set by what the engine actually produces:
   below 0.2 the product has collapsed (bytes stopped, buffer drained, or the
   decoder is silent); 0.55 up is where a healthy 128–320 kbps mount lives, per
   engine/meter.ts's own measured range. No zone carries a word, because a
   label under the red would name one of three causes and hide the other two. */
const ZONE_RED_END = 0.2;
const ZONE_TEAL_START = 0.55;

export interface MeterHandle {
  root: HTMLElement;
  /** 0..1, straight from the engine's RMS × link health. */
  setLevel(level: number): void;
  setPowered(on: boolean): void;
  /** The face's live print plan, for evidence. */
  readonly plan: MeterPlan;
  destroy(): void;
}

const toRad = (t: number) => ((t - 0.5) * SWEEP - 90) * (Math.PI / 180);
const at = (t: number, r: number) => {
  const a = toRad(t);
  return [PIVOT_X + Math.cos(a) * r, PIVOT_Y + Math.sin(a) * r] as const;
};
const arcPath = (t0: number, t1: number, r: number) => {
  const [x0, y0] = at(t0, r);
  const [x1, y1] = at(t1, r);
  return `M ${x0.toFixed(3)} ${y0.toFixed(3)} A ${r} ${r} 0 0 1 ${x1.toFixed(3)} ${y1.toFixed(3)}`;
};

export function createMeter(initialWidth = 192): MeterHandle {
  let plan = meterPlan(initialWidth);
  let needleGroup = buildNeedle(plan);

  const face = svg('svg', {
    class: 'meter__svg',
    viewBox: '0 0 200 118',
    'aria-hidden': 'true',
    focusable: 'false',
    /* Its own compositor layer. The face is where all the expensive print is —
       a turbulence pass for the paper fibre, an ink blur over the whole printed
       group, three blurred ink-spread passes and three more turbulence passes
       for the band's paper tooth — and none of it ever changes after a re-plan.
       In one SVG with the needle, every needle position re-recorded and
       re-rastered all of it: measured 7.6 s of RasterTask per 4 s of wall clock.
       Promoted, it is rastered once and the moving parts cannot dirty it. */
    style: 'will-change: transform',
  });
  face.append(buildDefs(), ...buildPaper(), buildPrinted(plan));

  /* THE MOVEMENT, ON ITS OWN LAYER.
   *
   * The needle is the one thing on this instrument that moves, and it moves
   * because the analyser says so — up to 60 times a second with programme
   * material on the air. So it is not drawn into the face: it is its own
   * viewport, stacked over the face, turned about the pivot by a CSS transform
   * on the layer itself. The compositor re-uses the same raster and only changes
   * the matrix, so a needle sweeping the full scale costs no repaint at all.
   *
   * The viewBox is the face's, so needle geometry stays in face coordinates and
   * `transform-origin` is the pivot expressed as a fraction of that box
   * (100/200, 108/118). `.meter` fixes the aspect ratio at 200/118, so one CSS
   * degree here is one degree of the printed scale. */
  const needleLayer = svg('svg', {
    class: 'meter__svg meter__svg--needle',
    viewBox: '0 0 200 118',
    'aria-hidden': 'true',
    focusable: 'false',
    style:
      'position:absolute;inset:0;transform-origin:50% 91.5254%;will-change:transform;overflow:visible',
  });
  needleLayer.append(needleGroup);

  /* The pivot boss caps the needle, so it has to print over it — a separate
     static viewport above the movement, rather than the tail of the face's own
     display list. Four circles and one small blur, rastered once. */
  const bossLayer = svg('svg', {
    class: 'meter__svg meter__svg--boss',
    viewBox: '0 0 200 118',
    'aria-hidden': 'true',
    focusable: 'false',
    style: 'position:absolute;inset:0',
  });
  bossLayer.append(...buildBoss());

  const root = document.createElement('div');
  root.className = 'meter recess';
  root.setAttribute('role', 'meter');
  root.setAttribute('aria-label', 'Signal strength: decoded audio level times link health');
  root.setAttribute('aria-valuemin', '0');
  root.setAttribute('aria-valuemax', '1');
  root.setAttribute('aria-valuenow', '0');
  // Face, then movement, then boss. All three are position:absolute with
  // z-index auto except the face, so they paint in document order under the
  // lightwash (z 1) and the glass (z 2), exactly as one SVG did.
  root.append(face, needleLayer, bossLayer);

  const wash = document.createElement('div');
  wash.className = 'meter__lightwash';
  root.append(wash);

  /* THE PANE OVER A PALE FACE.
   *
   * `.mat-glass` was tuned against the drum dial, which is dark: a 0.185-alpha
   * white streak on a near-black ground is a clear specular, and on this face
   * — cream card at ~235 — the same streak lands four levels above the paper
   * and is not there at all. `--pale` rebuilt the streak as a fraction of the
   * REMAINING headroom above the paper and added the green cast plate glass
   * has over a bright ground.
   *
   * It still measured as a vignette, and the reason was placement rather than
   * strength: the whole streak sat between 9.8% and 26% of the gradient axis,
   * which on this window is hard against the bezel's own inner shadow, so it
   * read as one more step of the bezel edge instead of as a reflection lying
   * on the pane. The pane is now specified in displays.css under
   * `.meter__glass`, which is imported after materials.css and therefore wins:
   * the streak is moved into the pane and widened, and the numbers are in the
   * comment there. These classes stay on the element for the bezel shadow, the
   * radius and the dust. */
  const glass = document.createElement('div');
  glass.className = 'meter__glass mat-glass mat-glass--pale';
  root.append(glass);

  let target = 0;
  let pos = 0;
  let vel = 0;
  let raf = 0;
  let lastT = 0;
  let powered = false;

  /** The angle last written to the layer, so an unmoved needle writes nothing. */
  let appliedDeg = Number.NaN;
  let appliedAt = -Infinity;
  /** Set when attention returns: the next reading is placed, not sprung to. */
  let snapNextReading = false;

  /**
   * How often the drawn needle may be moved, milliseconds.
   *
   * The movement is a 2.3 Hz second-order system; drawing it 30 times a second
   * is thirteen times its own bandwidth and is indistinguishable from drawing it
   * sixty. What it is not indistinguishable from is the cost: every frame in
   * which anything on the panel moves is a commit, a composite and a present of
   * the whole window, and doing that sixty times a second for a pointer that
   * cannot move that fast is the definition of work with no product.
   *
   * This throttles the *drawing*, and nothing else. The analyser is still read
   * every frame by the host, `setLevel` still takes every one of those readings,
   * the ballistics below still integrate at frame rate against real dt, and the
   * settled position is always written (`force`), so the needle still comes to
   * rest exactly where the measurement says — including exactly zero.
   */
  const MIN_DRAW_MS = 33;

  /**
   * `aria-valuenow`, to two decimals — a hundred states, so most frames would
   * write the identical string and rebuild the accessibility node for nothing.
   * Guarded: the value published is the same, the writes are only the changes.
   */
  const publishValue = (value: number): void => {
    const published = value.toFixed(2);
    if (root.getAttribute('aria-valuenow') !== published) {
      root.setAttribute('aria-valuenow', published);
    }
  };

  const apply = (force = false) => {
    const deg = (clamp(pos, -0.02, 1.03) - 0.5) * SWEEP;
    /* One decimal place. The movement sweeps 108° across a 300 px face, so 0.1°
       is a quarter of a pixel at the needle tip — below what the rasteriser can
       show, and therefore not worth a style write. This is a resolution limit on
       the *drawing*, not on the reading: `pos` keeps the full precision of the
       analyser's RMS and the integrator's state, and zero still writes exactly
       zero because -54.0 is exactly representable. */
    const q = Math.round(deg * 10) / 10;
    if (q === appliedDeg) return;
    const now = performance.now();
    // Never drop the last word: a skipped frame is always followed by another
    // one while the movement is live, and the settle writes with `force`.
    if (!force && now - appliedAt < MIN_DRAW_MS) return;
    appliedDeg = q;
    appliedAt = now;
    needleLayer.style.transform = `rotate(${q}deg)`;
  };

  /* Re-plan, never re-scale. The face is ~80 nodes and rebuilding it costs less
     than a single frame; what matters is that the graduations, the type and the
     needle all come from the width the instrument actually has. */
  function replan(cssWidth: number): void {
    const next = meterPlan(cssWidth);
    if (Math.abs(next.w - plan.w) < 3) return;
    plan = next;
    const printed = face.querySelector('.meter__printed');
    const nextPrinted = buildPrinted(plan);
    if (printed) printed.replaceWith(nextPrinted);
    const nextNeedle = buildNeedle(plan);
    needleGroup.replaceWith(nextNeedle);
    needleGroup = nextNeedle;
    apply(true);
  }

  const ro = new ResizeObserver((entries) => {
    const cr = entries[0]!.contentRect;
    if (cr.width < 2) return;
    replan(cr.width);
  });
  ro.observe(root);

  const step = () => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;
    raf = 0;

    // Sub-step so a dropped frame cannot make the movement explode.
    let remaining = dt;
    while (remaining > 0) {
      const s = Math.min(remaining, 1 / 120);
      remaining -= s;
      const a = OMEGA * OMEGA * (target - pos) - 2 * ZETA * OMEGA * vel;
      vel += a * s;
      pos += vel * s;
      // The movement has physical end stops.
      if (pos < -0.02) {
        pos = -0.02;
        vel = Math.max(0, vel);
      }
      if (pos > 1.04) {
        pos = 1.04;
        vel = Math.min(0, vel);
      }
    }

    apply();

    if (Math.abs(target - pos) > 0.0006 || Math.abs(vel) > 0.002) {
      raf = requestAnimationFrame(step);
    } else {
      pos = target;
      vel = 0;
      // The movement has come to rest. This one is not throttled: where the
      // needle finally stands is the reading, and on a dead stream it is zero.
      apply(true);
    }
  };

  const wake = () => {
    if (raf) return;
    // NOBODY IS LOOKING. The movement still reads the truth (see setLevel: the
    // pointer is placed on the target outright), it just is not drawn getting
    // there. A spring integrated at 60 fps for an audience of nobody is the
    // single most expensive thing this panel does.
    if (!isAttended()) return;
    lastT = performance.now();
    raf = requestAnimationFrame(step);
  };

  /**
   * Attention came back. Draw the reading the movement is actually holding,
   * immediately and without ballistics.
   *
   * The swing is a lie in this direction: the needle was not *travelling* while
   * the lid was shut, it was standing at whatever the analyser last reported,
   * and a half-second sweep on return would show a rise that never happened.
   * Law 2 wants the current reading on the glass at the moment the glass is
   * looked at — including exactly zero on a dead stream.
   */
  const unwatchAttention = onAttentionChange((attentive) => {
    if (!attentive) {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      return;
    }
    // What it is holding is the last reading it was given — draw that at once,
    // so nothing older than the last measurement is ever on the glass…
    pos = target;
    vel = 0;
    apply(true);
    // …and the first reading taken after the glass is looked at again lands
    // without a swing. The host reads the analyser on its very next frame; a
    // half-second sweep up to that value would draw a rise that never happened.
    snapNextReading = true;
  });

  // A moving-coil movement rests against its zero stop when it is not powered.
  // Without this the group carries no transform at all and the needle renders
  // straight up — mid-scale on a 10-point SIGNAL dial, which asserts half signal
  // on a fresh renderer that has measured none. Both setters below early-return
  // when the value is already its initial one, so the first honest position has
  // to be written here. `tuningKnob.ts` calls `sync()` for the same reason.
  apply(true);

  return {
    root,
    get plan() {
      return plan;
    },
    setLevel(level: number) {
      const next = powered ? clamp(level, 0, 1) : 0;
      if (next === target) return;
      target = next;
      publishValue(next);
      if (prefersReducedMotion() || snapNextReading) {
        snapNextReading = false;
        pos = target;
        vel = 0;
        apply(true);
        return;
      }
      /* Unwatched: take the reading, skip the journey. `pos` is the movement's
         position and it is set to the measurement rather than left where it
         was, so nothing here can go stale — what is skipped is the ballistics
         and the drawing, neither of which anybody can see. The next `apply`,
         which happens the instant attention returns, writes this. */
      if (!isAttended()) {
        pos = target;
        vel = 0;
        return;
      }
      wake();
    },
    setPowered(on: boolean) {
      if (on === powered) return;
      powered = on;
      root.classList.toggle('is-powered', on);
      if (!on) {
        target = 0;
        /* The value goes with the movement. Publishing it only from `setLevel`
           left the accessibility tree asserting the last programme level of a
           receiver that is now switched off: the next `setLevel(0)` early-returns
           because the target is already zero, so the stale number stood for as
           long as the set was off. The needle was right and the number was not,
           which is the same lie in a different medium. */
        publishValue(0);
        if (prefersReducedMotion()) {
          pos = 0;
          vel = 0;
          apply(true);
        } else {
          wake();
        }
      }
    },
    destroy() {
      ro.disconnect();
      unwatchAttention();
      if (raf) cancelAnimationFrame(raf);
    },
  };
}

/* ------------------------------------------------------------------------- */

function buildDefs(): SVGElement {
  return svg('defs', {}, [
    /* The spread pass is masked by a disc at the band's OUTER radius, so ink
       can only bloom inward. */
    svg('mask', { id: 'wf-band-mask' }, [
      svg('circle', {
        cx: String(PIVOT_X),
        cy: String(PIVOT_Y),
        r: String(R_BAND + BAND_W / 2),
        fill: '#fff',
      }),
    ]),
    svg('radialGradient', { id: 'wf-meter-paper', cx: '0.26', cy: '0.06', r: '1.15' }, [
      svg('stop', { offset: '0', 'stop-color': '#f6efdb' }),
      svg('stop', { offset: '0.42', 'stop-color': '#eae0c6' }),
      svg('stop', { offset: '0.78', 'stop-color': '#d9ceae' }),
      svg('stop', { offset: '1', 'stop-color': '#c4b795' }),
    ]),
    /* userSpaceOnUse, not the default objectBoundingBox: the needle's bbox is
       two units wide, so a proportional filter region clips a 1 px blur to
       nothing and the shadow silently disappears. */
    svg(
      'filter',
      {
        id: 'wf-needle-shadow',
        filterUnits: 'userSpaceOnUse',
        x: '-20',
        y: '-20',
        width: '240',
        height: '160',
      },
      [svg('feGaussianBlur', { stdDeviation: '1.15' })],
    ),
  ]);
}

/** The paper: a warm radial ground with the fibre pass multiplied over it. */
function buildPaper(): SVGElement[] {
  return [
    svg('rect', { class: 'meter__paper', x: '0', y: '0', width: '200', height: '118' }),
    svg('rect', {
      class: 'meter__fibre',
      x: '0',
      y: '0',
      width: '200',
      height: '118',
      filter: 'url(#wf-paper)',
    }),
  ];
}

function buildBoss(): SVGElement[] {
  // Pivot boss: a turned cap holding the needle down, with a dark centre pin.
  return [
    svg('circle', {
      class: 'meter__boss-shadow',
      cx: String(PIVOT_X + 0.7),
      cy: String(PIVOT_Y + 0.9),
      r: '5.6',
    }),
    svg('circle', { class: 'meter__boss', cx: String(PIVOT_X), cy: String(PIVOT_Y), r: '5' }),
    svg('circle', {
      class: 'meter__boss-hi',
      cx: String(PIVOT_X - 1.4),
      cy: String(PIVOT_Y - 1.6),
      r: '1.9',
    }),
    svg('circle', { class: 'meter__boss-pin', cx: String(PIVOT_X), cy: String(PIVOT_Y), r: '1.15' }),
  ];
}

function buildNeedle(plan: MeterPlan): SVGElement {
  const nb = plan.needleBaseVb;
  const nt = plan.needleTipVb;
  const blade =
    `${PIVOT_X - nb / 2},${PIVOT_Y + R_TAIL * 0.05} ` +
    `${PIVOT_X - nt / 2},${PIVOT_Y - R_NEEDLE} ` +
    `${PIVOT_X + nt / 2},${PIVOT_Y - R_NEEDLE} ` +
    `${PIVOT_X + nb / 2},${PIVOT_Y + R_TAIL * 0.05}`;
  // A counterweight tail behind the pivot — every moving-coil needle has one.
  const tail =
    `${PIVOT_X - nb * 0.62},${PIVOT_Y} ` +
    `${PIVOT_X + nb * 0.62},${PIVOT_Y} ` +
    `${PIVOT_X + nb * 0.34},${PIVOT_Y + R_TAIL} ` +
    `${PIVOT_X - nb * 0.34},${PIVOT_Y + R_TAIL}`;

  return svg('g', { class: 'meter__needle-group' }, [
    svg('g', { class: 'meter__needle-shadow' }, [
      svg('polygon', { points: blade }),
      svg('polygon', { points: tail }),
    ]),
    svg('polygon', { class: 'meter__needle', points: tail }),
    svg('polygon', { class: 'meter__needle', points: blade }),
    // the blade's lit upper-left edge — one light, upper left
    svg('line', {
      class: 'meter__needle-lit',
      x1: String(PIVOT_X - nb / 2 + nb * 0.16),
      y1: String(PIVOT_Y),
      x2: String(PIVOT_X - nt / 2 + nt * 0.2),
      y2: String(PIVOT_Y - R_NEEDLE + 1.2),
      'stroke-width': (nt * 0.42).toFixed(3),
    }),
  ]);
}

function buildPrinted(plan: MeterPlan): SVGElement {
  const kids: SVGElement[] = [];

  // --- the coloured band, three passes ---------------------------------------
  const zones: [string, number, number][] = [
    ['red', 0, ZONE_RED_END],
    ['dim', ZONE_RED_END, ZONE_TEAL_START],
    ['teal', ZONE_TEAL_START, 1],
  ];
  for (const [k, a, b] of zones) {
    kids.push(
      svg('path', {
        class: `meter__band meter__band--${k} meter__band--spread`,
        d: arcPath(a, b, R_BAND),
        mask: 'url(#wf-band-mask)',
      }),
    );
  }
  for (const [k, a, b] of zones) {
    kids.push(svg('path', { class: `meter__band meter__band--${k}`, d: arcPath(a, b, R_BAND) }));
  }
  for (const [, a, b] of zones) {
    kids.push(svg('path', { class: 'meter__band meter__band--tooth', d: arcPath(a, b, R_BAND) }));
  }

  // --- the scale rule, then the graduations hanging off it --------------------
  kids.push(svg('path', { class: 'meter__rule', d: arcPath(0, 1, R_RULE) }));

  const divisions = 10;
  for (let i = 0; i <= divisions * plan.sub; i++) {
    const t = i / (divisions * plan.sub);
    const isDiv = i % plan.sub === 0;
    const [x1, y1] = at(t, isDiv ? R_TICK_OUT : R_MINOR_OUT);
    const [x2, y2] = at(t, R_RULE);
    kids.push(
      svg('line', {
        class: isDiv ? 'meter__tick meter__tick--major' : 'meter__tick',
        x1: x1.toFixed(2),
        y1: y1.toFixed(2),
        x2: x2.toFixed(2),
        y2: y2.toFixed(2),
        'stroke-width': (isDiv ? plan.tickMajorVb : plan.tickMinorVb).toFixed(3),
      }),
    );
  }

  // --- the zero datum: heavier, unnumbered. The needle rests here. -----------
  if (plan.showZeroDatum) {
    const [zx1, zy1] = at(0, R_TICK_OUT + 1.4);
    const [zx2, zy2] = at(0, R_RULE - 1.4);
    kids.push(
      svg('line', {
        class: 'meter__tick meter__datum',
        x1: zx1.toFixed(2),
        y1: zy1.toFixed(2),
        x2: zx2.toFixed(2),
        y2: zy2.toFixed(2),
        'stroke-width': (plan.tickMajorVb * 1.25).toFixed(3),
      }),
    );
  }

  /* --- numerals: 1..9 then 0 (= ten), as printed on the reference.
     Uncalibrated by design: the quantity is a product of a dB-mapped RMS and a
     unitless health term, so printing S-units would assert a calibration the
     engine cannot support. Ten relative divisions is honest, and the datum
     below `1` is the zero the needle actually rests on. */
  const labels = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
  for (let i = 0; i < labels.length; i++) {
    const t = (i + 1) / 10;
    const [tx, ty] = at(t, R_NUM);
    kids.push(
      svg(
        'text',
        {
          class: 'meter__num',
          x: tx.toFixed(2),
          y: (ty + plan.numeralVb * 0.36).toFixed(2),
          'font-size': plan.numeralVb.toFixed(2),
          // The numeral cut is squeezed 0.9 horizontally; scaling about the
          // origin would walk the glyph sideways, so translate it back.
          transform: `translate(${(tx * 0.1).toFixed(3)} 0) scale(0.9 1)`,
        },
        [labels[i]!],
      ),
    );
  }

  /* SVG `letter-spacing` adds a trailing track AFTER the last glyph, so a
     text-anchor:middle label sits half a track right of true centre. Pull it
     back by half the tracking. This applies anywhere a tracked SVG label is
     centred. */
  const TITLE_TRACK = 0.34;
  kids.push(
    svg(
      'text',
      {
        class: 'meter__title',
        x: String(PIVOT_X),
        y: '17.5',
        'font-size': plan.titleVb.toFixed(2),
        dx: (-plan.titleVb * TITLE_TRACK * 0.5).toFixed(2),
      },
      ['SIGNAL'],
    ),
  );
  if (plan.showModel) {
    kids.push(
      svg('text', { class: 'meter__mark', x: '12', y: '109', 'font-size': plan.markVb.toFixed(2) }, [
        'PSP-6800W',
      ]),
    );
  }
  if (plan.showSmallPrint) {
    // Where the reference prints BATT INDICATOR: what the instrument indicates.
    kids.push(
      svg(
        'text',
        {
          class: 'meter__mark meter__mark--r',
          x: '188',
          y: '109',
          'font-size': plan.markVb.toFixed(2),
        },
        ['LEVEL × LINK'],
      ),
    );
  }

  return svg('g', { class: 'meter__printed', filter: 'url(#wf-ink)' }, kids);
}

/** The movement's physical size range. Re-exported so the layout cannot exceed it. */
export { METER_W_MAX, METER_W_MIN };
