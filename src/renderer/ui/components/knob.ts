/**
 * The knurled knob.
 *
 * Built once, driven imperatively. Two things rotate (the knurl grooves and the
 * index line); everything else — the cylindrical shading, the chrome band, the
 * specular on the cap — stays fixed in world space, because the room's light
 * does not turn when you turn a knob. Getting that split right is most of what
 * makes it read as a machined part instead of a spinning graphic.
 *
 * Geometry lives in a 0..100 viewBox so one CSS variable resizes the whole
 * assembly — knob, scale arc, numerals — with no relayout maths.
 */

import { clamp, draggable, el, remap, setAttr, svg } from '../dom';
import { mountBezel, mountKnurl, setKnurlAngle, warmKnurl } from '../materials';

export type KnobScale =
  | { kind: 'none' }
  | { kind: 'minmax'; minLabel: string; maxLabel: string }
  | { kind: 'numeric'; from: number; to: number; ticks: number }
  | { kind: 'centered'; minLabel: string; midLabel: string; maxLabel: string };

export interface KnobOptions {
  label: string;
  ariaLabel?: string;
  min: number;
  max: number;
  value: number;
  /** Keyboard/wheel increment. */
  step: number;
  /** Total rotation, degrees. 300 is the receiver's house standard. */
  sweep?: number;
  scale?: KnobScale;
  /** Teal reference mark at this fraction of the sweep, as silkscreened. */
  tealTickAt?: number;
  cap?: 'none' | 'chrome' | 'wide-chrome';
  /** Knurl pitch. Fine for tone controls, coarse for the tuning flywheel. */
  knurl?: 'fine' | 'coarse';
  /** Rendered under the knob when the caller wants a live value shown. */
  readout?: boolean;
  format?(value: number): string;
  onInput(value: number, phase: 'drag' | 'commit'): void;
}

export interface KnobHandle {
  root: HTMLElement;
  /** Display a value handed down from the host. Never call this from onInput. */
  setValue(value: number): void;
  setReadout(text: string): void;
  setDisabled(disabled: boolean): void;
  destroy(): void;
}

