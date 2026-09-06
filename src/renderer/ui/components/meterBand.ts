/**
 * METER BAND — the SW BAND SELECTOR, finally doing its own job.
 *
 * On an ICF-6800W the band selector picks which megahertz segment the drum is
 * printed with; the big knob tunes kilohertz *within* it. Coarse stage, then
 * fine stage. The app used that shaft for a genre counter, which is not what
 * the control is: the category axis has moved wholesale into the register, and
 * a knob whose job has left must either take a real one or come off the panel.
 *
 * So it takes the reference's own job. The register cuts a scope, the scope is
 * laid across the twelve real shortwave broadcasting bands printed on the lid,
 * forty entries per band, and this knob picks the band. Twelve detents, twelve
 * printed numerals, and **never more** — whatever the directory does. Bands the
 * current cut did not fill are printed but unlit and unreachable: a mechanical
 * end stop you can see.
 *
 * Beside it sits the band plate, on the same backlit stock as the old genre
 * window, carrying what the register handed over.
 */

import { METER_BANDS } from '../../../main/tuning/bandLayout';
import { el, setFlag, setText, svg } from '../dom';
import type { AirState } from '../types';

/** Twelve positions round the shaft. */
const DETENT_DEG = 30;

/**
 * What the panel around this control is actually doing.
 *
 * The plate used to print `OPEN THE REGISTER` unconditionally whenever nothing
 * was cut — including while the register was standing open in the raised bay
 * directly above it, and including while audio was playing. An instrument that
 * instructs you to do the thing you have already done is worse than a blank
 * one, because it teaches you to stop reading it. So the hint is a function of
 * observed state, and the observations arrive here.
 *
 * `air` replaced a pair of booleans, `powered` and `onAir`. `powered` was never
 * read — a field with no job, which is Law 1 one layer in from the panel — and
 * `onAir` was derived from `isPowered(state) && !!state.station`, i.e. from
 * intent. Measured: this plate printed `PLAYING ONE STATION — CUT A BAND TO GET
 * A DIAL FULL OF THEM` simultaneously with `FAULT — HTTP … ANSWERED 404`, again
 * with `FAULT — HLS`, and right through a 67-second buffering freeze. The plate
 * may now only claim playback the engine actually reported.
 */
export interface BandContext {
  /** The register is legible right now — open, or raised in the bay. */
  registerVisible: boolean;
  /** The engine's own verdict on the one station in hand. Measured, per frame. */
  air: AirState;
  /**
   * The station list is still in flight. An empty drum during those seconds
   * is "nothing here YET", and the plate used to say `PRESS STATIONS, PICK A
   * SUBJECT` beside an annunciator saying `THE DIAL FILLS ON ITS OWN` — two
   * instructions on one panel, one of them about to be wrong.
   */
  warming: boolean;
}

export interface MeterBandHandle {
  root: HTMLElement;
  /**
   * What the register cut. `filled` is how many meter bands actually carry
   * entries; `index` is the one currently printed on the drum.
   */
  setCut(
    cut: { caption: string; quality: string; total: number; printed: number; filled: number; index: number } | null,
  ): void;
  /** Tell the plate what the rest of the panel is doing, so its hint is true. */
  setContext(context: BandContext): void;
  /** Fire the plate's lamp-strike: a new band has just been cut. */
  strike(): void;
  destroy(): void;
}

