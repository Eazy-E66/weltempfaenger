/**
 * The density law.
 *
 * `ui/density.ts` is the one place the app decides how much ink goes on a
 * printed scale, and it is deliberately pure — no DOM, no canvas, text
 * measurement injected — precisely so it can be pinned down here rather than
 * judged from a screenshot.
 *
 * What the previous rule got wrong is worth stating, because these tests exist
 * to stop it coming back: `scaleSteps()` derived the graduation interval from
 * the band's TOTAL range, and never consulted how much of that band was
 * actually under the glass. The number of graduations you could see was
 * therefore driven by station count, not by the size of the instrument, and a
 * 1600 px drum printed six numerals.
 */

import { describe, expect, it } from 'vitest';
import {
  PITCH_MIN,
  PITCH_MAX,
  PITCH_TARGET,
  bestStep,
  drumPlan,
  meterPlan,
  typeRamp,
  METER_W_MAX,
  METER_W_MIN,
} from '../../src/renderer/ui/density';

/** A stand-in for canvas text metrics: Liberation Sans Narrow runs ~0.47em. */
const labelWidthOf = (text: string, px: number) => text.length * px * 0.47;

/** Medium wave, as the app lays it out: 531–1602 kHz, 1 kHz resolution. */
const MW = { range: 1071, resolution: 1, sample: 1602 };
/** FM: 87.5–108 MHz at 0.01 MHz, to prove the law is not tuned to one range. */
const SHORT = { range: 20.5, resolution: 0.01, sample: 108 };
/** The narrowest real allocation the app prints: 120 m, 2300–2495 kHz. */
const M120 = { range: 195, resolution: 1, sample: 2495 };

const plan = (w: number, h: number, band = MW, vf = 0.115) =>
  drumPlan({ w, h, range: band.range, resolution: band.resolution, vf, sample: band.sample, labelWidthOf });

/** The app's own drum height rule for a given width. */
const heightFor = (w: number) => Math.min(196, Math.max(86, w * 0.2));

describe('the 1/2/5 ladder', () => {
  it('picks the rung whose pitch lands nearest the target', () => {
    // 8 px target: at 4 px per unit a 2-unit step lands exactly on it.
    expect(bestStep(4, 0.001).step).toBeCloseTo(2, 6);
    expect(bestStep(4, 0.001).pitch).toBeCloseTo(8, 6);
  });

  it('never chooses a step finer than the scale can honestly claim', () => {
    // 40 px per kHz would "want" a 0.2 kHz graduation, but a kHz dial cannot
    // subdivide below 1 kHz, so the floor takes over and says so.
    const g = bestStep(40, 1);
    expect(g.step).toBe(1);
    expect(g.clamped).toBe(true);
  });

  it('errs open rather than tight, because closed-up ink reads as a grey band', () => {
    // A pxPerUnit where two rungs are equidistant from target in raw terms:
    // step 1 -> 6.4 px (1.6 under), step 2 -> 12.8 px (4.8 over). The
    // asymmetric penalty makes 1.6*1.6 = 2.56 win, so the tighter one is still
    // chosen here — but only because it is much closer.
    expect(bestStep(6.4, 0.001).pitch).toBeCloseTo(6.4, 6);
    // Whereas at 5.5 px/unit, step 1 is 5.5 (below PITCH_MIN, illegal) so the
    // rule must open up to 11 rather than print an unresolvable comb.
    expect(bestStep(5.5, 0.001).pitch).toBeCloseTo(11, 6);
  });

  it('never returns a pitch below the resolving limit', () => {
    for (let ppu = 0.2; ppu < 200; ppu *= 1.17) {
      const g = bestStep(ppu, 0.001);
      expect(g.pitch).toBeGreaterThanOrEqual(PITCH_MIN - 1e-9);
    }
  });
});