export function createKnob(opts: KnobOptions): KnobHandle {
  const sweep = opts.sweep ?? 300;
  const half = sweep / 2;
  const format = opts.format ?? ((v: number) => String(Math.round(v)));

  const scaleSvg = buildScale(opts, sweep);

  /* The knurl does NOT rotate.
   *
   * A knurled cylinder turning under a fixed lamp does not carry its highlights
   * round with it — the metal moves, the light stays put — and rotating a
   * pre-lit layer is exactly the tell that gives a spinning graphic away. So
   * the sprite is baked over one tooth period and the knob selects a phase: an
   * N-tooth knurl is N-fold symmetric, so four sprites cover the whole travel
   * exactly, and turning it costs one drawImage rather than a re-render.
   *
   * The tooth count comes off the sprite's pixel size, not off an angle. See
   * materials.ts — the old `repeating-conic-gradient` at 2.2° was asking a
   * 56 px knob for 164 teeth of half a device pixel each, which no rasteriser
   * can resolve and a conic gradient cannot antialias. */
  const knurl = el('canvas', {
    class: `knob__knurl mx-knurl${opts.knurl === 'coarse' ? ' knob__knurl--coarse' : ''}`,
    'aria-hidden': 'true',
  });
  const indexRotor = el('div', { class: 'knob__rotor' }, [el('div', { class: 'knob__index' })]);
  /* The polished chrome band around the upper edge. Polished, not knurled —
     giving a smooth band teeth produced blotches. */
  const band =
    opts.knurl === 'coarse' ? null : el('canvas', { class: 'knob__band', 'aria-hidden': 'true' });

  const knob = el(
    'div',
    {
      class: `knob knob--${opts.cap ?? 'none'}`,
      role: 'slider',
      tabindex: '0',
      'aria-label': opts.ariaLabel ?? opts.label,
      'aria-valuemin': String(opts.min),
      'aria-valuemax': String(opts.max),
      'aria-valuenow': String(opts.value),
    },
    [
      el('div', { class: 'knob__body' }),
      knurl,
      band,
      el('div', { class: 'knob__shade' }),
      el('div', { class: 'knob__face' }),
      indexRotor,
      opts.cap && opts.cap !== 'none' ? el('div', { class: 'knob__cap mat-chrome' }) : null,
      el('div', { class: 'knob__gloss' }),
    ],
  );

  mountKnurl(knurl, opts.knurl === 'coarse');
  knob.addEventListener('pointerdown', () => warmKnurl(knurl));

  const readout = opts.readout ? el('div', { class: 'knob-readout' }, [format(opts.value)]) : null;

  const root = el('div', { class: 'knob-unit' }, [
    el('div', { class: 'knob-stage' }, [scaleSvg, knob]),
    el('span', { class: 'silk knob-label' }, [opts.label]),
    readout,
  ]);

  if (band) {
    /* THE PLATED BAND ROUND THE UPPER EDGE.
     *
     * The reference's tone knobs are a black knurled cylinder with a polished
     * chrome band at the top, and the band is the only bright thing on the
     * part. At `r0: 0.86` it was 2.9 px wide on a 41 px knob — below the width
     * at which a specular arc can exist — and `smooth: true` additionally sent
     * it 70% of the way into `bezelSprite`'s dim below-Nyquist fallback, so
     * what actually shipped was a barely-visible grey edge. It needs real
     * width and real polish: a near-mirror is mostly a picture of the room.
     */
    requestAnimationFrame(() => {
      const d = Math.round(knob.getBoundingClientRect().width);
      if (d >= 8) {
        mountBezel(band, d, {
          r0: 0.53,
          r1: 0.73,
          smooth: true,
          polish: 2.1,
          tilt0: 0.16,
          tilt1: 0.78,
        });
      }
    });
  }

  let value = opts.value;
  let disabled = false;

  const applyAngle = () => {
    const t = remap(value, opts.min, opts.max, 0, 1);
    const deg = -half + t * sweep;
    // The index mark is painted ON the knob, so it turns. The knurl is metal
    // under a fixed lamp, so it changes phase instead.
    indexRotor.style.transform = `rotate(${deg.toFixed(2)}deg)`;
    setKnurlAngle(knurl, deg);
  };

  const announce = () => {
    setAttr(knob, 'aria-valuenow', value.toFixed(3));
    setAttr(knob, 'aria-valuetext', format(value));
    if (readout) readout.textContent = format(value);
  };

  const commit = (next: number, phase: 'drag' | 'commit') => {
    const clamped = clamp(next, opts.min, opts.max);
    if (clamped === value && phase === 'drag') return;
    value = clamped;
    applyAngle();
    announce();
    opts.onInput(value, phase);
  };

  /* Vertical drag is the precise gesture on a small knob — the hand is already
     resting, and it does not fight the pointer's angular ambiguity near the
     centre. 170px of travel covers the full sweep; Shift divides by five. */
  const range = opts.max - opts.min;
  const stopDrag = draggable(knob, {
    onMove(_dx, dy, ev) {
      if (disabled) return;
      const gain = ev.shiftKey ? 0.2 : 1;
      commit(value - (dy / 170) * range * gain, 'drag');
    },
    onEnd() {
      if (disabled) return;
      opts.onInput(value, 'commit');
    },
  });

  const onWheel = (ev: WheelEvent) => {
    if (disabled) return;
    ev.preventDefault();
    const dir = ev.deltaY > 0 ? -1 : 1;
    commit(value + dir * opts.step * (ev.shiftKey ? 0.2 : 1), 'commit');
  };

  const onKey = (ev: KeyboardEvent) => {
    if (disabled) return;
    const big = opts.step * 5;
    let next: number | null = null;
    switch (ev.key) {
      case 'ArrowUp':
      case 'ArrowRight':
        next = value + (ev.shiftKey ? opts.step * 0.2 : opts.step);
        break;
      case 'ArrowDown':
      case 'ArrowLeft':
        next = value - (ev.shiftKey ? opts.step * 0.2 : opts.step);
        break;
      case 'PageUp':
        next = value + big;
        break;
      case 'PageDown':
        next = value - big;
        break;
      case 'Home':
        next = opts.min;
        break;
      case 'End':
        next = opts.max;
        break;
      default:
        return;
    }
    ev.preventDefault();
    commit(next, 'commit');
  };

  knob.addEventListener('wheel', onWheel, { passive: false });
  knob.addEventListener('keydown', onKey);

  applyAngle();
  announce();

  return {
    root,
    setValue(next: number) {
      const clamped = clamp(next, opts.min, opts.max);
      if (clamped === value) return;
      value = clamped;
      applyAngle();
      announce();
    },
    setReadout(text: string) {
      if (readout) readout.textContent = text;
    },
    setDisabled(next: boolean) {
      disabled = next;
      knob.classList.toggle('is-disabled', next);
      knob.setAttribute('aria-disabled', String(next));
      knob.setAttribute('tabindex', next ? '-1' : '0');
    },
    destroy() {
      stopDrag();
      knob.removeEventListener('wheel', onWheel);
      knob.removeEventListener('keydown', onKey);
    },
  };
}

