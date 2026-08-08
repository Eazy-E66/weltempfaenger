import { describe, expect, it } from 'vitest';

import { lidFrame } from '../../src/renderer/ui/components/lid';

/**
 * The register sheet's geometry.
 *
 * This file used to pin `tiltForBay`, which solved the angle a hinged lid had to
 * stand at so that its perspective projection landed on the bay. There is no
 * angle any more and no projection to solve: the shipping lid measured 1250.0 px
 * along its top edge against 1098.3 px along its bottom — a 13.8% taper, wider
 * at the top, which is a lid seen from BELOW on a chassis drawn strictly
 * front-on. The rotation is gone, the camera is orthographic everywhere, and
 * what is left is arithmetic:
 *
 *   · the sheet travels the depth of the well, exactly;
 *   · the printed plate is as deep as the deck the reflow spared, or is not
 *     there at all;
 *   · the type on the plate is sized against BOTH dimensions of the plate,
 *     because type sized off the depth alone once printed a `FREQUENCY 1.8–30
 *     MHz` legend wider than the case.
 */

describe('the sheet travels the whole well and no further', () => {
  it('travels exactly the depth it is given', () => {
    expect(lidFrame(174, 779, 1280).travel).toBe(779);
    expect(lidFrame(560, 1159, 1918).travel).toBe(1159);
  });

  it('never travels a negative distance', () => {
    expect(lidFrame(174, -40, 1280).travel).toBe(0);
    expect(lidFrame(0, 0, 1280).travel).toBe(0);
  });
});

describe('the printed plate', () => {
  it('is exactly as deep as the deck the reflow spared', () => {
    expect(lidFrame(174, 779, 1280).plate).toBe(174);
    expect(lidFrame(560, 1159, 1918).plate).toBe(560);
  });

  it('is not there at all below the depth worth printing on', () => {
    // 70 px is the floor: less than that is a strip too shallow to print a
    // legend on and too thin to be a credible press.
    for (const deck of [0, 12, 40, 69]) {
      const frame = lidFrame(deck, 779, 1280);
      expect(frame.plate, `deck ${deck}`).toBe(0);
      expect(frame.level, `deck ${deck}`).toBe('none');
      expect(frame.print, `deck ${deck}`).toBe(0);
    }
    expect(lidFrame(70, 779, 1280).plate).toBe(70);
  });

  it('can never be deeper than the well it comes out of', () => {
    // A deck deeper than the travel would hang the plate below the hem while
    // the sheet was still home, i.e. over the faceplate.
    expect(lidFrame(900, 400, 1280).plate).toBe(400);
    expect(lidFrame(900, 400, 1280).plate).toBeLessThanOrEqual(lidFrame(900, 400, 1280).travel);
  });

  it('grows with the deck, monotonically, so nothing snaps as the window grows', () => {
    let previous = -1;
    for (let deck = 70; deck <= 760; deck += 10) {
      const plate = lidFrame(deck, 779, 1280).plate;
      expect(plate).toBeGreaterThan(previous);
      previous = plate;
    }
  });
});

describe('how much of the printing there is room for', () => {
  it('prints everything once the plate is deep enough for a map', () => {
    expect(lidFrame(168, 779, 1280).level).toBe('full');
    expect(lidFrame(174, 779, 1280).level).toBe('full');
  });

  it('drops the map, then the chart, as the plate gets shallower', () => {
    expect(lidFrame(167, 779, 1280).level).toBe('mid');
    expect(lidFrame(104, 779, 1280).level).toBe('mid');
    expect(lidFrame(103, 779, 1280).level).toBe('min');
    expect(lidFrame(70, 779, 1280).level).toBe('min');
  });
});

describe('the type on the plate', () => {
  it('is sized in real screen pixels — there is no projection to undo', () => {
    // 1:1. The old code laid the printing out in a box `1/squash` too tall and
    // pre-stretched it so the rotation would squash it back; anything that
    // survives of that here is a bug.
    const frame = lidFrame(174, 779, 1280);
    expect(frame.print).toBeCloseTo(174 * 0.085, 5);
  });

  it('is capped by the width when the case is narrow', () => {
    // A deep plate on a narrow case: 0.085 of the depth would be 47.6 px, which
    // prints a legend wider than the case. The width wins.
    const frame = lidFrame(560, 1159, 900);
    expect(frame.print).toBeCloseTo((900 - 30) * 0.0125, 5);
    expect(frame.print).toBeLessThan(560 * 0.085);
  });

  it('gives a shallow plate a bigger share of itself, rather than a floor-sized legend', () => {
    // Fewer things printed means each gets more of the plate. Measured on a
    // case wide enough that the width is not the binding constraint.
    expect(lidFrame(90, 779, 3000).print).toBeCloseTo(90 * 0.22, 5);
    expect(lidFrame(120, 779, 3000).print).toBeCloseTo(120 * 0.13, 5);
    expect(lidFrame(200, 779, 3000).print).toBeCloseTo(200 * 0.085, 5);
  });

  it('has a floor, so the smallest plate is still legible', () => {
    expect(lidFrame(80, 779, 130).print).toBe(9);
  });

  it('has a ceiling, so an enormous window does not print a poster', () => {
    expect(lidFrame(2000, 2600, 3600).print).toBe(26);
  });

  it('degenerates safely on a well with no depth', () => {
    const frame = lidFrame(174, 0, 1280);
    expect(frame.travel).toBe(0);
    expect(frame.plate).toBe(0);
    expect(frame.level).toBe('none');
  });
});
