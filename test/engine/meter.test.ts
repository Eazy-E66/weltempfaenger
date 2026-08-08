/**
 * The TUNING meter's two halves.
 *
 * The dB numbers asserted below are not chosen for the test's convenience —
 * they are the band five live stations actually occupied when measured through
 * this analyser (see the calibration table in src/renderer/engine/meter.ts).
 */

import { describe, expect, it } from 'vitest';
import { deflectionFor, linkHealth } from '../../src/renderer/engine/meter';
import { stationGainFor } from '../../src/renderer/engine/stage';

/** RMS for a given dBFS, so the tests can be written in the units of the fault. */
const atDb = (db: number): number => Math.pow(10, db / 20);

/** The printed arc boundaries on the meter face. */
const RED_ENDS = 0.24;
const TEAL_BEGINS = 0.58;
/** The face sweeps 108 degrees end to end. */
const SWEEP_DEG = 108;

describe('mapping decoded RMS onto the printed scale', () => {
  it('reads exactly zero on silence', () => {
    expect(deflectionFor(0)).toBe(0);
    expect(deflectionFor(1e-9)).toBe(0);
  });

  it('reads zero below the floor and full scale at the top', () => {
    expect(deflectionFor(atDb(-60))).toBe(0);
    expect(deflectionFor(atDb(-38))).toBe(0);
    expect(deflectionFor(atDb(-4))).toBe(1);
    expect(deflectionFor(atDb(0))).toBe(1);
  });

  it('is monotonic in level', () => {
    let previous = -1;
    for (let db = -40; db <= 0; db += 0.5) {
      const value = deflectionFor(atDb(db));
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it('puts ordinary loudness-normalised broadcast in the teal, not on the end stop', () => {
    // Median programme loudness measured across five live stations was -14 dBFS.
    const median = deflectionFor(atDb(-14));
    expect(median).toBeGreaterThan(TEAL_BEGINS);
    expect(median).toBeLessThan(0.8);
  });

  it('leaves headroom above the loudest measured material', () => {
    // The loudest sample across the survey was -7.8 dBFS. A persisted tone
    // boost must not park the movement on its end stop.
    expect(deflectionFor(atDb(-7.8))).toBeLessThan(0.95);
    expect(deflectionFor(atDb(-7.8))).toBeGreaterThan(0.8);
  });

  it('gives that material a usable share of the sweep', () => {
    // The measured envelope of a single station was about -22 to -8 dBFS. The
    // old -60/-6 window turned that into 23-29 degrees of a 108 degree sweep.
    const used = (deflectionFor(atDb(-8)) - deflectionFor(atDb(-22))) * SWEEP_DEG;
    expect(used).toBeGreaterThan(35);
  });

  it('still lets a genuinely quiet passage read low', () => {
    expect(deflectionFor(atDb(-34))).toBeLessThan(RED_ENDS);
  });
});

describe('link health', () => {
  const healthy = {
    connected: true,
    stalled: false,
    bufferedSeconds: 2.25, // what Chromium actually holds for a live MP3
    pipelineSeconds: 0,
    sinceBytesMs: 200,
  };

  it('is full on a healthy link', () => {
    expect(linkHealth(healthy)).toBe(1);
  });

  it('is zero with no session', () => {
    expect(linkHealth({ ...healthy, connected: false })).toBe(0);
  });

  it('is zero the moment the proxy declares a stall', () => {
    expect(linkHealth({ ...healthy, stalled: true })).toBe(0);
  });

  it('falls as the buffer drains', () => {
    expect(linkHealth({ ...healthy, bufferedSeconds: 1 })).toBeCloseTo(0.5, 5);
    expect(linkHealth({ ...healthy, bufferedSeconds: 0 })).toBe(0);
  });

  it('counts the proxy-side queue towards depth, which is where a WIDE buffer lives', () => {
    expect(linkHealth({ ...healthy, bufferedSeconds: 0.5, pipelineSeconds: 8 })).toBe(1);
  });

  it('ignores a byte gap short enough to be ordinary chunking', () => {
    expect(linkHealth({ ...healthy, sinceBytesMs: 1_100 })).toBe(1);
  });

  it('falls away as byte flow dries up, and reaches zero before the needle lies', () => {
    const partial = linkHealth({ ...healthy, sinceBytesMs: 2_600 });
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(1);
    expect(linkHealth({ ...healthy, sinceBytesMs: 4_000 })).toBe(0);
    expect(linkHealth({ ...healthy, sinceBytesMs: 30_000 })).toBe(0);
  });

  it('is only as good as its worst symptom, not the product of them', () => {
    // Both terms sit at 0.5 here. A product would read 0.25 and understate a
    // link that is merely a bit shallow and a bit bursty.
    const both = linkHealth({ ...healthy, bufferedSeconds: 1, sinceBytesMs: 2_600 });
    expect(both).toBeCloseTo(0.5, 5);
    expect(both).not.toBeCloseTo(0.25, 2);
  });

  it('survives nonsense inputs without producing a reading above full scale', () => {
    expect(linkHealth({ ...healthy, bufferedSeconds: Number.NaN })).toBe(0);
    expect(linkHealth({ ...healthy, bufferedSeconds: 1e6 })).toBe(1);
    expect(linkHealth({ ...healthy, bufferedSeconds: -5 })).toBe(0);
  });
});

describe('what detuning costs the station path', () => {
  it('is silent nowhere near a station and untouched when locked on', () => {
    expect(stationGainFor(0)).toBe(0);
    expect(stationGainFor(1)).toBe(1);
  });

  it('is monotonic and never amplifies', () => {
    let previous = -1;
    for (let p = 0; p <= 1.0001; p += 0.02) {
      const g = stationGainFor(p);
      expect(g).toBeGreaterThanOrEqual(previous);
      expect(g).toBeLessThanOrEqual(1);
      previous = g;
    }
  });

  it('holds the signal up through the middle of the lock zone', () => {
    expect(stationGainFor(0.5)).toBeGreaterThan(0.6);
  });

  it('actually loses the signal at real detune, which is the whole point', () => {
    // The fault was ~0 dB of station attenuation at full detune: faint static
    // laid over unchanged, full-volume music.
    expect(20 * Math.log10(stationGainFor(0.1) || 1e-9)).toBeLessThan(-11);
    expect(stationGainFor(0.02)).toBeLessThan(0.13);
  });

  it('clamps rubbish input rather than inverting the signal', () => {
    expect(stationGainFor(-1)).toBe(0);
    expect(stationGainFor(2)).toBe(1);
    expect(stationGainFor(Number.NaN)).toBe(0);
  });
});
