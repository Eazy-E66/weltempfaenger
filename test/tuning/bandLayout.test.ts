import { describe, expect, it } from 'vitest';
import type { Band, DialSlot, StationRef } from '../../src/shared/contracts';
import {
  BROADCAST_BANDS,
  formatFrequency,
  frequencyToPosition,
  hash32,
  hashUnit,
  layoutBand,
  lockStrengthAt,
  nearestSlot,
  pickScale,
  positionToFrequency,
  slotAt,
  slotContains,
  slotRange,
  widthForPopularity,
} from '../../src/main/tuning/bandLayout';

// ---------------------------------------------------------------------------

function station(id: string, popularity: number): StationRef {
  return { id, name: `Station ${id}`, url: `http://example.invalid/${id}`, tags: [], popularity };
}

/** A deterministic pseudo-random-looking station set of a given size. */
function stations(count: number, seed = 'x'): StationRef[] {
  return Array.from({ length: count }, (_, i) =>
    station(`${seed}-${i}`, hashUnit(`pop:${seed}:${i}`)),
  );
}

function sortedByPosition(band: Band): DialSlot[] {
  return [...band.slots].sort((a, b) => a.position - b.position);
}

function assertWellFormed(band: Band): void {
  const slots = sortedByPosition(band);
  for (const slot of slots) {
    const { start, end } = slotRange(slot);
    expect(slot.width).toBeGreaterThan(0);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeLessThan(1);
  }
  for (let i = 1; i < slots.length; i++) {
    const previous = slotRange(slots[i - 1]!);
    const current = slotRange(slots[i]!);
    expect(current.start).toBeGreaterThan(previous.end);
  }
}

// ---------------------------------------------------------------------------