describe('the drum holds its graduation pitch across every window it can get', () => {
  it('keeps the minor pitch inside [PITCH_MIN, PITCH_MAX] from 200 to 4000 px', () => {
    for (let w = 200; w <= 4000; w += 37) {
      const p = plan(w, heightFor(w));
      expect(p.minorPitch).toBeGreaterThanOrEqual(PITCH_MIN - 1e-9);
      expect(p.minorPitch).toBeLessThanOrEqual(PITCH_MAX + 1e-9);
    }
  });

  it('holds it on a 20-unit band too, not just on medium wave', () => {
    for (let w = 200; w <= 4000; w += 53) {
      const p = plan(w, heightFor(w), SHORT, 0.115);
      expect(p.minorPitch).toBeGreaterThanOrEqual(PITCH_MIN - 1e-9);
      expect(p.minorPitch).toBeLessThanOrEqual(PITCH_MAX + 1e-9);
    }
  });

  it('sits near the target rather than merely inside the bounds', () => {
    const pitches: number[] = [];
    for (let w = 300; w <= 2400; w += 29) pitches.push(plan(w, heightFor(w)).minorPitch);
    const mean = pitches.reduce((a, b) => a + b, 0) / pitches.length;
    expect(mean).toBeGreaterThan(PITCH_TARGET - 2.2);
    expect(mean).toBeLessThan(PITCH_TARGET + 2.2);
  });
});

describe('a bigger dial prints more, never bigger', () => {
  it('grows the graduation count monotonically with width', () => {
    let last = -1;
    for (const w of [200, 260, 300, 350, 455, 520, 600, 800, 950, 1280, 1600, 1920, 2400, 3200]) {
      const n = plan(w, heightFor(w)).counts.minors;
      expect(n).toBeGreaterThanOrEqual(last);
      last = n;
    }
  });

  it('prints many more graduations at 1600 px than at 455 px', () => {
    const small = plan(455, heightFor(455)).counts.minors;
    const large = plan(1600, heightFor(1600)).counts.minors;
    expect(large / small).toBeGreaterThan(4);
  });

  it('steps the interval DOWN the ladder as the dial grows', () => {
    const steps = [260, 400, 600, 1000, 1600].map((w) => plan(w, heightFor(w)).minor);
    for (let i = 1; i < steps.length; i++) expect(steps[i]!).toBeLessThanOrEqual(steps[i - 1]!);
    // and it genuinely does step, rather than holding one interval throughout
    expect(new Set(steps).size).toBeGreaterThan(1);
  });

  it('freezes figure size above 1400 px — the anti-cartoon clause', () => {
    const a = plan(1450, 260).numeralPx;
    for (const w of [1600, 1920, 2400, 3200, 4000]) {
      expect(plan(w, 260).numeralPx).toBeCloseTo(a, 9);
    }
  });

  it('still grows the numeral COUNT above 1400 px', () => {
    const a = plan(1450, 260).counts.numerals;
    const b = plan(2400, 260).counts.numerals;
    expect(b).toBeGreaterThan(a);
  });

  it('never lets a numeral collide with its neighbour', () => {
    for (let w = 260; w <= 3200; w += 41) {
      const p = plan(w, heightFor(w));
      const widest = labelWidthOf('1602', p.numeralPx);
      expect(p.numeralPitch).toBeGreaterThanOrEqual(widest * 1.9 - 1e-6);
    }
  });
});

describe('the floor: below a certain size it is not an instrument', () => {
  it('prints no numerals below 260 px', () => {
    expect(plan(240, 86).rows.numerals).toBe(false);
    expect(plan(280, 86).rows.numerals).toBe(true);
  });

  it('drops station names when there is no height for them', () => {
    expect(plan(600, 70).rows.names).toBe(false);
    expect(plan(600, 120).rows.names).toBe(true);
  });

  it('drops the answering foot-tick row and the genre watermark by height', () => {
    expect(plan(600, 90).rows.foot).toBe(false);
    expect(plan(600, 120).rows.foot).toBe(true);
    expect(plan(600, 100).rows.genre).toBe(false);
    expect(plan(600, 120).rows.genre).toBe(true);
  });
});

