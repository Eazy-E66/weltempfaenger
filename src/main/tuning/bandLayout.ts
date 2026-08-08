/**
 * Laying stations out along a dial.
 *
 * The physical idea being modelled: on a real receiver, a powerful transmitter
 * does not occupy a mathematical point on the scale. It bleeds. You start
 * hearing it before the pointer arrives and you are still hearing it after the
 * pointer has passed, and the stronger it is the wider that capture range gets.
 * A weak station is a knife-edge you can slide straight past. Between them is
 * nothing but band noise — and that noise needs somewhere to live, so the
 * layout guarantees genuine empty space rather than packing slots edge to edge.
 *
 * Two hard properties, both tested:
 *
 *   Determinism. The same station list always produces the same dial, so a
 *   user's muscle memory for where a station sits survives a restart. All
 *   jitter comes from hashing the station id; `Math.random` appears nowhere.
 *
 *   Non-overlap and containment. Every lock zone lies strictly inside 0..1 and
 *   touches no other, so "which station am I on?" always has one answer.
 *
 * Everything here is pure.
 */

import type { Band, Cut, DialSlot, StationRef } from '../../shared/contracts';

// ---------------------------------------------------------------------------
// Deterministic hashing
// ---------------------------------------------------------------------------

/** FNV-1a, 32-bit. Cheap, stable across runs and platforms, good enough spread. */
export function hash32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i) & 0xff;
    // 16777619, via shifts so it stays in 32-bit integer arithmetic.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    const high = input.charCodeAt(i) >> 8;
    if (high) {
      hash ^= high;
      hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    }
  }
  return hash >>> 0;
}