export function createMeterBand(onSelect: (index: number) => void): MeterBandHandle {
  const arc = buildBandArc();
  const knurl = el('div', { class: 'knob__knurl knurl' });
  const indexRotor = el('div', { class: 'knob__rotor' }, [el('div', { class: 'knob__index' })]);

  const knob = el('div', {
    class: 'knob knob--chrome',
    role: 'slider',
    tabindex: '0',
    'aria-label': 'Meter band selector',
    'aria-valuemin': '0',
    'aria-valuemax': '0',
    'aria-valuenow': '0',
  }, [
    el('div', { class: 'knob__body' }),
    el('div', { class: 'knob__rotor' }, [knurl]),
    el('div', { class: 'knob__shade' }),
    el('div', { class: 'knob__face' }),
    indexRotor,
    el('div', { class: 'knob__cap mat-chrome' }),
    el('div', { class: 'knob__gloss' }),
  ]);

  const plateScope = el('div', { class: 'plate__scope' }, ['NO BAND CUT']);
  const plateCount = el('span', { class: 'silk silk--xs' }, ['']);
  const plateQual = el('span', { class: 'silk silk--xs' }, ['']);
  const plateBand = el('span', { class: 'plate__band' }, ['—']);
  /**
   * The plain-words line. `NO BAND CUT` above it is the register's own
   * vocabulary and stays — that is what the machine calls this state, and the
   * register teaches the word. This line is the one a stranger reads, so it is
   * an instruction in ordinary English naming a control that is on the panel in
   * front of them.
   */
  const plateHint = el('span', { class: 'plate__hint silk silk--xs' }, ['']);
  const plateWindow = el('div', { class: 'genre__window plate__window recess' }, [
    el('div', { class: 'genre__window-face' }, [
      plateScope,
      plateHint,
      el('div', { class: 'plate__meta' }, [plateCount, plateQual, plateBand]),
    ]),
    el('div', { class: 'mat-glass' }),
  ]);

  const knobLabel = el('span', { class: 'silk knob-label' }, ['Meter Band']);
  const knobUnit = el('div', { class: 'knob-unit genre__unit' }, [
    el('div', { class: 'knob-stage' }, [arc, knob]),
    knobLabel,
  ]);

  const root = el('div', { class: 'genre' }, [
    el('span', { class: 'silk silk--lg silk-rule genre__title' }, ['Band · Cut By Register']),
    el('div', { class: 'genre__row' }, [knobUnit, plateWindow]),
  ]);

  let filled = 0;
  let position = 0;
  let angle = 0;
  let accum = 0;
  let cutCaption: string | null = null;
  let context: BandContext = { registerVisible: false, air: 'off', warming: false };
  let inertTimer = 0;

  const applyAngle = (): void => {
    const css = `rotate(${angle.toFixed(2)}deg)`;
    knurl.style.transform = css;
    indexRotor.style.transform = css;
  };

  /**
   * Law 1 says a control must have a real job. This one's job arrives with the
   * cut, so before a cut it genuinely has none — and the honest treatment of a
   * control that is temporarily out of circuit is a mechanical detent lock you
   * can see and feel, not a shaft that spins freely and swallows the gesture.
   * Turning it says why it will not turn.
   *
   * THE WORD IS NOT `LOCKED`.
   *
   * It was, and on a fresh install `METER BAND · LOCKED` and `MW / SW TUNING ·
   * LOCKED` both printed in maroon on a panel the user had owned for four
   * seconds. Read cold, that is not "this control has nothing to do yet", it is
   * *"you do not have the paid version"* — one first-time user said so in as
   * many words. A permission is the one thing this state is not: nothing is
   * withheld, there is simply nothing on the drum to select between, and the
   * remedy is one throw away behind a key on the same panel.
   *
   * So the legend describes the situation (`· EMPTY`) and this line says what
   * fills it. After the opening band lands on first launch — see `openingBand`
   * in host.ts — neither is normally reachable at all.
   */
  const refuse = (): void => {
    plateHint.classList.remove('is-refused');
    void plateHint.offsetWidth;
    plateHint.classList.add('is-refused');
    setText(plateHint, 'NOTHING IS ON THE DRUM YET — CUT A BAND AND THIS TURNS');
    window.clearTimeout(inertTimer);
    inertTimer = window.setTimeout(() => {
      plateHint.classList.remove('is-refused');
      paintHint();
    }, 2200);
  };

  const step = (n: number): void => {
    if (filled < 2) {
      refuse();
      return;
    }
    const next = Math.min(Math.max(position + n, 0), filled - 1);
    if (next === position) return;
    angle += (next - position) * DETENT_DEG;
    position = next;
    applyAngle();
    paintArc();
    onSelect(position);
  };

  function paintArc(): void {
    for (const node of Array.from(arc.querySelectorAll('[data-b]'))) {
      const i = Number(node.getAttribute('data-b'));
      const live = i < filled;
      node.classList.toggle(node.tagName === 'text' ? 'kscale__num--dead' : 'kscale__tick--dead', !live);
    }
    const inert = filled < 2;
    setFlag(knob, 'is-disabled', inert);
    // Legible, not merely faint. A 45% opacity black knob on a black panel is
    // not a state anyone reads, so the whole unit is flagged and the legend
    // under the shaft says the word out loud.
    setFlag(knobUnit, 'is-inert', inert);
    setText(knobLabel, inert ? 'Meter Band · Empty' : 'Meter Band');
    knob.setAttribute('aria-disabled', String(inert));
    knob.setAttribute('aria-valuemax', String(Math.max(0, filled - 1)));
    knob.setAttribute('aria-valuenow', String(position));
    knob.setAttribute(
      'aria-valuetext',
      filled ? `${METER_BANDS[position]?.label ?? '—'}, band ${position + 1} of ${filled}` : 'no band cut',
    );
    knob.setAttribute(
      'aria-label',
      inert
        ? 'Meter band selector — empty until a band is cut onto the drum'
        : 'Meter band selector',
    );
  }

  function paintHint(): void {
    const text = bandHint(context, cutCaption !== null);
    setText(plateHint, text);
    // Urging is for advice a listener should act on now. A station that is
    // playing needs none; a station that failed has the annunciator and the
    // fault lamp already shouting, and a third red thing is noise.
    setFlag(plateHint, 'is-urging', text !== '' && context.air !== 'on');
  }

  // --- gesture: detented rotation with hard end stops ----------------------
  let dragging = false;
  let lastAngle = 0;

  const angleFrom = (ev: PointerEvent): number => {
    const r = knob.getBoundingClientRect();
    return (Math.atan2(ev.clientY - (r.top + r.height / 2), ev.clientX - (r.left + r.width / 2)) * 180) / Math.PI;
  };
  const onDown = (ev: PointerEvent): void => {
    if (ev.button !== 0 && ev.pointerType === 'mouse') return;
    if (filled < 2) {
      // A hand on a locked shaft gets an answer immediately, not after it has
      // been turned far enough to earn a detent it is never going to reach.
      refuse();
      ev.preventDefault();
      return;
    }
    dragging = true;
    accum = 0;
    lastAngle = angleFrom(ev);
    knob.setPointerCapture(ev.pointerId);
    knob.classList.add('is-grabbed');
    ev.preventDefault();
  };
  const onMove = (ev: PointerEvent): void => {
    if (!dragging) return;
    const a = angleFrom(ev);
    let d = a - lastAngle;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    lastAngle = a;
    accum += d;
    while (accum >= DETENT_DEG) {
      accum -= DETENT_DEG;
      step(1);
    }
    while (accum <= -DETENT_DEG) {
      accum += DETENT_DEG;
      step(-1);
    }
  };
  const onUp = (ev: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    accum = 0;
    try {
      knob.releasePointerCapture(ev.pointerId);
    } catch {
      /* pointer already gone */
    }
    knob.classList.remove('is-grabbed');
  };
  const onWheel = (ev: WheelEvent): void => {
    ev.preventDefault();
    step(ev.deltaY > 0 ? 1 : -1);
  };
  const onKeyDown = (ev: KeyboardEvent): void => {
    switch (ev.key) {
      case 'ArrowUp':
      case 'ArrowRight':
        step(1);
        break;
      case 'ArrowDown':
      case 'ArrowLeft':
        step(-1);
        break;
      case 'Home':
        step(-position);
        break;
      case 'End':
        step(filled - 1 - position);
        break;
      default:
        return;
    }
    ev.preventDefault();
  };

  knob.addEventListener('pointerdown', onDown);
  knob.addEventListener('pointermove', onMove);
  knob.addEventListener('pointerup', onUp);
  knob.addEventListener('pointercancel', onUp);
  knob.addEventListener('wheel', onWheel, { passive: false });
  knob.addEventListener('keydown', onKeyDown);

  applyAngle();
  paintArc();
  paintHint();

  return {
    root,
    setCut(cut) {
      filled = cut ? Math.min(cut.filled, METER_BANDS.length) : 0;
      const next = cut ? Math.min(Math.max(cut.index, 0), Math.max(0, filled - 1)) : 0;
      if (next !== position) {
        angle += (next - position) * DETENT_DEG;
        position = next;
        applyAngle();
      }
      cutCaption = cut ? cut.caption : null;
      setText(plateScope, cut ? cut.caption : 'NO BAND CUT');
      // The drum holds 480; a wider scope was cut to its top 480 and the register
      // said so before the throw. The plate must not then print the scope's
      // size as though all of it were on the dial.
      setText(plateCount, cut ? (cut.printed < cut.total ? `${cut.printed} OF ${cut.total} STN` : `${cut.total} STN`) : '');
      setText(plateQual, cut ? cut.quality : '');
      setText(plateBand, cut && filled ? (METER_BANDS[position]?.label.replace(/\s/g, '') ?? '—') : '—');
      setFlag(plateWindow, 'is-uncut', !cut);
      window.clearTimeout(inertTimer);
      plateHint.classList.remove('is-refused');
      paintArc();
      paintHint();
    },

    setContext(next) {
      if (next.registerVisible === context.registerVisible && next.air === context.air) return;
      context = next;
      if (!plateHint.classList.contains('is-refused')) paintHint();
    },
    strike() {
      plateWindow.classList.remove('is-struck');
      // Force a reflow so the animation restarts on a re-cut of the same scope.
      void plateWindow.offsetWidth;
      plateWindow.classList.add('is-struck');
      window.setTimeout(() => plateWindow.classList.remove('is-struck'), 700);
    },
    destroy() {
      knob.removeEventListener('pointerdown', onDown);
      knob.removeEventListener('pointermove', onMove);
      knob.removeEventListener('pointerup', onUp);
      knob.removeEventListener('pointercancel', onUp);
      knob.removeEventListener('wheel', onWheel);
      knob.removeEventListener('keydown', onKeyDown);
    },
  };
}