describe('a band the window has outgrown says so rather than lying', () => {
  /* 120 m is 195 kHz wide and cannot be subdivided below 1 kHz. Past a certain
     window there is nothing left to give: the resolution floor is the bottom
     and the visible-fraction cap is the top. The law's answer is a bandspread
     dial — widely spaced honest graduations — and it reports that rather than
     engraving finer than the band can claim. */
  it('holds the pitch while it still can', () => {
    for (const w of [320, 455, 620, 800, 950]) {
      const p = plan(w, heightFor(w), M120);
      expect(p.minorPitch).toBeLessThanOrEqual(PITCH_MAX + 1e-9);
      expect(p.sparse).toBe(false);
    }
  });

  it('reports `sparse` once the resolution floor makes it impossible', () => {
    const p = plan(1600, 260, M120);
    expect(p.sparse).toBe(true);
    expect(p.minor).toBe(1); // never finer than the band can honestly claim
    expect(p.visible).toBeCloseTo(0.42, 6); // and it took all the drum it could
  });

  it('never subdivides below the declared resolution, sparse or not', () => {
    for (let w = 200; w <= 4000; w += 43) {
      expect(plan(w, heightFor(w), M120).minor).toBeGreaterThanOrEqual(1);
      expect(plan(w, heightFor(w), SHORT).minor).toBeGreaterThanOrEqual(0.01 - 1e-12);
    }
  });
});

describe('showing more drum is bounded', () => {
  it('never exceeds the visible-fraction cap however wide the window', () => {
    for (const w of [1600, 2400, 3200, 6000]) {
      expect(plan(w, 260).visible).toBeLessThanOrEqual(0.42 + 1e-9);
    }
  });

  it('never shows LESS than the tuning model asked for', () => {
    for (let w = 200; w <= 3200; w += 61) {
      expect(plan(w, heightFor(w)).visible).toBeGreaterThanOrEqual(0.115 - 1e-9);
    }
  });

  it('only widens when the resolution floor forces it', () => {
    // Narrow window, coarse resolution: the eye can be satisfied without
    // widening, so the tuning model's fraction survives untouched.
    expect(plan(320, 86).widened).toBe(false);
  });
});

describe('the meter is capped, and capped for a reason', () => {
  it('refuses to grow past the movement ceiling', () => {
    expect(meterPlan(400).w).toBe(METER_W_MAX);
    expect(meterPlan(9999).w).toBe(METER_W_MAX);
    expect(meterPlan(40).w).toBe(METER_W_MIN);
  });

  it('never earns a third tick tier, which is why real panel meters have two', () => {
    for (let w = METER_W_MIN; w <= METER_W_MAX; w += 3) {
      expect(meterPlan(w).sub).toBeLessThanOrEqual(2);
    }
  });

  it('keeps the graduation pitch legal at every legal size', () => {
    for (let w = METER_W_MIN; w <= METER_W_MAX; w += 2) {
      const p = meterPlan(w);
      expect(p.pitch).toBeGreaterThanOrEqual(PITCH_MIN - 1e-9);
      expect(p.pitch).toBeLessThanOrEqual(PITCH_MAX + 1e-9);
    }
  });

  it('holds the needle at a constant RENDERED width, so a big meter has a finer needle', () => {
    const small = meterPlan(140);
    const large = meterPlan(300);
    // Face units shrink as the meter grows...
    expect(large.needleBaseVb).toBeLessThan(small.needleBaseVb);
    // ...by exactly the amount that keeps the rendered width at 2 CSS px.
    expect(large.needleBaseVb / large.vb).toBeCloseTo(2.0, 9);
    expect(small.needleBaseVb / small.vb).toBeCloseTo(2.0, 9);
  });

  it('ramps type then freezes it, exactly like the drum', () => {
    const a = meterPlan(260);
    const b = meterPlan(300);
    expect(b.numeralVb / b.vb).toBeCloseTo(a.numeralVb / a.vb, 9);
  });

  it('drops the small print rather than shrinking it on a small movement', () => {
    expect(meterPlan(140).showSmallPrint).toBe(false);
    expect(meterPlan(140).showModel).toBe(false);
    expect(meterPlan(200).showSmallPrint).toBe(true);
    expect(meterPlan(200).showModel).toBe(true);
  });
});

describe('typeRamp', () => {
  it('is flat below the floor, linear between, and flat above the ceiling', () => {
    expect(typeRamp(100, 320, 1400, 10.5, 16)).toBe(10.5);
    expect(typeRamp(320, 320, 1400, 10.5, 16)).toBe(10.5);
    expect(typeRamp(860, 320, 1400, 10.5, 16)).toBeCloseTo(13.25, 6);
    expect(typeRamp(1400, 320, 1400, 10.5, 16)).toBe(16);
    expect(typeRamp(4000, 320, 1400, 10.5, 16)).toBe(16);
  });
});
