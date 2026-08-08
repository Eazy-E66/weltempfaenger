/**
 * The MW/SW TUNING knob — the largest control on the panel and the emotional
 * centre of the product.
 *
 * It is an angular control, not a slider: you push the rim round, and where a
 * small knob would use vertical travel this one reads the true angle under your
 * hand, because that is how you actually spin a flywheel. One revolution moves
 * a fixed fraction of the band, so a wide band takes many turns — which is what
 * makes it feel geared to something heavy rather than mapped to a scrollbar.
 *
 * Momentum lives in TuningModel; this view just keeps the knob's rotation
 * locked to the model's position, so the wheel visibly keeps spinning after the
 * hand lets go and slows into a detent.
 */

import type { Band } from '../../../shared/contracts';
import { el, setFlag, setText } from '../dom';
import { mountDisc, mountKnurl, setKnurlAngle, warmKnurl } from '../materials';
import type { TuningModel } from '../tuning';
import { displayStationName } from '../stationName';

/** Band travelled per full revolution. 0.17 ≈ six turns end to end. */
const BAND_PER_TURN = 0.17;
const FINE_GAIN = 0.22;
/** How long the label holds its refusal before going back to the locked legend. */
const REFUSE_MS = 2200;

export interface TuningKnobHandle {
  root: HTMLElement;
  /** Sync the knob's visible rotation to the model. */
  sync(): void;
  /**
   * What the drum is printed with.
   *
   * The knob needs this for two things it could not previously do: know whether
   * it has a job at all (Law 1 — an empty drum is a shaft with nothing behind
   * it), and say *where it is* rather than reporting a bare `aria-valuenow` of
   * `0.368`. The drum canvas prints every station name and is
   * `aria-hidden="true"`, so this slider is the only text equivalent a screen
   * reader has for the whole dial.
   */
  setBand(band: Band): void;
  /**
   * Answer a hand that tried to turn a locked shaft.
   *
   * Public because the *drum* scrubs the same flywheel, so a refusal has to be
   * expressible from the chassis when the gesture landed on the other control.
   */
  refuse(): void;
  destroy(): void;
}

/**
 * What the slider says out loud about where the dial is.
 *
 * Pure and exported because it is the accessible name of the biggest control on
 * the panel and the only text equivalent the drum has, and neither of those is
 * checkable from a screenshot.
 */
export function dialValueText(band: Band | null, position: number, stationName?: string): string {
  if (!band || band.slots.length === 0) return 'no band cut';
  const scale = band.scaleMin + position * (band.scaleMax - band.scaleMin);
  // Grouped like the printed scale, so a reader hears "nine thousand seven
  // hundred and five" rather than a run of digits.
  const figure = band.scaleUnit === 'kHz' ? Math.round(scale).toLocaleString('en-GB') : scale.toFixed(2);
  const meterBand = (band.scaleLabel ?? '').trim();
  const where = meterBand ? `${meterBand}, ${figure} ${band.scaleUnit}` : `${figure} ${band.scaleUnit}`;
  return stationName ? `${where}, ${displayStationName(stationName, 40)}` : `${where}, between stations`;
}