/** Same hash, mapped to [0, 1). */
export function hashUnit(input: string): number {
  return hash32(input) / 0x100000000;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// ---------------------------------------------------------------------------
// Scales
// ---------------------------------------------------------------------------

export interface BroadcastBand {
  /** Meter-band name as printed on the lid chart, e.g. "49 m". */
  label: string;
  scaleMin: number;
  scaleMax: number;
  scaleUnit: 'MHz' | 'kHz';
}

/**
 * Real ITU broadcasting allocations, so the printed scale reads like a scale
 * someone could have silkscreened onto a receiver rather than an invented
 * range. These are the same bands the ICF-6800W's lid chart lists.
 */
export const BROADCAST_BANDS: readonly BroadcastBand[] = Object.freeze([
  { label: 'FM', scaleMin: 87.5, scaleMax: 108.0, scaleUnit: 'MHz' },
  { label: 'MW', scaleMin: 531, scaleMax: 1602, scaleUnit: 'kHz' },
  { label: '120 m', scaleMin: 2300, scaleMax: 2495, scaleUnit: 'kHz' },
  { label: '90 m', scaleMin: 3200, scaleMax: 3400, scaleUnit: 'kHz' },
  { label: '75 m', scaleMin: 3900, scaleMax: 4000, scaleUnit: 'kHz' },
  { label: '60 m', scaleMin: 4750, scaleMax: 4995, scaleUnit: 'kHz' },
  { label: '49 m', scaleMin: 5900, scaleMax: 6200, scaleUnit: 'kHz' },
  { label: '41 m', scaleMin: 7200, scaleMax: 7450, scaleUnit: 'kHz' },
  { label: '31 m', scaleMin: 9400, scaleMax: 9900, scaleUnit: 'kHz' },
  { label: '25 m', scaleMin: 11600, scaleMax: 12100, scaleUnit: 'kHz' },
  { label: '22 m', scaleMin: 13570, scaleMax: 13870, scaleUnit: 'kHz' },
  { label: '19 m', scaleMin: 15100, scaleMax: 15800, scaleUnit: 'kHz' },
  { label: '16 m', scaleMin: 17480, scaleMax: 17900, scaleUnit: 'kHz' },
  { label: '13 m', scaleMin: 21450, scaleMax: 21850, scaleUnit: 'kHz' },
  { label: '11 m', scaleMin: 25670, scaleMax: 26100, scaleUnit: 'kHz' },
]);

/**
 * Which physical band a genre lives on. Derived from the genre name alone, so
 * "jazz" is always on the same stretch of dial no matter what the directory
 * returned today — the scale is part of the station's address, and an address
 * that moves is not an address.
 */
export function pickScale(genre: string): BroadcastBand {
  const key = genre.trim().toLowerCase();
  return BROADCAST_BANDS[hash32(`band:${key}`) % BROADCAST_BANDS.length]!;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export interface BandLayoutOptions {
  /** Print onto this exact band rather than the one hashed from the name. */
  scale?: BroadcastBand;
  /** Narrowest lock zone, in dial units. Default 0.012. */
  minWidth?: number;
  /** Widest lock zone, in dial units. Default 0.055. */
  maxWidth?: number;
  /**
   * Largest share of the dial that lock zones may collectively occupy.
   * Default 0.55 — i.e. at least 45% of any band is always dead air.
   */
  maxOccupancy?: number;
  /** Reported `stationCount` when the directory has more than we laid out. */
  totalStations?: number;
}

const DEFAULTS = {
  minWidth: 0.012,
  maxWidth: 0.055,
  maxOccupancy: 0.55,
} as const;

/** Gap jitter range: every gap gets between 0.55x and 1.45x the mean gap. */
const GAP_JITTER_MIN = 0.55;
const GAP_JITTER_SPAN = 0.9;

/**
 * Lock-zone width from popularity.
 *
 * Square-rooted rather than linear: directory popularity is long-tailed even
 * after normalisation, and a linear map leaves the middle of the field
 * indistinguishable from the bottom. The sqrt lifts mid-table stations enough
 * that the dial has texture instead of one fat slot and a row of hairlines.
 */
export function widthForPopularity(
  popularity: number,
  minWidth: number = DEFAULTS.minWidth,
  maxWidth: number = DEFAULTS.maxWidth,
): number {
  return minWidth + (maxWidth - minWidth) * Math.sqrt(clamp01(popularity));
}

/**
 * Place `stations` along a 0..1 dial.
 *
 * Dial order comes from hashing the station id, not from popularity: on a real
 * band, transmitter power has nothing to do with frequency, and sorting by
 * popularity would turn the dial into a leaderboard. Hashing also means adding
 * a station to the set inserts it where it belongs instead of shifting
 * everything after it.
 */
export function layoutBand(
  genre: string,
  stations: readonly StationRef[],
  options: BandLayoutOptions = {},
): Band {
  const minWidth = options.minWidth ?? DEFAULTS.minWidth;
  const maxWidth = Math.max(options.maxWidth ?? DEFAULTS.maxWidth, minWidth);
  // Hard-capped below 1: if lock zones could fill the dial there would be no
  // dead air, and a band with no dead air is not a band.
  const maxOccupancy = Math.min(0.9, Math.max(0.02, clamp01(options.maxOccupancy ?? DEFAULTS.maxOccupancy)));
  const scale = options.scale ?? pickScale(genre);

  const base: Omit<Band, 'slots' | 'stationCount'> = {
    genre,
    scaleMin: scale.scaleMin,
    scaleMax: scale.scaleMax,
    scaleUnit: scale.scaleUnit,
    scaleLabel: scale.label,
  };

  if (stations.length === 0) {
    return { ...base, stationCount: options.totalStations ?? 0, slots: [] };
  }

  // --- dial order -------------------------------------------------------
  const ordered = stations
    .map((station, index) => ({ station, index, key: hash32(`dial:${station.id}`) }))
    .sort(
      (a, b) =>
        a.key - b.key ||
        (a.station.id < b.station.id ? -1 : a.station.id > b.station.id ? 1 : 0) ||
        a.index - b.index,
    );

  // --- widths -----------------------------------------------------------
  const rawWidths = ordered.map((o) => widthForPopularity(o.station.popularity, minWidth, maxWidth));
  const rawTotal = rawWidths.reduce((a, b) => a + b, 0);
  // Scale down (never up) so a crowded band still leaves room for hiss and a
  // sparse band does not stretch three stations across the whole dial.
  const scaleFactor = rawTotal > maxOccupancy ? maxOccupancy / rawTotal : 1;
  const widths = rawWidths.map((w) => w * scaleFactor);
  const widthTotal = widths.reduce((a, b) => a + b, 0);

  // --- gaps -------------------------------------------------------------
  // n + 1 gaps: one before each station and one trailing, so no slot ever
  // touches an edge of the dial.
  const gapBudget = Math.max(0, 1 - widthTotal);
  const gapWeights = ordered.map(
    (o) => GAP_JITTER_MIN + GAP_JITTER_SPAN * hashUnit(`gap:${o.station.id}`),
  );
  gapWeights.push(GAP_JITTER_MIN + GAP_JITTER_SPAN * hashUnit(`gap:tail:${genre}`));
  const weightTotal = gapWeights.reduce((a, b) => a + b, 0);

  // --- walk the dial ----------------------------------------------------
  const slots: DialSlot[] = [];
  let cursor = 0;
  for (let i = 0; i < ordered.length; i++) {
    cursor += (gapBudget * gapWeights[i]!) / weightTotal;
    const width = widths[i]!;
    const half = width / 2;
    // Guard against accumulated float drift pushing the last slot off the end.
    const position = Math.min(Math.max(cursor + half, half), 1 - half);
    slots.push({ station: ordered[i]!.station, position, width });
    cursor += width;
  }

  return { ...base, stationCount: options.totalStations ?? slots.length, slots };
}

// ---------------------------------------------------------------------------
// Reading the dial
// ---------------------------------------------------------------------------

/** Lock-zone bounds of a slot. */
export function slotRange(slot: DialSlot): { start: number; end: number } {
  return { start: slot.position - slot.width / 2, end: slot.position + slot.width / 2 };
}

export function slotContains(slot: DialSlot, position: number): boolean {
  const { start, end } = slotRange(slot);
  return position >= start && position <= end;
}

/** The station the pointer is actually sitting on, if any. */
export function slotAt(band: Band, position: number): DialSlot | undefined {
  return band.slots.find((slot) => slotContains(slot, position));
}

/** Closest slot by centre distance — what a "seek" lands on. */
export function nearestSlot(band: Band, position: number): DialSlot | undefined {
  let best: DialSlot | undefined;
  let bestDistance = Infinity;
  for (const slot of band.slots) {
    const distance = Math.abs(slot.position - position);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = slot;
    }
  }
  return best;
}

/**
 * How well locked on the pointer is: 1 dead centre, falling to 0 at the edges
 * of the lock zone and staying 0 in between stations. This is the inverse of
 * how much inter-station hiss should be audible, which is why it uses a raised
 * cosine rather than a linear ramp — a linear ramp has an audible corner at
 * the lock-zone edge.
 */
export function lockStrengthAt(band: Band, position: number): number {
  const slot = slotAt(band, position);
  if (!slot || slot.width <= 0) return 0;
  const offset = Math.abs(position - slot.position) / (slot.width / 2);
  return 0.5 * (1 + Math.cos(Math.PI * clamp01(offset)));
}

/** Dial position -> the number printed on the scale. */
export function positionToFrequency(band: Band, position: number): number {
  return band.scaleMin + clamp01(position) * (band.scaleMax - band.scaleMin);
}

/** The number printed on the scale -> dial position. */
export function frequencyToPosition(band: Band, frequency: number): number {
  const span = band.scaleMax - band.scaleMin;
  if (span === 0) return 0;
  return clamp01((frequency - band.scaleMin) / span);
}

/** Formatted for the printed scale: FM gets one decimal, kHz bands get none. */
export function formatFrequency(band: Band, position: number): string {
  const value = positionToFrequency(band, position);
  return band.scaleUnit === 'MHz' ? value.toFixed(2) : Math.round(value).toString();
}

// ---------------------------------------------------------------------------
// Cutting a scope onto the drum
// ---------------------------------------------------------------------------

/**
 * The twelve shortwave broadcasting bands the ICF-6800W prints on its lid, in
 * order. This is the drum's physical capacity, expressed in the object's own
 * units rather than as a number of rows.
 */
export const METER_BANDS: readonly BroadcastBand[] = Object.freeze(
  BROADCAST_BANDS.filter((b) => b.scaleUnit === 'kHz' && b.scaleMin >= 2000 && b.label !== '22 m'),
);

/** Entries one printed meter band can carry legibly. */
export const PER_BAND = 40;

/** What the drum can print in total. Twelve bands of forty. */
export const DRUM_CAPACITY = METER_BANDS.length * PER_BAND;

/**
 * Cut a scope onto the drum.
 *
 * The ceiling is the point. A drum you cannot read is not a drum, so a scope
 * wider than 480 entries is printed down to its top 480 and the register says
 * so in numbers *before* the throw — never afterwards, and never silently.
 *
 * Ordering into bands follows the order handed in, which is the register's
 * current sort: the first forty most-listened land on 120 m, the next forty on
 * 90 m, and so on. Within a band the existing dial layout applies, so a station
 * still sits where its id says it sits and a lock zone still scales with
 * popularity.
 */
export function cutBands(
  caption: string,
  quality: string,
  stations: readonly StationRef[],
  options: BandLayoutOptions = {},
): Cut {
  const taken = stations.slice(0, DRUM_CAPACITY);
  const bands: Band[] = [];
  for (let i = 0; i * PER_BAND < taken.length; i++) {
    const scale = METER_BANDS[i]!;
    const chunk = taken.slice(i * PER_BAND, (i + 1) * PER_BAND);
    bands.push(layoutBand(caption, chunk, { ...options, scale, totalStations: chunk.length }));
  }
  return { caption, quality, printed: taken.length, total: stations.length, bands };
}