describe('the hash the layout is built on', () => {
  it('gives the same answer for the same input every time', () => {
    expect(hash32('groove-salad')).toBe(hash32('groove-salad'));
  });

  it('gives different answers for different inputs', () => {
    expect(hash32('a')).not.toBe(hash32('b'));
  });

  it('stays inside the unsigned 32-bit range', () => {
    for (const input of ['', 'a', 'a much longer station identifier', 'ünïcödé']) {
      const h = hash32(input);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it('maps to the unit interval without ever reaching 1', () => {
    for (let i = 0; i < 500; i++) {
      const u = hashUnit(`sample-${i}`);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
    }
  });
});

describe('choosing a scale for a band', () => {
  it('gives a genre the same stretch of dial every time', () => {
    expect(pickScale('jazz')).toEqual(pickScale('jazz'));
  });

  it('ignores casing and surrounding whitespace', () => {
    expect(pickScale('  JAZZ ')).toEqual(pickScale('jazz'));
  });

  it('only ever returns a real broadcast allocation', () => {
    for (const genre of ['jazz', 'techno', 'news', 'classical', 'fado', 'k-pop']) {
      expect(BROADCAST_BANDS).toContainEqual(pickScale(genre));
    }
  });

  it('gives every band an ascending scale with a plausible unit', () => {
    for (const band of BROADCAST_BANDS) {
      expect(band.scaleMax).toBeGreaterThan(band.scaleMin);
      expect(['MHz', 'kHz']).toContain(band.scaleUnit);
    }
  });

  it('puts different genres on different parts of the dial', () => {
    const genres = ['jazz', 'techno', 'news', 'classical', 'ambient', 'reggae', 'folk', 'metal'];
    const chosen = new Set(genres.map((g) => pickScale(g).label));
    expect(chosen.size).toBeGreaterThan(1);
  });
});

describe('lock-zone width', () => {
  it('is wider for a more popular station', () => {
    expect(widthForPopularity(1)).toBeGreaterThan(widthForPopularity(0.5));
    expect(widthForPopularity(0.5)).toBeGreaterThan(widthForPopularity(0));
  });

  it('clamps popularity outside 0..1 instead of producing a nonsense width', () => {
    expect(widthForPopularity(-5)).toBe(widthForPopularity(0));
    expect(widthForPopularity(99)).toBe(widthForPopularity(1));
  });

  it('survives a station with a non-numeric popularity', () => {
    expect(widthForPopularity(Number.NaN)).toBe(widthForPopularity(0));
  });
});

describe('laying a band out', () => {
  it('produces no slots for an empty station list', () => {
    const band = layoutBand('jazz', []);
    expect(band.slots).toEqual([]);
    expect(band.stationCount).toBe(0);
  });

  it('still gives an empty band a printable scale', () => {
    const band = layoutBand('jazz', []);
    expect(band.scaleMax).toBeGreaterThan(band.scaleMin);
    expect(band.genre).toBe('jazz');
  });

  it('places a single station inside the dial rather than at an edge', () => {
    const band = layoutBand('jazz', [station('only', 1)]);
    expect(band.slots).toHaveLength(1);
    assertWellFormed(band);
  });

  it('does not let one station swallow the whole dial', () => {
    const band = layoutBand('jazz', [station('only', 1)]);
    expect(band.slots[0]!.width).toBeLessThanOrEqual(0.055);
  });

  it('reports the station count it laid out', () => {
    expect(layoutBand('jazz', stations(7)).stationCount).toBe(7);
  });

  it('can report a directory-wide count larger than what was laid out', () => {
    const band = layoutBand('jazz', stations(7), { totalStations: 1402 });
    expect(band.stationCount).toBe(1402);
    expect(band.slots).toHaveLength(7);
  });

  it('keeps every slot inside 0..1 and clear of its neighbours', () => {
    for (const count of [1, 2, 3, 5, 17, 64, 200]) {
      assertWellFormed(layoutBand('jazz', stations(count)));
    }
  });

  it('holds up for hundreds of stations', () => {
    const band = layoutBand('pop', stations(500, 'big'));
    expect(band.slots).toHaveLength(500);
    assertWellFormed(band);
  });

  it('leaves at least 40% of the dial as empty space for the hiss to live in', () => {
    for (const count of [1, 10, 100, 500]) {
      const band = layoutBand('jazz', stations(count));
      const occupied = band.slots.reduce((sum, slot) => sum + slot.width, 0);
      expect(occupied).toBeLessThanOrEqual(0.6);
    }
  });

  it('gives more popular stations wider lock zones', () => {
    const band = layoutBand('jazz', [
      station('weak', 0.05),
      station('middling', 0.5),
      station('strong', 0.98),
    ]);
    const width = (id: string): number => band.slots.find((s) => s.station.id === id)!.width;
    expect(width('strong')).toBeGreaterThan(width('middling'));
    expect(width('middling')).toBeGreaterThan(width('weak'));
  });

  it('does not sort the dial by popularity - a band is not a leaderboard', () => {
    // With enough stations, at least one strong station must sit to the right
    // of a weaker one, or the dial has become a ranking.
    const band = layoutBand('jazz', stations(60, 'order'));
    const byPosition = sortedByPosition(band);
    const descending = byPosition.every(
      (slot, i) => i === 0 || byPosition[i - 1]!.station.popularity >= slot.station.popularity,
    );
    expect(descending).toBe(false);
  });

  it('leaves genuine gaps rather than butting slots together', () => {
    const band = layoutBand('jazz', stations(30, 'gaps'));
    const slots = sortedByPosition(band);
    for (let i = 1; i < slots.length; i++) {
      const gap = slotRange(slots[i]!).start - slotRange(slots[i - 1]!).end;
      expect(gap).toBeGreaterThan(0);
    }
  });

  it('spaces stations irregularly, like a real band', () => {
    const band = layoutBand('jazz', stations(40, 'irregular'));
    const slots = sortedByPosition(band);
    const gaps: number[] = [];
    for (let i = 1; i < slots.length; i++) {
      gaps.push(slotRange(slots[i]!).start - slotRange(slots[i - 1]!).end);
    }
    const unique = new Set(gaps.map((g) => g.toFixed(6)));
    expect(unique.size).toBeGreaterThan(gaps.length / 2);
  });
});

describe('determinism', () => {
  it('produces an identical layout for an identical station list', () => {
    const list = stations(50, 'determinism');
    expect(layoutBand('jazz', list)).toEqual(layoutBand('jazz', list));
  });

  it('produces the same layout however the input list was ordered', () => {
    const list = stations(40, 'shuffle');
    const reversed = [...list].reverse();
    const a = layoutBand('jazz', list);
    const b = layoutBand('jazz', reversed);
    expect(b.slots.map((s) => [s.station.id, s.position, s.width])).toEqual(
      a.slots.map((s) => [s.station.id, s.position, s.width]),
    );
  });

  it('gives a station the same position across separate sessions', () => {
    const list = stations(25, 'session');
    const first = layoutBand('techno', list);
    // A fresh module-level call, as a relaunch would make.
    const second = layoutBand('techno', list.map((s) => ({ ...s })));
    for (const slot of first.slots) {
      const other = second.slots.find((s) => s.station.id === slot.station.id)!;
      expect(other.position).toBe(slot.position);
    }
  });

  it('puts the same genre on the same scale across separate calls', () => {
    const a = layoutBand('classical', stations(5, 'a'));
    const b = layoutBand('classical', stations(9, 'b'));
    expect([a.scaleMin, a.scaleMax, a.scaleUnit]).toEqual([b.scaleMin, b.scaleMax, b.scaleUnit]);
  });

  it('uses no randomness - two fresh layouts of new-but-equal objects match exactly', () => {
    const build = (): StationRef[] => [station('one', 0.9), station('two', 0.1), station('three', 0.5)];
    expect(layoutBand('news', build())).toEqual(layoutBand('news', build()));
  });
});

describe('reading positions off the dial', () => {
  const band = layoutBand('jazz', stations(12, 'read'));

  it('finds the slot the pointer is sitting on', () => {
    const target = band.slots[3]!;
    expect(slotAt(band, target.position)?.station.id).toBe(target.station.id);
  });

  it('finds nothing in the space between stations', () => {
    const slots = sortedByPosition(band);
    const midpoint = (slotRange(slots[0]!).end + slotRange(slots[1]!).start) / 2;
    expect(slotAt(band, midpoint)).toBeUndefined();
  });

  it('includes the exact edges of a lock zone', () => {
    const slot = band.slots[0]!;
    const { start, end } = slotRange(slot);
    expect(slotContains(slot, start)).toBe(true);
    expect(slotContains(slot, end)).toBe(true);
  });

  it('still finds the nearest station from empty space, which is what seek needs', () => {
    const slots = sortedByPosition(band);
    const justPast = slotRange(slots[0]!).end + 1e-6;
    expect(nearestSlot(band, justPast)?.station.id).toBe(slots[0]!.station.id);
  });

  it('returns nothing for the nearest slot on an empty band', () => {
    expect(nearestSlot(layoutBand('jazz', []), 0.5)).toBeUndefined();
  });
});

describe('lock strength', () => {
  const band = layoutBand('jazz', [station('solo', 0.9)]);
  const slot = band.slots[0]!;

  it('is full at the centre of a lock zone', () => {
    expect(lockStrengthAt(band, slot.position)).toBeCloseTo(1, 10);
  });

  it('falls to nothing at the edges', () => {
    expect(lockStrengthAt(band, slotRange(slot).start)).toBeCloseTo(0, 10);
    expect(lockStrengthAt(band, slotRange(slot).end)).toBeCloseTo(0, 10);
  });

  it('is zero everywhere between stations, which is where the hiss belongs', () => {
    expect(lockStrengthAt(band, slotRange(slot).start - 0.01)).toBe(0);
  });

  it('rises monotonically as the pointer approaches the centre', () => {
    const half = slot.width / 2;
    let previous = -1;
    for (let t = 1; t >= 0; t -= 0.05) {
      const strength = lockStrengthAt(band, slot.position - half * t);
      expect(strength).toBeGreaterThanOrEqual(previous);
      previous = strength;
    }
  });
});

describe('the printed scale', () => {
  const band = layoutBand('jazz', stations(5, 'scale'));

  it('maps the ends of the dial to the ends of the scale', () => {
    expect(positionToFrequency(band, 0)).toBe(band.scaleMin);
    expect(positionToFrequency(band, 1)).toBe(band.scaleMax);
  });

  it('round-trips a position through the frequency and back', () => {
    for (const position of [0, 0.13, 0.5, 0.77, 1]) {
      expect(frequencyToPosition(band, positionToFrequency(band, position))).toBeCloseTo(position, 10);
    }
  });

  it('clamps a pointer dragged past the end of the scale', () => {
    expect(positionToFrequency(band, 5)).toBe(band.scaleMax);
    expect(positionToFrequency(band, -5)).toBe(band.scaleMin);
  });

  it('prints MHz to two decimals and kHz whole, as a real dial does', () => {
    const fm: Band = { ...band, scaleMin: 87.5, scaleMax: 108, scaleUnit: 'MHz' };
    const mw: Band = { ...band, scaleMin: 531, scaleMax: 1602, scaleUnit: 'kHz' };
    expect(formatFrequency(fm, 0)).toBe('87.50');
    expect(formatFrequency(mw, 0)).toBe('531');
  });
});
