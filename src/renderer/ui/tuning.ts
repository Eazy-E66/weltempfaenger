/**
 * The tuning flywheel.
 *
 * A real MW/SW tuning knob on a set like this has a heavy brass flywheel behind
 * it. You do not position it; you throw it and it coasts, and as it slows the
 * detents start to bite and it drops into a channel. That behaviour is a
 * physical model here, not an easing curve:
 *
 *   - while dragging, position tracks the hand exactly and velocity is measured
 *     from the last few pointer samples;
 *   - on release the flywheel coasts under exponential drag;
 *   - below a threshold speed the nearest station's lock zone starts pulling,
 *     as a critically-damped spring, so the dial *falls into* a station rather
 *     than snapping to it;
 *   - `width` from `DialSlot` is the capture radius, so a popular station is
 *     genuinely easier to land on, exactly like a strong transmitter.
 *
 * The model owns dial *position*, which is an input, never playback truth. It
 * reports 'drag' continuously and 'commit' once, when the flywheel has settled.
 */

import type { DialSlot } from '../../shared/contracts';
import { clamp } from './dom';

const DRAG_PER_SEC = 3.1;        // exponential coast decay
const CAPTURE_SPEED = 0.55;      // below this, detents engage
const SPRING_K = 78;             // detent stiffness
const SPRING_C = 13;             // detent damping (near critical)
const SETTLE_POS = 0.00035;
const SETTLE_VEL = 0.0025;
const MAX_VELOCITY = 3.2;

export interface TuningListener {
  /** Position changed. Called at most once per frame. */
  onPosition(position: number, phase: 'drag' | 'commit'): void;
  /** The flywheel settled on (or nearest to) a slot. `undefined` = dead air. */
  onSettle(slot: DialSlot | undefined, position: number): void;
}

export class TuningModel {
  position = 0.5;
  velocity = 0;

  private slots: DialSlot[] = [];
  private raf = 0;
  private lastT = 0;
  private dragging = false;
  private samples: { t: number; p: number }[] = [];
  private reducedMotion = false;

  constructor(private readonly listener: TuningListener) {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.reducedMotion = mq.matches;
    mq.addEventListener('change', (e) => {
      this.reducedMotion = e.matches;
    });
  }

  setSlots(slots: DialSlot[]): void {
    this.slots = slots;
  }

  /** Host-driven position (preset recall, station change). Silent, no echo. */
  setPosition(position: number): void {
    this.stop();
    this.velocity = 0;
    this.position = clamp(position, 0, 1);
    this.listener.onPosition(this.position, 'commit');
  }

  /** True while the user's hand is on the control, or the wheel is still spinning. */
  get isLive(): boolean {
    return this.dragging || this.raf !== 0;
  }

  beginDrag(): void {
    this.stop();
    this.dragging = true;
    this.velocity = 0;
    this.samples = [{ t: performance.now(), p: this.position }];
  }

  /** `delta` is in position units (0..1 across the band). */
  dragBy(delta: number): void {
    if (!this.dragging) return;
    this.position = clamp(this.position + delta, 0, 1);
    const now = performance.now();
    this.samples.push({ t: now, p: this.position });
    while (this.samples.length > 6) this.samples.shift();
    this.listener.onPosition(this.position, 'drag');
  }

  endDrag(): void {
    if (!this.dragging) return;
    this.dragging = false;

    // Velocity from the pointer samples spanning the last ~90ms of the gesture.
    const now = performance.now();
    const recent = this.samples.filter((s) => now - s.t < 110);
    if (recent.length >= 2) {
      const a = recent[0];
      const b = recent[recent.length - 1];
      const dt = (b.t - a.t) / 1000;
      if (dt > 0.001) this.velocity = clamp((b.p - a.p) / dt, -MAX_VELOCITY, MAX_VELOCITY);
    }
    this.samples = [];

    if (this.reducedMotion) {
      // No coasting: go straight to the nearest lock zone.
      this.velocity = 0;
      const slot = this.nearestSlot(this.position);
      if (slot) this.position = slot.position;
      this.finish();
      return;
    }
    this.start();
  }

  /** A discrete step, from the keyboard or a mouse wheel. Coasts a little. */
  kick(delta: number): void {
    this.stop();
    this.position = clamp(this.position + delta, 0, 1);
    this.listener.onPosition(this.position, 'drag');
    this.start();
  }

  destroy(): void {
    this.stop();
  }

  // -------------------------------------------------------------------------

  private start(): void {
    if (this.raf) return;
    this.lastT = performance.now();
    const tick = () => {
      const now = performance.now();
      const dt = Math.min(0.05, (now - this.lastT) / 1000);
      this.lastT = now;
      this.raf = 0;
      if (this.integrate(dt)) {
        this.listener.onPosition(this.position, 'drag');
        this.raf = requestAnimationFrame(tick);
      } else {
        this.finish();
      }
    };
    this.raf = requestAnimationFrame(tick);
  }

  private stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private finish(): void {
    this.velocity = 0;
    this.listener.onPosition(this.position, 'commit');
    this.listener.onSettle(this.slotAt(this.position), this.position);
  }

  /** One physics step. Returns false once the wheel has come to rest. */
  private integrate(dt: number): boolean {
    let v = this.velocity;
    let p = this.position;

    // Coast.
    v *= Math.exp(-DRAG_PER_SEC * dt);

    // Detents bite only once the wheel is slow enough for them to catch.
    if (Math.abs(v) < CAPTURE_SPEED) {
      const slot = this.nearestSlot(p);
      if (slot) {
        const dx = slot.position - p;
        v += (SPRING_K * dx - SPRING_C * v) * dt;
      }
    }

    p = clamp(p + v * dt, 0, 1);
    if (p === 0 || p === 1) v = 0; // the drum hits its end stop

    this.velocity = v;
    this.position = p;

    if (Math.abs(v) < SETTLE_VEL) {
      const slot = this.nearestSlot(p);
      const dx = slot ? Math.abs(slot.position - p) : 0;
      if (!slot || dx < SETTLE_POS) return false;
    }
    return true;
  }

  /** Nearest slot whose lock zone contains (or nearly contains) `p`. */
  private nearestSlot(p: number): DialSlot | undefined {
    let best: DialSlot | undefined;
    let bestD = Infinity;
    for (const slot of this.slots) {
      const d = Math.abs(slot.position - p);
      // The lock zone reaches a little beyond the printed width — that overhang
      // is what makes the dial feel magnetic rather than sticky.
      if (d > slot.width * 1.35) continue;
      if (d < bestD) {
        bestD = d;
        best = slot;
      }
    }
    return best;
  }

  /** The slot the pointer is actually inside, if any. */
  slotAt(p: number): DialSlot | undefined {
    let best: DialSlot | undefined;
    let bestD = Infinity;
    for (const slot of this.slots) {
      const d = Math.abs(slot.position - p);
      if (d > slot.width) continue;
      if (d < bestD) {
        bestD = d;
        best = slot;
      }
    }
    return best;
  }
}