/**
 * The plate's plain-words line, derived from what is really on screen.
 *
 * Pure and exported because the defect it fixes is a *content* defect and not a
 * rendering one: the plate printed `OPEN THE REGISTER` unconditionally, so it
 * said it while the register stood open in the bay directly above it and while
 * audio was playing. Order matters here — the station in hand wins over advice,
 * because a receiver that is doing something with a station has no business
 * sending anyone off to operate a card index, and a cut band needs no
 * instruction at all.
 *
 * The four station lines are the four things the engine can actually report
 * (`AirState`), and this is where the second half of the on-air defect lived:
 * `PLAYING ONE STATION` was printed for `resolving`, `connecting`, `buffering`,
 * `reconnecting` **and `error`**, because the input was "a station has been asked
 * for". A plate that says PLAYING beside the readout's own `FAULT — HTTP …
 * ANSWERED 404` is the display contradicting the engine in one glance, which is
 * the specific lie Law 2 exists to forbid.
 */
export function bandHint(context: BandContext, hasCut: boolean): string {
  if (hasCut) return '';
  switch (context.air) {
    case 'on':
      return 'PLAYING ONE STATION — CUT A BAND TO GET A DIAL FULL OF THEM';
    case 'trying':
      return 'TRYING ONE STATION — CUT A BAND TO GET A DIAL FULL OF THEM';
    case 'failed':
      // Names the control that re-tries it. None of the panel's fault text used
      // to name RECONNECT, which is on the faceplate for exactly this.
      return 'THAT STATION FAILED — PRESS RECONNECT, OR CUT A BAND FOR MORE';
    case 'off':
    default:
      if (context.warming) return 'STATION LIST COMING IN — THE DIAL FILLS ON ITS OWN';
      return context.registerVisible
        ? 'IN THE REGISTER ABOVE: PICK A SUBJECT, THEN THROW CUT BAND'
        : 'PRESS STATIONS, PICK A SUBJECT, THEN THROW CUT BAND';
  }
}

/** Twelve meter-band numerals printed round the shaft, as on the reference. */
function buildBandArc(): SVGSVGElement {
  const kids: SVGElement[] = [];
  for (let i = 0; i < METER_BANDS.length; i++) {
    const a = ((i * DETENT_DEG - 90) * Math.PI) / 180;
    const at = (r: number): [number, number] => [50 + Math.cos(a) * r, 50 + Math.sin(a) * r];
    const [x1, y1] = at(41);
    const [x2, y2] = at(35.5);
    kids.push(
      svg('line', {
        class: 'kscale__tick kscale__tick--major',
        'data-b': i,
        x1: x1.toFixed(2), y1: y1.toFixed(2), x2: x2.toFixed(2), y2: y2.toFixed(2),
      }),
    );
    const [tx, ty] = at(48);
    kids.push(
      svg('text', {
        class: 'kscale__num', 'data-b': i,
        x: tx.toFixed(2), y: (ty + 2.6).toFixed(2), style: 'font-size:7px',
      }, [METER_BANDS[i]!.label.replace(/\s*m$/, '')]),
    );
  }
  return svg('svg', { class: 'kscale', viewBox: '0 0 100 100', 'aria-hidden': 'true' }, kids);
}
