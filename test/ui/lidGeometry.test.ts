import { describe, expect, it } from 'vitest';

import { caseTopDepth, lidFrame } from '../../src/renderer/ui/components/lid';

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
  it('is exactly as deep as the deck the reflow spared, at every depth', () => {
    expect(lidFrame(174, 779, 1280).plate).toBe(174);
    // The shipped Windows plate is 158 and this machine's default is 174.
    expect(lidFrame(158, 779, 1280).plate).toBe(158);
    /* And a deep deck is ALL plate, HERE. There used to be a `PLATE_MAX = 208`
       inside this function and this case pinned it; it stays withdrawn, because
       a plate that declines deck it has been given leaves brushed aluminium
       between its rail and the faceplate — 330 px of it at 1920×1200, against
       ~11 px on the owner's Windows reference.
       The depth a case top WANTS is a separate question with a separate
       function, `caseTopDepth`, and the reflow answers it by handing the
       faceplate the difference rather than by leaving a hole. See below. */
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
    // The well is the one limit left on the plate's depth.
    expect(lidFrame(900, 190, 1280).plate).toBe(190);
    expect(lidFrame(900, 400, 1280).plate).toBeLessThanOrEqual(lidFrame(900, 400, 1280).travel);
  });

  it('grows with the deck, monotonically, so nothing snaps as the window grows', () => {
    let previous = -1;
    for (let deck = 70; deck <= 760; deck += 10) {
      const plate = lidFrame(deck, 779, 1280).plate;
      // Monotonic, and it may sit still once it has taken the whole well — what
      // it may never do is jump or go backwards as the window is dragged.
      expect(plate).toBeGreaterThanOrEqual(previous);
      previous = plate;
    }
    expect(previous).toBe(760);
  });
});

describe('how much of the printing there is room for', () => {
  it('tops out at mid, however deep the plate gets', () => {
    // `full` is gone with the plate map it existed for: `mid` is the deepest
    // level there is, and a deep plate prints the same matter as a shallow one
    // at the same type size rather than growing a map.
    expect(lidFrame(168, 779, 1280).level).toBe('mid');
    expect(lidFrame(174, 779, 1280).level).toBe('mid');
    expect(lidFrame(600, 779, 1280).level).toBe('mid');
  });

  it('drops the chart as the plate gets shallower, and never the strip', () => {
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
    // At this width the WIDTH rule binds, not the depth share: 0.0125 of the
    // usable width is the largest type the widest printed row still fits in,
    // and 1250 × 0.0125 = 15.625 is below the 174 × 0.13 the depth would allow.
    // That is the same 15.625 px the shipped Windows plate is set in — deleting
    // the `full` level's 0.085 share is what stopped a deep plate printing
    // SMALLER type than a shallow one.
    expect(frame.print).toBeCloseTo(Math.min(174 * 0.13, 1250 * 0.0125), 5);
    expect(frame.print).toBeCloseTo(15.625, 5);
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
    // A deep plate now takes the same share as a middling one: there is no
    // map to leave room for, so the type does not shrink to make space.
    expect(lidFrame(200, 779, 3000).print).toBeCloseTo(200 * 0.13, 5);
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

/**
 * HOW DEEP A CASE TOP WANTS TO BE.
 *
 * `lidFrame` prints on the deck it is handed. This is the other half: how much
 * deck a case top asks for in the first place, which is what stops a tall window
 * buying nothing but unprinted ink. Measured before this existed, lowest printed
 * pixel to the plate's bottom edge: 30.6% of the plate at the 1280×820 default,
 * but 43.5% at the owner's own 1586×967 and 58.6% at 1920×1200 — against a
 * reference plate that is 158 px and full.
 *
 * The surplus the case top declines goes to the FACEPLATE (`--panel-slack` in
 * reflow()), never to bare aluminium under the plate. That is the difference
 * between this and the withdrawn `PLATE_MAX = 208`.
 */
describe('how deep the case top asks to be', () => {
  it('asks for exactly the deck the shipping default already gives it', () => {
    // 1280×820 spares 175 px of deck once the faceplate has taken its shortfall,
    // so the cap is a no-op there and the default cannot move. Verified on the
    // real build as well: the plate region diffs at max channel delta 0.
    expect(caseTopDepth(1280)).toBe(175);
  });

  it('never asks for more than that, however wide the case gets', () => {
    for (const width of [1280, 1440, 1586, 1920, 2560, 3600]) {
      expect(caseTopDepth(width), `width ${width}`).toBe(175);
    }
  });

  it('asks for LESS on a narrow case, because the printing is narrower too', () => {
    // The type is width-bound, so a 900 px case prints a block about half the
    // height of a 1920 px one. A plate frozen at 175 px there would be 44% hole;
    // asking for 11.6 type-sizes keeps the same composition the default has.
    expect(caseTopDepth(900)).toBeCloseTo(11.6 * ((900 - 30) * 0.0125), 5);
    expect(caseTopDepth(900)).toBeLessThan(caseTopDepth(1280));
  });

  it('never leaves the plate more than 11.6 type-sizes deep — the default’s own composition', () => {
    // The printed block is ~4.5 × `--pt` tall, so this is the block plus the
    // margins the 1280×820 default prints around it, at every window shape.
    for (let width = 120; width <= 3600; width += 20) {
      const cap = caseTopDepth(width);
      const frame = lidFrame(cap, 2000, width);
      expect(cap / frame.print, `width ${width}`).toBeLessThanOrEqual(11.6 + 1e-9);
    }
  });

  it('never lets a capped plate fall to a lower print level than an uncapped one', () => {
    // `min` hides the band chart. A cap that dropped the plate under 104 px
    // would take printed matter off the plate to save blank space on it.
    for (let width = 120; width <= 3600; width += 20) {
      expect(lidFrame(caseTopDepth(width), 2000, width).level, `width ${width}`).toBe('mid');
    }
  });

  it('is continuous and monotonic in the width, so nothing snaps on a drag', () => {
    let previous = -1;
    for (let width = 120; width <= 3600; width += 1) {
      const cap = caseTopDepth(width);
      expect(cap, `width ${width}`).toBeGreaterThanOrEqual(previous);
      previous = cap;
    }
  });
});