/* ---------------------------------------------------------------------------
   The printed scale arc.

   Ticks and numerals are silkscreened on the panel around the knob, not on the
   knob, so they do not move. Numerals sit at the tick's outer end, rotated to
   stay upright (printed labels on the ICF-6800W are horizontal, not radial).
   ------------------------------------------------------------------------- */

function buildScale(opts: KnobOptions, sweep: number): SVGSVGElement {
  const scale = opts.scale ?? { kind: 'none' as const };
  const cx = 50;
  const cy = 50;
  /* The arc sits further out than it did, because the knob under it is larger:
     the flutes and the plated band have to be several device pixels wide to be
     anything at all, and on a 41 px knob they were not. Ticks still clear the
     body — 38.5 against a 36-unit knob radius. */
  const rTick = 44;
  const rTickIn = 38.5;
  const rTickInMinor = 40.8;
  const rText = 48.6;
  const half = sweep / 2;

  const kids: SVGElement[] = [];

  const angleAt = (t: number) => (-half + t * sweep - 90) * (Math.PI / 180);
  const pt = (t: number, r: number) => {
    const a = angleAt(t);
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r] as const;
  };

  const tick = (t: number, major: boolean, teal = false) => {
    const [x1, y1] = pt(t, rTick);
    const [x2, y2] = pt(t, major ? rTickIn : rTickInMinor);
    kids.push(
      svg('line', {
        x1: x1.toFixed(2),
        y1: y1.toFixed(2),
        x2: x2.toFixed(2),
        y2: y2.toFixed(2),
        class: teal ? 'kscale__tick kscale__tick--teal' : `kscale__tick${major ? ' kscale__tick--major' : ''}`,
      }),
    );
  };

  const text = (t: number, label: string, cls = '') => {
    const [x, y] = pt(t, rText);
    kids.push(
      svg('text', { x: x.toFixed(2), y: (y + 2.6).toFixed(2), class: `kscale__num ${cls}` }, [label]),
    );
  };

  if (scale.kind === 'numeric') {
    const n = scale.ticks;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const major = i % 2 === 0;
      tick(t, major);
      if (major) {
        const v = scale.from + (scale.to - scale.from) * t;
        text(t, String(Math.round(v)));
      }
    }
  } else if (scale.kind === 'minmax') {
    for (let i = 0; i <= 10; i++) tick(i / 10, i % 5 === 0);
    text(0, scale.minLabel, 'kscale__num--end');
    text(1, scale.maxLabel, 'kscale__num--end');
  } else if (scale.kind === 'centered') {
    /* Twelve divisions, majors every third: on a ±12 dB control that is one
       graduation per 2 dB and a heavy mark per 6, which is a scale a hand can
       actually count against. Eight was sparse enough that with the ink at
       1.1:1 on aluminium the tone knobs read as having no scale at all — the
       ink is fixed in materials.css §9, and this is the graduation that ink
       now has to print. */
    for (let i = 0; i <= 12; i++) tick(i / 12, i % 3 === 0);
    text(0, scale.minLabel, 'kscale__num--end');
    text(0.5, scale.midLabel, 'kscale__num--end');
    text(1, scale.maxLabel, 'kscale__num--end');
  }

  if (opts.tealTickAt !== undefined) tick(opts.tealTickAt, true, true);

  return svg(
    'svg',
    { class: 'kscale', viewBox: '0 0 100 100', 'aria-hidden': 'true', focusable: 'false' },
    kids,
  );
}
