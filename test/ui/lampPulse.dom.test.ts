// @vitest-environment jsdom
/**
 * A pulsing lamp has an end.
 *
 * `.mini-lamp.is-pulsing` animates `opacity` at frame rate, and the mini-lamps
 * sit inside the faceplate's blended material stack — `isolation: isolate`
 * groups with `mix-blend-mode` layers over them. An animation inside such a
 * group cannot be promoted to a compositor layer of its own: the group is
 * re-blended, and therefore re-rastered, on every frame the animation asks for.
 *
 * Measured on the shipping build under Xephyr, in standby, n=3 x 10 s, from
 * per-process `utime+stime` in /proc:
 *
 *   nothing pulsing ................. 0.70% of a core (gpu 0.00, renderer 0.07)
 *   ONE .mini-lamp pulsing ......... 94.94% of a core (gpu 83.89, renderer 10.73)
 *
 * Ninety-four points of a core for one 9 px dot, indefinitely, and it is
 * reachable by ordinary use: cut a scope that yields no stations, leave the
 * notice standing, walk away. Promotion does not rescue it — `will-change:
 * opacity` measured 96.29, `contain: strict` + `isolation: isolate` 94.86, and
 * animating `transform` instead of `opacity` 96.75. Only stopping works.
 *
 * So the pulse is a gesture with a beginning and an end, and these pin both
 * ends of it. What must NOT be lost is the affordance: the lamp stays LIT for
 * exactly as long as its condition holds, which is the part that carries the
 * meaning, and every fresh call for the eye pulses again.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attentionLamp, PULSE_MS } from '../../src/renderer/ui/index';
import { createButton, type ButtonHandle } from '../../src/renderer/ui/components/parts';

function lampOf(btn: ButtonHandle): HTMLElement {
  const lamp = btn.root.querySelector('.mini-lamp');
  if (!(lamp instanceof HTMLElement)) throw new Error('the button has no lamp');
  return lamp;
}

describe('the attention pulse', () => {
  let btn: ButtonHandle;
  let lamp: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    btn = createButton({ label: 'Stations', lamp: 'amber', onPress: () => {} });
    document.body.append(btn.root);
    lamp = lampOf(btn);
  });

  afterEach(() => {
    btn.root.remove();
    vi.useRealTimers();
  });

  it('pulses when the panel starts asking for the eye', () => {
    const l = attentionLamp(btn);
    l.set(true, true);
    expect(lamp.classList.contains('is-on')).toBe(true);
    expect(lamp.classList.contains('is-pulsing')).toBe(true);
    l.destroy();
  });

  it('stops pulsing after a few cycles and holds lit', () => {
    const l = attentionLamp(btn);
    l.set(true, true);

    vi.advanceTimersByTime(PULSE_MS - 1);
    expect(lamp.classList.contains('is-pulsing')).toBe(true);

    vi.advanceTimersByTime(2);
    expect(lamp.classList.contains('is-pulsing')).toBe(false);
    // The affordance is not taken away: the lamp is still lit, because the
    // condition it reports is still true.
    expect(lamp.classList.contains('is-on')).toBe(true);
    l.destroy();
  });

  it('never re-arms itself while the condition simply goes on being true', () => {
    // `render` runs at frame rate, so the calling condition is re-asserted
    // sixty times a second. That may not restart the gesture — this is exactly
    // how a bounded pulse turns back into an unbounded one.
    const l = attentionLamp(btn);
    l.set(true, true);
    vi.advanceTimersByTime(PULSE_MS + 50);
    expect(lamp.classList.contains('is-pulsing')).toBe(false);

    for (let frame = 0; frame < 600; frame++) {
      l.set(true, true);
      vi.advanceTimersByTime(16);
    }

    expect(lamp.classList.contains('is-pulsing')).toBe(false);
    expect(lamp.classList.contains('is-on')).toBe(true);
    l.destroy();
  });

  it('pulses again on a fresh call for the eye', () => {
    // A new fault, a new re-lock attempt, a new "nothing on the dial": each one
    // is a new thing to say, and gets its own gesture.
    const l = attentionLamp(btn);
    l.set(true, true);
    vi.advanceTimersByTime(PULSE_MS + 50);
    expect(lamp.classList.contains('is-pulsing')).toBe(false);

    l.set(true, false);
    l.set(true, true);
    expect(lamp.classList.contains('is-pulsing')).toBe(true);

    vi.advanceTimersByTime(PULSE_MS + 50);
    expect(lamp.classList.contains('is-pulsing')).toBe(false);
    l.destroy();
  });

  it('drops the pulse the moment the panel stops asking, mid-gesture', () => {
    const l = attentionLamp(btn);
    l.set(true, true);
    vi.advanceTimersByTime(500);
    expect(lamp.classList.contains('is-pulsing')).toBe(true);

    l.set(true, false);
    expect(lamp.classList.contains('is-pulsing')).toBe(false);

    // And the abandoned timer cannot come back to touch the lamp later.
    vi.advanceTimersByTime(PULSE_MS * 2);
    expect(lamp.classList.contains('is-pulsing')).toBe(false);
    l.destroy();
  });

  it('passes the lit state straight through, pulse or no pulse', () => {
    const l = attentionLamp(btn);
    l.set(false, false);
    expect(lamp.classList.contains('is-on')).toBe(false);

    l.set(true, true);
    expect(lamp.classList.contains('is-on')).toBe(true);

    // The condition went away while the gesture was still running.
    l.set(false, false);
    expect(lamp.classList.contains('is-on')).toBe(false);
    expect(lamp.classList.contains('is-pulsing')).toBe(false);
    l.destroy();
  });

  it('leaves nothing pulsing and no timer standing after destroy()', () => {
    const l = attentionLamp(btn);
    l.set(true, true);
    l.destroy();

    vi.advanceTimersByTime(PULSE_MS * 3);
    // Whatever the classes say, no callback may fire against a torn-down panel.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds the gesture to a handful of cycles, not a minute of them', () => {
    // The keyframe is 1.1 s. A pulse long enough to be a nag is the defect.
    expect(PULSE_MS).toBeGreaterThanOrEqual(2_200);
    expect(PULSE_MS).toBeLessThanOrEqual(8_000);
  });
});