export function createTuningKnob(model: TuningModel, onLocked: () => void = () => {}): TuningKnobHandle {
  // Deep finger grooves under a fixed lamp: the metal turns, the light does
  // not. See knob.ts and materials.ts — the flywheel selects a sprite phase.
  const knurl = el('canvas', { class: 'knob__knurl mx-knurl', 'aria-hidden': 'true' });
  const grips = el('div', { class: 'tuning-knob__grips' });
  const rotor = el('div', { class: 'knob__rotor' }, [grips]);
  /* The wide polished centre disc. A spun cap carries CONCENTRIC micro-grooves,
     so its normal varies only radially and the specular smears tangentially
     into two opposed bright lobes with dark quadrants between them. That
     bow-tie is the signature of turned metal, and nothing a conic gradient plus
     a 1px `repeating-radial-gradient` can do gets near it — the latter is
     guaranteed to alias, being a one-pixel period. */
  const disc = el('canvas', { class: 'tuning-knob__disc', 'aria-hidden': 'true' });

  const knob = el(
    'div',
    {
      class: 'knob tuning-knob__knob knob--wide-chrome',
      role: 'slider',
      tabindex: '0',
      'aria-label': 'Tuning',
      'aria-valuemin': '0',
      'aria-valuemax': '1',
      'aria-valuenow': '0.5',
      'aria-orientation': 'horizontal',
    },
    [
      el('div', { class: 'knob__body tuning-knob__body' }),
      knurl,
      rotor,
      el('div', { class: 'knob__shade' }),
      disc,
      el('div', { class: 'knob__gloss' }),
    ],
  );

  mountKnurl(knurl, true);
  mountDisc(disc);
  knob.addEventListener('pointerdown', () => warmKnurl(knurl));

  /* The legend carries the lock, exactly as METER BAND's does. It is one line of
     silkscreen whose text length never changes between states, because this
     label sits in the flexible row of the panel grid and a legend that grew to
     two lines would re-run the whole faceplate's layout — and with it every
     material canvas on it. The *reason* goes to the annunciator, which is the
     surface that exists for saying why. */
  const label = el('span', { class: 'silk tuning-knob__label' }, ['MW / SW Tuning']);

  const root = el('div', { class: 'tuning-knob' }, [
    el('div', { class: 'tuning-knob__stage' }, [knob]),
    label,
  ]);

  let dragging = false;
  let lastAngle = 0;
  /** What is printed on the drum. `null` until the register throws something. */
  let band: Band | null = null;
  let refuseTimer = 0;

  /** Law 1: the shaft only has a job while the drum has something printed on it. */
  const live = (): boolean => !!band && band.slots.length > 0;

  /**
   * Turning a flywheel that has nothing to turn.
   *
   * The honest treatment of a control that is temporarily out of circuit is a
   * detent lock you can see, not a shaft that spins freely and swallows the
   * gesture — and this shaft did not merely swallow it, it *animated*: a real
   * four-turn drag wound the printed scale through 150 kHz with the pointer lit
   * and nothing on the panel changing. The legend flashes, restarted on every
   * attempt so the tenth looks different from the ninth, and the chassis is told
   * so the annunciator can say why.
   */
  const refuse = (): void => {
    label.classList.remove('is-refused');
    void label.offsetWidth; // restart the animation rather than let it run on
    label.classList.add('is-refused');
    window.clearTimeout(refuseTimer);
    refuseTimer = window.setTimeout(() => label.classList.remove('is-refused'), REFUSE_MS);
    onLocked();
  };

  const angleFrom = (ev: PointerEvent) => {
    const r = knob.getBoundingClientRect();
    return Math.atan2(ev.clientY - (r.top + r.height / 2), ev.clientX - (r.left + r.width / 2));
  };

  const sync = () => {
    const deg = (model.position / BAND_PER_TURN) * 360;
    // The eight scallops are moulded into the plastic, so they turn. The knurl
    // is metal under a fixed lamp, so it changes phase.
    rotor.style.transform = `rotate(${deg.toFixed(2)}deg)`;
    setKnurlAngle(knurl, deg);
    knob.setAttribute('aria-valuenow', model.position.toFixed(3));
    // A place, not a decimal. `model.slotAt` is the printed lock zone, which is
    // the same test the flywheel's detents use, so what this says is what the
    // dial would land on if the hand let go here.
    knob.setAttribute('aria-valuetext', dialValueText(band, model.position, model.slotAt(model.position)?.station.name));
  };

  /** Paint the locked/live treatment. Mirrors METER BAND's, deliberately. */
  const paintLock = () => {
    const inert = !live();
    setFlag(knob, 'is-disabled', inert);
    setFlag(root, 'is-inert', inert);
    setText(label, inert ? 'MW / SW Tuning · Empty' : 'MW / SW Tuning');
    knob.setAttribute('aria-disabled', String(inert));
    knob.setAttribute(
      'aria-label',
      inert ? 'Tuning — locked until the register cuts a band onto the drum' : 'Tuning',
    );
  };

  const onDown = (ev: PointerEvent) => {
    if (ev.button !== 0 && ev.pointerType === 'mouse') return;
    if (!live()) {
      // A hand on a locked shaft gets its answer immediately, not after it has
      // been turned far enough to earn a detent it is never going to reach.
      refuse();
      ev.preventDefault();
      return;
    }
    dragging = true;
    lastAngle = angleFrom(ev);
    knob.setPointerCapture(ev.pointerId);
    knob.classList.add('is-grabbed');
    model.beginDrag();
    ev.preventDefault();
  };

  const onMove = (ev: PointerEvent) => {
    if (!dragging) return;
    const a = angleFrom(ev);
    let d = a - lastAngle;
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    lastAngle = a;
    const turns = d / (2 * Math.PI);
    model.dragBy(turns * BAND_PER_TURN * (ev.shiftKey ? FINE_GAIN : 1));
  };

  const onUp = (ev: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    try {
      knob.releasePointerCapture(ev.pointerId);
    } catch {
      /* gone */
    }
    knob.classList.remove('is-grabbed');
    model.endDrag();
  };

  const onWheel = (ev: WheelEvent) => {
    ev.preventDefault();
    if (!live()) {
      refuse();
      return;
    }
    const dir = ev.deltaY > 0 ? 1 : -1;
    model.kick(dir * BAND_PER_TURN * 0.06 * (ev.shiftKey ? FINE_GAIN : 1));
  };

  const onKey = (ev: KeyboardEvent) => {
    const fine = ev.shiftKey ? FINE_GAIN : 1;
    let d = 0;
    switch (ev.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        d = BAND_PER_TURN * 0.05 * fine;
        break;
      case 'ArrowLeft':
      case 'ArrowDown':
        d = -BAND_PER_TURN * 0.05 * fine;
        break;
      case 'PageUp':
        d = BAND_PER_TURN * 0.4;
        break;
      case 'PageDown':
        d = -BAND_PER_TURN * 0.4;
        break;
      case 'Home':
      case 'End':
        if (!live()) break;
        model.setPosition(ev.key === 'Home' ? 0 : 1);
        ev.preventDefault();
        return;
      default:
        return;
    }
    ev.preventDefault();
    // Every key that would have moved a dial with nothing on it. The keyboard
    // path was the one the empty-dial defect was least visible on: no rim to
    // watch, so a silent no-op was indistinguishable from a dead keybinding.
    if (!live()) {
      refuse();
      return;
    }
    /* A KEY PRESS IS A DETENT, NOT A THROW.
     *
     * This used to be `model.kick(d)`, which is a throw: it moves the position
     * and then lets the flywheel physics settle it. The physics engage the
     * detent spring at any speed below CAPTURE_SPEED — and a kick starts at
     * zero velocity, so they engage on the very first frame — and the spring
     * pulls the dial back to `nearestSlot`, whose capture radius is
     * `slot.width * 1.35`. Lock zones on a real cut run 0.012–0.055 in dial
     * units, i.e. a capture radius of up to 0.074, against a key step of
     * 0.0085. So every arrow press after the first landed inside the zone it
     * had just fallen into and was pulled straight back onto the same station:
     * measured on the shipped build, ten consecutive Right presses left
     * `aria-valuenow` at 0.511 and `aria-valuetext` byte-identical.
     *
     * No step small enough to be a fine-tune can out-run that spring, so the
     * keyboard stops using it. `setPosition` is exact and has no physics
     * behind it, which makes ten presses ten distinct positions by
     * construction — and it is what Home/End (which always worked) already
     * used. The flywheel is still a flywheel under the hand and under the
     * wheel; it is the keyboard that is a row of detents, which is what a
     * keyboard is.
     */
    model.setPosition(model.position + d);
  };

  knob.addEventListener('pointerdown', onDown);
  knob.addEventListener('pointermove', onMove);
  knob.addEventListener('pointerup', onUp);
  knob.addEventListener('pointercancel', onUp);
  knob.addEventListener('wheel', onWheel, { passive: false });
  knob.addEventListener('keydown', onKey);

  paintLock();
  sync();

  return {
    root,
    sync,
    setBand(next) {
      band = next;
      paintLock();
      sync();
    },
    refuse,
    destroy() {
      window.clearTimeout(refuseTimer);
      knob.removeEventListener('pointerdown', onDown);
      knob.removeEventListener('pointermove', onMove);
      knob.removeEventListener('pointerup', onUp);
      knob.removeEventListener('pointercancel', onUp);
      knob.removeEventListener('wheel', onWheel);
      knob.removeEventListener('keydown', onKey);
    },
  };
}
