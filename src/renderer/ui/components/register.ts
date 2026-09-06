/**
 * THE WORLD STATION REGISTER — the inside of the lid.
 *
 * The real ICF-6800W screen-prints reference matter on the inside of its lid:
 * the GMT world map, the timezone strip, the `FREQUENCY 1.8–30 MHz` meter-band
 * chart. The lid is where the paper lives. Every serious listener also kept the
 * World Radio TV Handbook open on the desk beside the set — a fat annual
 * directory of every station on earth, filed by country, by language, by
 * subject. This builds that book into the lid and gives it a mechanism.
 *
 * Four materials, all of which already exist in this product:
 *
 *   · THE SHEET   the same ivory dial stock as the TUNING meter, ruled as a
 *                 ledger, under glass, lit from the upper left
 *   · THE COMBS   a card index seen edge-on — each row a divider tab with a
 *                 printed count and a notch cut to a depth proportional to it,
 *                 so the comb is a real histogram of the directory
 *   · THE MAP     the lid's existing cyan line-art GMT map, now the origin
 *                 index, with dot area proportional to station count
 *   · THE THROW   CUT BAND: a chrome paddle whose engraved legend always says,
 *                 in real numbers, exactly what the throw is about to do
 *
 * There is not one dropdown, chip, modal, toast, card or hamburger in it.
 * Sorting is a piano key bank. Quality and codec are piano key banks. VERIFIED
 * ONLY and HIDE HLS are lever switches with the standard teal engaged dot. The
 * type slots are milled channels with an engraved index caret, not input boxes.
 *
 * Law 2 holds throughout: nothing here asserts playback. Clicking an entry asks
 * the host to tune it; the ledger's on-air mark comes back from the engine.
 */

import type {
  PlaybackError,
  PlaybackState,
  RegisterIndex,
  RegisterScope,
  StationRef,
} from '../../../shared/contracts';
import { emptyScope } from '../../../shared/contracts';
import { DRUM_CAPACITY, METER_BANDS, PER_BAND } from '../../../main/tuning/bandLayout';
import { clamp, el, setAttr, setFlag, setText, svg } from '../dom';
import { airStateOf, type AirState } from '../types';
import { displayStationName } from '../stationName';
import { COASTLINES, TIMEZONES, latToY, lonToX } from '../worldGeometry';
import { localClock, resolveZone } from '../worldTime';
import {
  NOTCH_DECADE_PCT,
  computeView,
  editionSuggestions,
  filterTabs,
  notchPct,
  qualityCaption,
  scopeCaption,
  scopeIsDefault,
  scopeIsEmpty,
  soleExclusions,
  supersetKey,
  unknownTabs,
  type RegisterView,
  type SortKey,
  type Tab,
} from '../register/facets';
import { stalledWords } from './readout';

const MAP_W = 300;
const MAP_H = 158;
const TZ_H = 11;
const LAT_MAX = 78;
const ROW_H = 17;
/** Tabs printed per comb. Beyond this the drawer says how much it cut. */
const COMB_LIMIT = 300;
const DEG = Math.PI / 180;
/**
 * Kilometres to one unit of the map's own grid.
 *
 * The projection is equirectangular (`latToY` is linear in latitude), so the
 * vertical scale is exact everywhere: 156° of latitude over `MAP_H - TZ_H * 2`
 * units is 111.2 × 156 / 136 ≈ 128 km per unit. The horizontal scale matches it
 * at the equator and tightens toward the poles exactly as the coastlines under
 * it do, which is what a reticle drawn on this map should do too.
 */
const KM_PER_UNIT = 128;

export interface RegisterHandlers {
  /** The cards pulled changed. The host refetches and hands back rows. */
  onScope(scope: RegisterScope): void;
  /** An entry was clicked: take it on air. */
  onSelect(stationId: string): void;
  /** CUT BAND thrown: print these rows onto the drum and shut the lid. */
  onCut(rows: StationRef[], caption: string, quality: string): void;
  /** REPRINT EDITION: the index is missing or stale; pull it again. */
  onReprint(): void;
  onClose(): void;
  /**
   * RECONNECT, from inside the register — the panel's own control, reachable
   * from the surface where the failing click was made (FIX 6).
   *
   * Optional, and the affordance is built only when it is supplied: a RECONNECT
   * that no host is listening to is a control with no job, which Law 1 forbids.
   * Wire it to the same `FaceplateHandlers.onReconnect` the front panel uses —
   * there is one recovery action on this receiver, not two.
   */
  onReconnect?(): void;
}

/** What the host says about a set of rows when it hands them over. */
export interface RegisterRows {
  /** The fetch behind these rows is still running. */
  loading: boolean;
  /**
   * Which population these rows *are*, as `supersetKey` names it.
   *
   * The register may not derive this from the scope it is holding: the scope can
   * change while a fetch is in flight, and the answer that then arrives answers
   * the scope that was pulled, not the one on the page. Omitted means "take the
   * current scope's word for it", which is only safe for a caller that has no
   * fetch of its own — the shipping host always names the population.
   */
  key?: string;
  fault?: string;
  warning?: string;
}

/**
 * Where a station transmits from, and how well that is known.
 *
 * Two rungs, and they are not the same claim, so they do not get the same mark
 * on the map:
 *
 *   · `fix`     — the directory published coordinates for THIS station.
 *   · `country` — it did not, but other stations with the same country code
 *                 did, and this is the running mean of theirs. A country, not
 *                 a transmitter.
 *
 * There is no third rung. When neither holds, the answer is `null` and the
 * surfaces say so — Law 4's designed state, not a marker parked somewhere
 * plausible.
 */
export interface StationOrigin {
  lat: number;
  lon: number;
  from: 'fix' | 'country';
  /** Carried through so a caller can resolve the clock without the station. */
  countryCode?: string;
  /**
   * The station published a fix, the fix disagreed with its own country, and
   * the country was believed instead.
   *
   * Only ever set together with `from: 'country'` — the position reported IS
   * the country average, and the discarded fix is named here so the readout can
   * say that the directory contradicted itself rather than silently swallowing
   * one of the two. See `FIX_MAX_KM` at `originOf`.
   */
  fixRejected?: boolean;
}

export interface RegisterHandle {
  root: HTMLElement;
  /** The printed index, or null with the reason it is not printed. */
  setIndex(index: RegisterIndex | null, fault: string | null): void;
  /** The rows the host fetched for the current scope. */
  setRows(rows: readonly StationRef[], state: RegisterRows): void;
  setScope(scope: RegisterScope): void;
  /**
   * What the ledger says about the station the panel is currently about.
   *
   * This replaces `setOnAir(id)`, which could express exactly one thing — "this
   * row is on the air" — and therefore had to answer three different questions
   * with the same silence. A row being *resolved* looked identical to a row
   * nobody had touched; a row that had just *failed* looked identical to both.
   * The register's own head says CLICK AN ENTRY TO TAKE IT ON AIR, so the row
   * that was clicked is precisely where the answer has to appear.
   *
   * Four states, `AirState`, derived per frame by `airStateOf` from the phase
   * the engine reported — never stored, never inferred, so the mark cannot
   * survive the station it is about (Law 2 names that exact defect):
   *
   *   · `off`     nothing claimed; no row is marked
   *   · `trying`  amber — resolving, connecting, buffering, re-locking
   *   · `on`      the on-air blip. The decoder is producing audio, and nothing
   *               else earns this
   *   · `failed`  the maroon strike `.is-faulted`, the same mark the fault strip
   *               puts on the line that did not come up. It stays until the
   *               phase moves off `error`/`stalled`, which only a re-try does.
   */
  setAir(stationId: string | undefined, air: AirState): void;
  /**
   * What the engine is doing — the register's channel for a failure at the
   * point of action (FIX 6).
   *
   * The register's own head says CLICK AN ENTRY TO TAKE IT ON AIR, and a click
   * that failed showed nothing here: the fault text rendered onto the faceplate,
   * which the open lid completely covers. Measured `phase: error, kind: hls` at
   * 0.39 s while `register.innerText` tested against `/HLS ONLY|CANNOT
   * DECODE|FAULT/i` was **false**. This handle exposed `setIndex`, `setRows`,
   * `setScope`, `setAir` and `focusSearch` — there was structurally no channel
   * for a fault, so Law 4 could not be satisfied from this surface however the
   * host behaved.
   *
   * Takes the whole `PlaybackState` because that is the object the faceplate
   * already holds and re-renders on every engine tick, so the wiring is one
   * call with no new type to keep in step. Idempotent and cheap: it repaints
   * only the fault strip and the ledger's fault mark. `null` clears it.
   */
  setPlayback(state: PlaybackState | null): void;
  /**
   * Where this station transmits from, as far as the register knows.
   *
   * A **pure read**. It paints nothing, repaints nothing, schedules nothing and
   * touches no signature — the lid calls it on every engine tick, and the map's
   * hover calls it on every row a pointer crosses.
   *
   * The chain is `station.geo`, then the country centroid the register has
   * learned from the geography real stations carried, then `null`. There is no
   * fourth source and there is deliberately no authored atlas of country
   * coordinates: see the note at `centroids`.
   */
  originOf(station: StationRef | undefined): StationOrigin | null;
  focusSearch(field?: RegisterSearchField): void;
  destroy(): void;
}

/**
 * Which of the register's two type slots a hand is being put in.
 *
 * `subject` is the SUBJECT index, which is where a listener who has opened the
 * register to browse starts. `name` is the ledger's own NAME slot, which is
 * where a listener who already knows the station is going — and it is what
 * `Ctrl+K` means: *find this station*, not *file the world down*.
 */
export type RegisterSearchField = 'subject' | 'name';

/**
 * What each failure kind is, in the register's own printed voice.
 *
 * Straight off `PlaybackError.kind`, which is the exhaustive union in
 * `contracts.ts`, so a kind added there stops this table compiling rather than
 * printing an empty headline.
 */
const FAULT_WORDS: Record<PlaybackError['kind'], string> = {
  network: 'NO ROUTE TO THE STATION',
  http: 'THE STATION REFUSED THE REQUEST',
  'not-audio': 'THAT ADDRESS IS NOT AUDIO',
  hls: 'HLS ONLY — THIS RECEIVER CANNOT DECODE IT',
  'empty-playlist': 'THE PLAYLIST HAS NO STREAM IN IT',
  'too-many-redirects': 'TOO MANY REDIRECTS',
  timeout: 'THE STATION DID NOT ANSWER IN TIME',
  decode: 'THE DECODER COULD NOT READ THE STREAM',
  'upstream-closed': 'THE STATION CLOSED THE CONNECTION',
  aborted: 'THE TUNE WAS CANCELLED',
};

/** What every unknown quantity prints. One glyph, everywhere, no exceptions. */
const UNKNOWN = '—';

/** Rows a PageUp/PageDown covers in a list. */
const PAGE = 10;

/** Thin-space grouping, as a printed register sets its numerals. */
function grp(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/**
 * The ARIA listbox / radiogroup motion keys, as an index move.
 *
 * Returns `-1` when the key is not a motion key, so the caller can leave it
 * alone — which is how ESCAPE gets out of a comb instead of being eaten by it.
 */
function moveIndex(
  key: string,
  current: number,
  count: number,
  axis: 'vertical' | 'horizontal',
): number {
  if (count === 0) return -1;
  const forward = axis === 'vertical' ? 'ArrowDown' : 'ArrowRight';
  const back = axis === 'vertical' ? 'ArrowUp' : 'ArrowLeft';
  switch (key) {
    case forward:
      return Math.min(count - 1, current + 1);
    case back:
      return Math.max(0, current - 1);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    case 'PageDown':
      return axis === 'vertical' ? Math.min(count - 1, current + PAGE) : -1;
    case 'PageUp':
      return axis === 'vertical' ? Math.max(0, current - PAGE) : -1;
    default:
      return -1;
  }
}

/**
 * Type-ahead, as every list in every OS file dialog has had since 1984.
 *
 * A comb holds three hundred printed terms in one scroller. Arrow keys alone
 * make `zydeco` a hundred and eighty presses from the top; typing `zy` is the
 * difference between a usable index and a technically-conformant one.
 */
function typeAhead(): (key: string, labels: readonly string[], from: number) => number {
  let buffer = '';
  let at = 0;
  return (key, labels, from) => {
    if (key.length !== 1 || key === ' ') return -1;
    const now = Date.now();
    buffer = now - at > 800 ? key : buffer + key;
    at = now;
    const want = buffer.toLowerCase();
    // Repeating one letter walks through the terms starting with it.
    const start = buffer.length === 1 ? from + 1 : from;
    for (let i = 0; i < labels.length; i++) {
      const j = (start + i + labels.length) % labels.length;
      if (labels[j]!.toLowerCase().startsWith(want)) return j;
    }
    return -1;
  };
}

/** Unique ids, so a visible label can be wired to the control it names. */
let uid = 0;
function nextId(prefix: string): string {
  uid += 1;
  return `${prefix}-${uid}`;
}

/** How long ago the directory last reached a station, in printed shorthand. */
function ageStr(days: number | undefined): string {
  if (days === undefined) return '—';
  if (days === 0) return 'TODAY';
  if (days < 31) return `${days} D`;
  if (days < 400) return `${Math.round(days / 30)} MO`;
  return `${Math.round(days / 365)} YR`;
}

export function createRegister(handlers: RegisterHandlers): RegisterHandle {
  let index: RegisterIndex | null = null;
  let indexFault: string | null = null;
  let scope: RegisterScope = emptyScope();
  let stations: StationRef[] = [];
  let loading = false;
  let rowFault: string | undefined;
  let rowWarning: string | undefined;
  /** Which row the panel is currently about, and what it is doing. */
  let airId: string | undefined;
  let air: AirState = 'off';
  /** What the engine last reported. Rendered, never inferred (Law 2). */
  let playback: PlaybackState | null = null;
  let sort: SortKey = 'listeners';
  let view: RegisterView = { rows: [], subjects: [], origins: [], tongues: [], global: true };
  const combQuery = { subject: '', origin: '', tongue: '' };

  /**
   * FIX 1 — the one piece of bookkeeping that makes every printed number in
   * this file a measurement rather than a leftover.
   *
   * `rowsKey` is which population `stations` actually is, as `supersetKey`
   * names it. `printing` is the answer to "can any number about the current
   * scope be derived from it?". When it cannot, the sheet count, all three comb
   * head counts, every card count, every notch, the origin map, the band chart
   * and the CUT BAND legend go to `PRINTING…` / em-dash **in the same task as
   * the click**, together, and CUT BAND goes inert. One state, one answer.
   *
   * `loading` is kept separately and deliberately not conflated with it: the
   * host re-pulls on every scope change, including the two thirds of changes
   * that are answered exactly by the rows already in hand, and blanking those
   * would trade a wrong number for a needless half-second of nothing.
   */
  let rowsKey: string | null = null;
  let printing = true;
  let printingSince = Date.now();
  let printTicker = 0;
  /** The last cards each comb printed, held so the indexes do not blink out. */
  let held: { subjects: Tab[]; origins: Tab[]; tongues: Tab[] } = {
    subjects: [],
    origins: [],
    tongues: [],
  };

  /** Do the rows in hand answer the scope on the page? */
  function rowsAnswerScope(): boolean {
    return rowsKey !== null && rowsKey === supersetKey(scope);
  }

  /**
   * Country centroids, accumulated from the geography the stations themselves
   * carry. The directory publishes no coordinates for a country, and a
   * hardcoded atlas is exactly the kind of authored table Law 1 forbids — so
   * the map places an origin only once real stations have told it where that
   * origin is, and leaves it unplotted until then. That prohibition stands:
   * everything below is still learned from live station geography and nothing
   * else.
   *
   * WHY THE CLOUD IS KEPT INSTEAD OF A RUNNING SUM.
   *
   * This was `{ lat, lon, n }` — three numbers per country, incremented as rows
   * arrived, divided on read. An arithmetic mean of coordinates, and it was
   * measurably wrong in the one place it is now read aloud:
   *
   *   Cold start, the idle pull. Eight Russian stations have loaded. Seven are
   *   in Moscow (55.7 N, 37.6 E). The eighth — "Radio Anonymous" — publishes
   *   −48.88, −123.39, which is Point Nemo in the South Pacific. The mean of
   *   the eight is **42.7 N, 17.5 E: the Adriatic Sea**, 2 000 km outside
   *   Russia, and that is the number the readout called RUSSIAN FEDERATION ·
   *   COUNTRY AVERAGE. Filter the comb to Russia, load 200 more rows, and the
   *   same station's origin moves to a different continent — the answer
   *   depended on what the user had clicked earlier.
   *
   * A mean has a breakdown point of zero: one bad fix in a thousand moves it,
   * and this feed publishes genuine rubbish (0,0 for Minnesota, Point Nemo for
   * Moscow). A **median** has a breakdown point of one half — it is unmoved
   * until half the country's stations are wrong — and it is order-independent,
   * which is what stops the same station answering two different things
   * depending on load order. Medians need the samples, not a sum, so the
   * samples are kept.
   *
   * Measured over the whole 62 038-station directory, centroids landing more
   * than 500 km from EVERY station of their own country: **7 with the mean, 1
   * with the median.** At the cold-start page: 2 with the mean, 0 that survive
   * the spread test below.
   *
   * Bounded by the directory, not by the session: `learned` holds the ids
   * already counted, so re-pulling the same rows — which the host does on every
   * scope change — adds nothing. 13 079 of the 62 038 stations carry any
   * geography at all, which is the ceiling on this map.
   */
  interface Cloud {
    lat: number[];
    lon: number[];
    /** The solved place, recomputed only after new samples land. */
    seat: Place | null;
    solved: boolean;
  }
  /**
   * Where a country is, as its own stations report it, and how well they agree.
   *
   * `spreadKm` is the median distance from `lat`/`lon` to the stations it was
   * solved from — a measurement of how much the point is standing in for, and
   * `null` when a single station is all there is and there is nothing to
   * measure agreement against.
   */
  interface Place {
    lat: number;
    lon: number;
    n: number;
    spreadKm: number | null;
  }
  const centroids = new Map<string, Cloud>();
  /** Station ids already folded in, so a re-pull cannot count one twice. */
  const learned = new Set<string>();

  /**
   * How far the typical station of a country may sit from the point drawn for
   * it before the point stops being an answer.
   *
   * Measured, not chosen. Over the whole directory the median station of the
   * United States is 1 323 km from the US centroid and Canada's is 1 003 km —
   * big countries, and the mark says so by growing (see `showOrigin`). Above
   * 2 000 km there is no country left, only a directory contradicting itself:
   * `UM` (United States Minor Outlying Islands) spreads 5 949 km across Samoa,
   * Scotland, San Francisco, Saudi Arabia and Virginia, `BQ` 4 069 km into the
   * mid-Atlantic, and at cold start `CN` is two stations 7 500 km apart whose
   * midpoint is western Tibet. Three countries in the whole feed, and every one
   * of them a place no station transmits from.
   *
   * So they are not placed at all, and Law 4 takes it from there: the marker
   * stays down and the readout says the directory has not said where this is.
   * That is also the minimum-sample rule, expressed as a measurement rather
   * than a count — two stations 4 000 km apart are not a sample of a country.
   */
  const SPREAD_MAX_KM = 2000;

  /** Median of a list of numbers. Sorts a copy; the caller's order is data. */
  function median(xs: readonly number[]): number {
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
  }

  /**
   * The median longitude, taken the only way a longitude can be.
   *
   * Longitude is an angle, and −179 and +179 are two degrees apart, not 358.
   * Sorting raw degrees would put Chukotka and Kaliningrad at opposite ends of
   * the list. So the circular mean fixes a reference direction — summed unit
   * vectors, `atan2`, which is the one longitude average with no seam — every
   * sample is unwrapped into the half-turn either side of it, and the median is
   * taken there and wrapped back.
   */
  function medianLon(lons: readonly number[]): number {
    let sx = 0;
    let sy = 0;
    for (const lon of lons) {
      sx += Math.cos(lon * DEG);
      sy += Math.sin(lon * DEG);
    }
    const ref = sx === 0 && sy === 0 ? 0 : Math.atan2(sy, sx) / DEG;
    const unwrapped = lons.map((lon) => {
      let d = lon - ref;
      while (d > 180) d -= 360;
      while (d < -180) d += 360;
      return ref + d;
    });
    let m = median(unwrapped);
    while (m > 180) m -= 360;
    while (m <= -180) m += 360;
    return m;
  }

  /**
   * Where a country is, solved from its cloud. Cached until new samples land.
   *
   * Every surface that places a country reads through here — the density dot,
   * the hover marker, the plate — so there is one answer and it is the same
   * one, which is the same reason `originOf` exists.
   */
  function place(code: string | undefined): Place | null {
    if (!code) return null;
    const cloud = centroids.get(code);
    if (!cloud) return null;
    if (!cloud.solved) {
      cloud.seat = solve(cloud);
      cloud.solved = true;
    }
    return cloud.seat;
  }

  function solve(cloud: Cloud): Place | null {
    const n = cloud.lat.length;
    if (n === 0) return null;
    const lat = median(cloud.lat);
    const lon = medianLon(cloud.lon);
    // One station is not an average and has nothing to disagree with. It is
    // still the best — and only — thing the country has said about itself.
    if (n < 2) return { lat, lon, n, spreadKm: null };
    const seat = { lat, lon };
    const spreadKm = median(cloud.lat.map((la, i) => kmApart(seat, { lat: la, lon: cloud.lon[i]! })));
    if (spreadKm > SPREAD_MAX_KM) return null;
    return { lat, lon, n, spreadKm };
  }

  /**
   * The fallback chain, and the whole of it. See `RegisterHandle.originOf`.
   *
   * Pure: no paint, no repaint, no signature, no timer. Everything that shows
   * an origin — the hover marker on the map, the lit cell on the plate — reads
   * through here, so there is exactly one answer to "where is this from?" and
   * two surfaces cannot disagree about it.
   */
  function originOf(station: StationRef | undefined): StationOrigin | null {
    if (!station) return null;
    const code = station.countryCode;
    const seat = place(code);
    const mean = seat ? { lat: seat.lat, lon: seat.lon } : null;
    if (station.geo) {
      // A fix is believed unless the station's OWN country contradicts it. The
      // feed carries genuine rubbish — a Minnesota station at longitude 0.0, a
      // California one at 2.1°E, a Wisconsin one at −74.0 — and over a 62 038
      // station snapshot **89 fixes sit more than 5 000 km from the cloud of
      // fixes their own country publishes**. Drawing a solid ring and lighting
      // a cell at full brightness for those states a measurement that two
      // fields of the same record disagree about.
      //
      // The test is against the LEARNED mean, not against an authored atlas:
      // the evidence is other stations in the same country, which is the same
      // evidence `centroids` is built from and the same prohibition-free
      // source. With no mean yet learned there is nothing to contradict the
      // fix with, so the fix stands.
      if (!mean || withinKm(station.geo, mean, FIX_MAX_KM)) {
        return {
          lat: station.geo.lat,
          lon: station.geo.lon,
          from: 'fix',
          countryCode: code,
        };
      }
      return { ...mean, from: 'country', countryCode: code, fixRejected: true };
    }
    if (!code || !mean) return null;
    return { ...mean, from: 'country', countryCode: code };
  }

  /**
   * How far a published fix may sit from its own country's learned mean.
   *
   * Deliberately enormous. This is not a border check and must never become
   * one: Russia is 9 000 km across and the United States reaches from Guam to
   * Puerto Rico, so a threshold tight enough to catch a state-level error would
   * throw away thousands of perfectly good fixes. 5 000 km catches "this
   * European station is at 0,0" and "this American one is in France" and
   * nothing else, which is exactly the population that was measured wrong.
   */
  const FIX_MAX_KM = 5000;

  /** Great-circle distance, in kilometres, without the trigonometry bill. */
  function kmApart(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
    const R = 6371;
    const dLat = (b.lat - a.lat) * DEG;
    // Longitude degrees shrink toward the poles, and the shorter way round the
    // world is the one that counts — 179°E and 179°W are two degrees apart.
    let dLon = Math.abs(b.lon - a.lon);
    if (dLon > 180) dLon = 360 - dLon;
    const meanLat = ((a.lat + b.lat) / 2) * DEG;
    const x = dLon * DEG * Math.cos(meanLat);
    return R * Math.hypot(dLat, x);
  }

  function withinKm(
    a: { lat: number; lon: number },
    b: { lat: number; lon: number },
    km: number,
  ): boolean {
    return kmApart(a, b) <= km;
  }

  /**
   * Change one or more axes of the scope.
   *
   * A *merge*, and it must only ever be used for changes that name the axis
   * they are changing. It cannot clear an axis that `EMPTY_SCOPE` forgot to
   * mention — which is exactly how RETURN ALL came to leave a station-name
   * search behind. Anything that means "set the scope to this" calls `apply`.
   */
  const emit = (next: Partial<RegisterScope>): void => apply({ ...scope, ...next });

  /**
   * Replace the scope outright, and repaint **synchronously**.
   *
   * Not `repaint()`: a `requestAnimationFrame` here leaves at least one frame,
   * and under load a good deal more, in which the caption says POP and every
   * number beside it is still the answer for the page before it. The paint that
   * voids those numbers has to be in the same task as the gesture that voided
   * them, or the register is publishing a wrong answer it already knows is
   * wrong. The full paint is a few hundred text writes over nodes that already
   * exist; it is cheaper than the frame it saves.
   */
  const apply = (next: RegisterScope): void => {
    scope = next;
    handlers.onScope(scope);
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    paintNow();
  };

  // -- combs ---------------------------------------------------------------

  interface CombHandle {
    root: HTMLElement;
    paint(
      tabs: Tab[],
      unsettled: boolean,
      onPick: (key: string) => void,
      /**
       * Terms the edition holds for what was typed but this scope does not, so
       * the empty drawer can point somewhere instead of only refusing.
       */
      elsewhere?: readonly string[],
    ): void;
    clearQuery(): void;
    focusHead(): void;
  }

  /**
   * One index: a type slot over a scroller of printed terms.
   *
   * Keyboard contract (FIX 5). It was `role="listbox"` over three hundred
   * native buttons, every one of them its own tab stop and none of them
   * reachable with an arrow key: 762 forward Tab presses from a pulled term to
   * CUT BAND, and Escape swallowed by the type slot the lid puts focus in. Now
   * the whole scroller is one tab stop with a roving `tabindex`, Up/Down,
   * Home/End, PageUp/PageDown and type-ahead, exactly as the ARIA listbox
   * pattern specifies — and the type slot passes Escape through to the lid, and
   * Down out of itself into the terms below.
   */
  function buildComb(
    key: 'subject' | 'origin' | 'tongue',
    title: string,
    hint: string,
    multi: boolean,
  ): CombHandle {
    const input = el('input', {
      class: 'comb__input',
      type: 'search',
      spellcheck: 'false',
      autocomplete: 'off',
      placeholder: hint,
      // Built from the engraved placeholder rather than restated, so what is
      // read out and what is printed in the channel cannot drift apart.
      'aria-label': `${hint[0]!.toUpperCase()}${hint.slice(1)} in the ${title} index`,
    }) as HTMLInputElement;
    const list = el('div', {
      class: 'comb__list',
      role: 'listbox',
      'aria-label': `${title} terms`,
      // The Subject and Tongue indexes really do combine with AND — two terms
      // narrow — so they say so. Origin is a single throw and does not.
      'aria-multiselectable': multi ? 'true' : null,
    });
    const none = el('div', { class: 'comb__none silk silk--xs' }, ['']);
    const count = el('span', { class: 'comb__n silk silk--xs' }, ['']);
    const root = el('div', { class: `comb comb--${key}` }, [
      el('div', { class: 'comb__head' }, [el('span', { class: 'silk comb__title' }, [title]), count]),
      el('div', { class: 'comb__slot' }, [input]),
      none,
      list,
    ]);
    // The decade rules the notch is read against, spaced by the one constant
    // that defines the scale rather than by a number copied into a stylesheet.
    root.style.setProperty('--notch-decade', `${NOTCH_DECADE_PCT}%`);

    interface Row {
      node: HTMLButtonElement;
      notch: HTMLElement;
      name: HTMLElement;
      cnt: HTMLElement;
      key: string;
      label: string;
    }
    const rows: Row[] = [];
    let shownCount = 0;
    let active = 0;
    let pick: (k: string) => void = () => {};
    const ahead = typeAhead();

    /** Exactly one printed term is a tab stop, and it is the active one. */
    function applyRoving(): void {
      for (let i = 0; i < shownCount; i++) {
        setAttr(rows[i]!.node, 'tabindex', i === active ? '0' : '-1');
      }
    }
    function goTo(i: number, focus: boolean): void {
      if (i < 0 || i >= shownCount) return;
      active = i;
      applyRoving();
      if (focus) {
        rows[i]!.node.focus();
        rows[i]!.node.scrollIntoView({ block: 'nearest' });
      }
    }

    list.addEventListener('keydown', (ev) => {
      const key2 = (ev as KeyboardEvent).key;
      if (key2 === 'Escape') return; // the lid's, not ours
      const moved = moveIndex(key2, active, shownCount, 'vertical');
      if (moved >= 0) {
        ev.preventDefault();
        goTo(moved, true);
        return;
      }
      if (key2 === 'Enter' || key2 === ' ') {
        ev.preventDefault();
        const row = rows[active];
        if (row?.key) pick(row.key);
        return;
      }
      if ((ev as KeyboardEvent).ctrlKey || (ev as KeyboardEvent).metaKey || (ev as KeyboardEvent).altKey) return;
      const labels: string[] = [];
      for (let i = 0; i < shownCount; i++) labels.push(rows[i]!.label);
      const hit = ahead(key2, labels, active);
      if (hit >= 0) {
        ev.preventDefault();
        goTo(hit, true);
      }
    });

    input.addEventListener('input', () => {
      combQuery[key] = input.value.trim();
      active = 0;
      repaint();
    });
    input.addEventListener('keydown', (ev) => {
      const key2 = (ev as KeyboardEvent).key;
      // Escape belongs to the lid from everywhere in the register, and this is
      // the element the lid puts focus in when it opens. Swallowing it here was
      // a trap with no way out that did not involve the mouse.
      if (key2 === 'Escape') return;
      if (key2 === 'ArrowDown') {
        ev.preventDefault();
        goTo(active, true);
        return;
      }
      /* ENTER THROWS THE TOP TERM.
       *
       * Typing `france` into the ORIGIN slot filtered the index to one term and
       * then did nothing at all with Enter: the throw needed ArrowDown to step
       * into the list and Enter there, and no printed thing said so. A type
       * slot over a filtered list that ignores Enter is a search box that does
       * not search. The top term is what the slot has filtered *to*, so that is
       * what it commits — and `active` is reset to 0 on every keystroke, so
       * with nothing arrowed to that is the first printed term.
       */
      if (key2 === 'Enter') {
        ev.preventDefault();
        ev.stopPropagation();
        // The filter is painted on the next frame (`repaint`), so between the
        // keystroke and that frame the printed terms are still the previous
        // query's. Enter must throw what the slot has filtered TO, so it settles
        // the paint first rather than committing a term that is one keystroke
        // out of date.
        paintNow();
        const row = rows[active] ?? rows[0];
        if (shownCount > 0 && row?.key) pick(row.key);
        return;
      }
      // Everything else is typing, and must not reach the lid's shortcuts.
      ev.stopPropagation();
    });

    return {
      root,
      clearQuery() {
        combQuery[key] = '';
        input.value = '';
      },
      focusHead() {
        input.focus();
      },
      paint(tabs, unsettled, onPick, elsewhere) {
        pick = onPick;
        const shown = tabs.slice(0, COMB_LIMIT);
        shownCount = shown.length;
        setText(
          count,
          unsettled
            ? UNKNOWN
            : tabs.length
              ? `${grp(tabs.length)}${
                  tabs.length > COMB_LIMIT
                    ? ` TERMS · TOP ${COMB_LIMIT} CUT`
                    : tabs.length === 1
                      ? ' TERM'
                      : ' TERMS'
                }`
              : 'NONE',
        );
        setFlag(root, 'is-unsettled', unsettled);
        // Law 4: an empty drawer says why it is empty, printed on card stock —
        // and, when the edition holds the term somewhere the scope excludes,
        // where to find it. A refusal a user cannot tell apart from a typo is
        // half a designed state.
        setText(
          none,
          shown.length
            ? ''
            : unsettled
              ? 'FETCHING THIS SCOPE…'
              : combQuery[key]
                ? elsewhere && elsewhere.length > 0
                  ? `"${combQuery[key].toUpperCase()}" IS NOT IN THIS SCOPE. THE EDITION HOLDS ${elsewhere.join(' · ')} — CLEAR ALL TO REACH THEM.`
                  : `NO ${title.toUpperCase()} TERM MATCHES "${combQuery[key].toUpperCase()}" IN THIS SCOPE`
                : `NO ${title.toUpperCase()} TERM IN THIS SCOPE`,
        );
        none.style.display = shown.length ? 'none' : 'block';

        for (let i = 0; i < shown.length; i++) {
          let row = rows[i];
          if (!row) {
            const notch = el('span', { class: 'comb__notch' });
            const name = el('span', { class: 'comb__name' });
            const cnt = el('span', { class: 'comb__cnt' });
            const node = el('button', {
              class: 'comb__tab', type: 'button', role: 'option', tabindex: '-1',
            }, [notch, name, cnt]) as HTMLButtonElement;
            row = { node, notch, name, cnt, key: '', label: '' };
            const entry = row;
            const at = i;
            node.addEventListener('click', () => {
              active = at;
              applyRoving();
              if (entry.key) pick(entry.key);
            });
            rows[i] = row;
            list.append(node);
          }
          const tab = shown[i]!;
          row.key = tab.key;
          row.label = tab.label;
          // The card says out loud what it folded. `TRIP-HOP · 3 SPELLINGS` is
          // one card where the directory holds three separate tags, and the
          // register is the only place that fact can be read.
          setText(
            row.name,
            tab.spellings && tab.spellings > 1 ? `${tab.label} · ${tab.spellings} SPELLINGS` : tab.label,
          );
          // FIX 1: an unknown count prints as unknown. It never prints the
          // count this term had under a scope the user has already left.
          setText(row.cnt, tab.unknown ? UNKNOWN : tab.count ? grp(tab.count) : UNKNOWN);
          // FIX 3: depth on the fixed decade scale — the same term cuts the
          // same depth in every scope, in every comb, in every edition.
          row.notch.style.setProperty('--w', tab.unknown ? '0%' : `${notchPct(tab.count).toFixed(1)}%`);
          setFlag(row.node, 'is-on', tab.pulled);
          setFlag(row.node, 'is-empty', !tab.unknown && !tab.count && !tab.pulled);
          setAttr(row.node, 'aria-selected', String(tab.pulled));
          // Settled, the term and its printed count *are* the accessible name,
          // read straight off the card. Only the em-dash needs saying in words.
          if (tab.unknown) setAttr(row.node, 'aria-label', `${tab.label}, count not yet known`);
          else if (row.node.hasAttribute('aria-label')) row.node.removeAttribute('aria-label');
          row.node.style.display = '';
        }
        for (let i = shown.length; i < rows.length; i++) {
          rows[i]!.node.style.display = 'none';
          setAttr(rows[i]!.node, 'tabindex', '-1');
        }
        if (active >= shownCount) active = 0;
        applyRoving();
      },
    };
  }

  const combSubject = buildComb('subject', 'Subject', 'find a term', true);
  const combOrigin = buildComb('origin', 'Origin', 'find a country', false);
  const combTongue = buildComb('tongue', 'Tongue', 'find a language', true);

  // -- the sheet -----------------------------------------------------------

  const sheetScope = el('div', { class: 'sheet__scope' }, [UNKNOWN]);
  const sheetCount = el('div', { class: 'sheet__count' }, ['']);
  const sheetNote = el('div', { class: 'sheet__note silk silk--xs' }, ['']);
  const sheetBody = el('div', { class: 'sheet__rows', role: 'listbox', 'aria-label': 'Station entries' });
  const sheetSpacer = el('div', { class: 'sheet__spacer' });
  const sheetPad = el('div', { class: 'sheet__pad' });
  sheetBody.append(sheetSpacer, sheetPad);

  /**
   * A bank of piano keys that are one choice out of several — which is a radio
   * group, and had been three unlabelled `div`s of `aria-pressed` buttons. One
   * tab stop, arrow keys along the bank, and the bank says what it is for.
   */
  type KeyBank = HTMLElement & { paint(): void };

  function keyBank(
    cls: string,
    groupLabel: string,
    keys: Array<[string, string]>,
    get: () => string,
    set: (v: string) => void,
  ): KeyBank {
    const bank = el('div', { class: cls, role: 'radiogroup', 'aria-label': groupLabel });
    const buttons: HTMLElement[] = [];
    const move = (i: number): void => {
      const button = buttons[i];
      if (!button) return;
      button.focus();
      set(button.dataset.v!);
    };
    for (const [value, label] of keys) {
      const button = el('button', {
        class: `${cls}__key`, type: 'button', role: 'radio',
        'aria-checked': 'false', 'aria-pressed': 'false', tabindex: '-1',
      }, [label]);
      button.dataset.v = value;
      button.addEventListener('click', () => set(value));
      buttons.push(button);
      bank.append(button);
    }
    bank.addEventListener('keydown', (ev) => {
      const key = (ev as KeyboardEvent).key;
      if (key === 'Escape') return;
      const at = buttons.findIndex((b) => b.dataset.v === get());
      const moved = moveIndex(key, at < 0 ? 0 : at, buttons.length, 'horizontal');
      if (moved < 0) return;
      ev.preventDefault();
      move(moved);
    });
    return Object.assign(bank, {
      paint(): void {
        for (const button of buttons) {
          const on = button.dataset.v === get();
          setAttr(button, 'aria-checked', String(on));
          // `aria-pressed` is meaningless on `role="radio"` and assistive tech
          // ignores it — it is kept in step purely because the shared piano-key
          // styling lives in `controls.css`, which this slice does not own.
          setAttr(button, 'aria-pressed', String(on));
          setAttr(button, 'tabindex', on ? '0' : '-1');
        }
        // Nothing selected would leave the bank unreachable by Tab.
        if (!buttons.some((b) => b.getAttribute('tabindex') === '0') && buttons[0]) {
          setAttr(buttons[0], 'tabindex', '0');
        }
      },
    });
  }

  const SORT_KEYS: Array<[SortKey, string]> = [
    ['listeners', 'Listeners'],
    ['votes', 'Votes'],
    ['bitrate', 'Bitrate'],
    ['checked', 'Checked'],
    ['name', 'A–Z'],
  ];
  const sortBank = keyBank(
    'pianolite',
    'Order the entries by',
    SORT_KEYS,
    () => sort,
    (v) => {
      sort = v as SortKey;
      repaint();
    },
  );

  const textSlot = el('input', {
    class: 'comb__input',
    type: 'search',
    spellcheck: 'false',
    autocomplete: 'off',
    placeholder: 'station name',
    'aria-label': 'Search station names',
  }) as HTMLInputElement;
  let textTimer = 0;
  textSlot.addEventListener('input', () => {
    window.clearTimeout(textTimer);
    // Free text is the one axis that can reach the network on its own, so it
    // waits for the hand to stop. Everything else is a discrete throw.
    textTimer = window.setTimeout(() => emit({ text: textSlot.value.trim() || undefined }), 260);
  });
  /**
   * A hand waiting in the NAME slot for the entries it just asked for.
   *
   * Enter here means "that is the name, now show me it", and the honest answer
   * has to wait: the free-text axis is the one that reaches the network, so the
   * rows that answer what was typed do not exist yet at the moment Enter is
   * pressed. Moving to the ledger's top row immediately would move to the top
   * row of the PREVIOUS search. So the move is armed here and spent in
   * `setRows`, when the rows it is about have actually arrived.
   */
  let awaitingEntries = 0;
  function armLedgerJump(): void {
    window.clearTimeout(awaitingEntries);
    // …and spent anyway if no rows come, because the scope may not have changed
    // at all (Enter on a search already committed by the debounce), and a hand
    // that pressed Enter must not be left in the slot with nothing said.
    awaitingEntries = window.setTimeout(() => {
      awaitingEntries = 0;
      if (view.rows.length) sheetGoTo(0, true);
    }, 700);
  }
  function spendLedgerJump(): void {
    if (!awaitingEntries) return;
    window.clearTimeout(awaitingEntries);
    awaitingEntries = 0;
    if (view.rows.length) sheetGoTo(0, true);
  }

  textSlot.addEventListener('keydown', (ev) => {
    const key = (ev as KeyboardEvent).key;
    // Escape closes the lid from here too. Everything else is typing.
    if (key === 'Escape') return;
    if (key === 'Enter') {
      ev.preventDefault();
      ev.stopPropagation();
      // The debounce exists so the network is not asked on every keystroke; a
      // deliberate Enter is the hand saying it has stopped, so it is spent now.
      window.clearTimeout(textTimer);
      emit({ text: textSlot.value.trim() || undefined });
      armLedgerJump();
      return;
    }
    ev.stopPropagation();
  });

  const sheetEmptyBig = el('div', { class: 'sheet__empty-big' }, ['NO ENTRY']);
  const sheetEmptyA = el('span', { class: 'silk silk--xs' }, ['']);
  const sheetEmptyB = el('span', { class: 'silk silk--xs' }, ['']);

  // -- the fault strip: FIX 6, an answer where the click was made ------------

  const faultBig = el('div', { class: 'reg-fault__big' }, ['']);
  const faultWhy = el('span', { class: 'reg-fault__why silk silk--xs' }, ['']);
  const faultWhere = el('span', { class: 'reg-fault__where silk silk--xs' }, ['']);
  const faultAct = el('button', {
    class: 'reg-fault__act btn-bevel pushbtn', type: 'button',
    'aria-label': 'Reconnect to the station that failed',
  }, [el('span', { class: 'silk' }, ['Reconnect'])]);
  if (handlers.onReconnect) faultAct.addEventListener('click', () => handlers.onReconnect?.());
  const faultBar = el('div', {
    class: 'reg-fault',
    // A live region, because the fault does not arrive from a gesture: the
    // engine reports it up to a second after the click that caused it.
    role: 'status', 'aria-live': 'polite',
  }, handlers.onReconnect
    ? [faultBig, faultWhy, faultWhere, faultAct]
    : [faultBig, faultWhy, faultWhere]);
  faultBar.style.display = 'none';

  const sheet = el('div', { class: 'sheet' }, [
    el('div', { class: 'sheet__cap' }, [
      sheetScope,
      // The one instruction the ledger needs, engraved on the ledger, in the
      // words the ledger itself uses (FIX 4).
      el('span', { class: 'sheet__use silk silk--xs' }, ['Click an entry to take it on air']),
      sheetCount,
    ]),
    // Directly under the instruction it answers: the ledger says "click an
    // entry to take it on air", so this is where "that one did not come up"
    // belongs. Anywhere else and the open lid hides it.
    faultBar,
    el('div', { class: 'sheet__sort' }, [
      el('span', { class: 'silk silk--xs' }, ['Order By']),
      sortBank,
      sheetNote,
      el('span', { class: 'silk silk--xs sheet__namelab' }, ['Name']),
      el('div', { class: 'comb__slot sheet__slot' }, [textSlot]),
    ]),
    el('div', { class: 'sheet__cols' }, [
      el('span', {}, ['']),
      el('span', {}, ['Station']),
      el('span', {}, ['Orig']),
      el('span', {}, ['Lang']),
      el('span', {}, ['Index Terms']),
      el('span', { class: 'num' }, ['kbps']),
      el('span', {}, ['Codec']),
      el('span', { class: 'num' }, ['Listeners']),
      el('span', { class: 'num' }, ['Checked']),
    ]),
    sheetBody,
    el('div', { class: 'sheet__empty' }, [sheetEmptyBig, sheetEmptyA, sheetEmptyB]),
    el('div', { class: 'sheet__glass mat-glass' }),
  ]);

  interface SheetRow {
    node: HTMLButtonElement;
    blip: HTMLElement;
    name: HTMLElement;
    cc: HTMLElement;
    lang: HTMLElement;
    tags: HTMLElement;
    kbps: HTMLElement;
    codec: HTMLElement;
    listeners: HTMLElement;
    checked: HTMLElement;
    id: string;
    /**
     * The whole row, kept so the hover handlers can ask where it is from.
     *
     * `id` alone cannot answer that: `originOf` needs `geo` and `countryCode`,
     * and a lookup by id would be a scan of the whole population on every row
     * a pointer crosses. Cleared with `id` when the slot is recycled empty.
     */
    station?: StationRef;
  }
  const sheetRows: SheetRow[] = [];
  /**
   * The slot the pointer (or the focus ring) is currently over, if any.
   *
   * The ledger is VIRTUALISED: a wheel under a stationary pointer changes what
   * a recycled node is showing without firing `pointerleave` or `pointerenter`,
   * because the node itself never moved. CSS `:hover` follows the pointer, so
   * the tinted line said Japan while the map still marked Australia and the
   * readout still named the Australian station — a measured, easy-to-hit Law 2
   * defect, since wheeling with the pointer over the list is the ordinary way
   * to read it.
   *
   * Holding the SLOT rather than the station is what makes the repair cheap:
   * `paintSheet` re-reads `hoverRow.station` once at the end of a repaint, not
   * once per row, so a repaint costs one extra `showOrigin` however many
   * hundred lines it rewrote.
   */
  let hoverRow: SheetRow | undefined;
  /**
   * FIX 9 — WHERE THE POINTER ACTUALLY IS, BECAUSE THE SLOT IS NOT ENOUGH.
   *
   * Holding the slot fixed the first half of this: the recycled node keeps its
   * identity across a scroll, so re-reading `hoverRow.station` at the end of a
   * repaint at least reports a station the node is *currently* showing. It does
   * not report the station under the HAND. Measured on the shipping build with
   * the pointer parked and one wheel notch: `first` jumps by four rows while
   * the slot's screen position moves by less than one, so the slot the browser
   * last named is four lines from the one the pointer is over — and Chromium
   * does not re-run its hover hit test until the scroll settles, which was
   * **218–317 ms** on this machine. Traced: scroll at t=376902, foot printed
   * THE BIG 80S STATION at t=376913, corrected to FOX NEWS RADIO at t=377220.
   * For a third of a second the map marked a country nothing pointed at.
   *
   * So the row is COMPUTED from the pointer's own Y whenever there is one. The
   * ledger is a uniform 17 px rule, which makes that one subtraction and one
   * divide — no `elementFromPoint`, no rect read, nothing the paint loop pays
   * for. `sheetClientTop` is read once when the hand arrives at the scroller,
   * on a layout nothing has dirtied yet, and again whenever the sheet resizes.
   */
  let hoverY: number | null = null;
  let sheetClientTop = 0;
  let sheetTop = 0;
  let sheetView = 320;
  /** Absolute index of the ledger's single tab stop. */
  let sheetActive = 0;
  const sheetAhead = typeAhead();

  sheetBody.addEventListener('scroll', () => {
    sheetTop = sheetBody.scrollTop;
    paintSheet();
  });

  /**
   * The pointer's Y, and the scroller's top edge — the two numbers `markedRow`
   * needs and the only two it reads from outside itself.
   *
   * `pointerenter` on the SCROLLER, not on the rows: it fires once when the
   * hand arrives at the ledger, which is the moment layout is guaranteed clean
   * (the browser has just hit-tested and this handler has not written anything
   * yet), so the rect read is free. `pointermove` after that is a single number
   * assignment — no measurement, no paint, nothing that can be seen.
   */
  const pointerY = (ev: Event): number | null => {
    // jsdom has no `PointerEvent` and the DOM tests dispatch a bare `Event`, so
    // this is `undefined` there and the slot remains the answer — which is what
    // those tests pin. It is also `undefined` for a synthetic click.
    const y = (ev as PointerEvent).clientY;
    return typeof y === 'number' && Number.isFinite(y) ? y : null;
  };
  sheetBody.addEventListener('pointerenter', (ev) => {
    sheetClientTop = sheetBody.getBoundingClientRect().top;
    hoverY = pointerY(ev);
  });
  sheetBody.addEventListener('pointermove', (ev) => {
    hoverY = pointerY(ev);
  });
  sheetBody.addEventListener('pointerleave', () => {
    hoverY = null;
  });

  /**
   * The ledger, keyed. It is virtualised — only the rows under the glass exist
   * — so the roving `tabindex` rides whichever recycled node currently holds
   * the active absolute index, and the scroller is moved first so that node
   * exists before focus goes to it.
   */
  function sheetGoTo(next: number, focus: boolean): void {
    const n = view.rows.length;
    if (n === 0) return;
    sheetActive = clamp(next, 0, n - 1);
    const top = sheetActive * ROW_H;
    if (top < sheetBody.scrollTop) sheetBody.scrollTop = top;
    else if (top + ROW_H > sheetBody.scrollTop + sheetView) {
      sheetBody.scrollTop = top + ROW_H - sheetView;
    }
    sheetTop = sheetBody.scrollTop;
    paintSheet();
    if (!focus) return;
    const first = Math.max(0, Math.floor(sheetTop / ROW_H) - 3);
    sheetRows[sheetActive - first]?.node.focus();
  }

  sheetBody.addEventListener('keydown', (ev) => {
    const key = (ev as KeyboardEvent).key;
    if (key === 'Escape') return;
    const moved = moveIndex(key, sheetActive, view.rows.length, 'vertical');
    if (moved >= 0) {
      ev.preventDefault();
      sheetGoTo(moved, true);
      return;
    }
    if (key === 'Enter' || key === ' ') {
      ev.preventDefault();
      const station = view.rows[sheetActive];
      if (station) handlers.onSelect(station.id);
      return;
    }
    if ((ev as KeyboardEvent).ctrlKey || (ev as KeyboardEvent).metaKey || (ev as KeyboardEvent).altKey) return;
    const hit = sheetAhead(key, view.rows.map((s) => s.name), sheetActive);
    if (hit >= 0) {
      ev.preventDefault();
      sheetGoTo(hit, true);
    }
  });
  // Both of these are cached rather than read during paint. Reading
  // scrollTop/clientHeight inside the paint forces a synchronous layout of the
  // whole lid — three combs, three hundred tabs and an SVG map — on every
  // keystroke, which is the difference between a mechanical instrument and a
  // web page.
  const sheetRo = new ResizeObserver((entries) => {
    sheetView = entries[0]!.contentRect.height || 320;
    sheetTop = sheetBody.scrollTop;
    // A resized sheet is the one thing that moves the scroller's top edge
    // without a pointer crossing into it. `contentRect` is handed over, so this
    // costs nothing; the offset still has to come from the element.
    sheetClientTop = sheetBody.getBoundingClientRect().top;
    paintSheet();
  });
  sheetRo.observe(sheetBody);

  /**
   * The ledger row the hand is on — computed when there is a pointer, and the
   * recycled slot's own row when there is not (keyboard focus, and jsdom).
   *
   * This is the single answer the mark, the words and nothing else read. See
   * the note at `hoverY`.
   */
  function markedRow(): StationRef | undefined {
    if (!hoverRow) return undefined;
    if (hoverY === null) return hoverRow.station;
    const at = Math.floor((hoverY - sheetClientTop + sheetTop) / ROW_H);
    // Off the end of the ledger is not "the last row I remember": it is no row,
    // and a mark that stayed up over blank paper would be exactly the lie this
    // function exists to stop.
    return at >= 0 && at < view.rows.length ? view.rows[at] : undefined;
  }

  function paintSheet(): void {
    const rows = view.rows;
    const n = rows.length;
    const faulted = faultStation();
    if (sheetTop > n * ROW_H) {
      sheetTop = 0;
      sheetBody.scrollTop = 0;
    }
    setText(sheetScope, scopeCaption(scope, originName));
    // FIX 1. `printing` is checked first and beats everything: while it is on,
    // `n` is zero by construction and there is no number to print.
    setText(
      sheetCount,
      printing
        ? 'PRINTING…'
        : rowFault
          ? 'NOT PRINTED'
          : n === 1
            ? '1 ENTRY'
            : `${grp(n)} ENTRIES`,
    );
    setFlag(sheet, 'is-empty', n === 0);
    setFlag(sheet, 'is-loading', printing);
    // Re-pulling a population the rows in hand already answer. The numbers stay
    // up because they are still exact; the sheet just says the press is warm.
    setFlag(sheet, 'is-repulling', loading && !printing);

    // Law 4: three different reasons for an empty sheet, three different sheets.
    if (printing) {
      setText(sheetEmptyBig, 'PRINTING');
      setText(sheetEmptyA, 'FETCHING THIS SCOPE FROM THE DIRECTORY.');
      paintPrintClock();
    } else if (rowFault) {
      setText(sheetEmptyBig, 'NOT PRINTED');
      setText(sheetEmptyA, rowFault);
      setText(sheetEmptyB, 'THROW REPRINT EDITION, OR PRESS RECONNECT ON THE PANEL.');
    } else if (n === 0) {
      // Only when the sheet is actually empty. `soleExclusions` walks every row
      // in hand calling `groupKey()` per tag (an NFD normalise and two regexes
      // each) and `rejectedBy()` with all eight predicates and no short-circuit
      // — up to SCOPE_LIMIT = 10 000 rows. It was being run on every paint to
      // compose a sentence that only ever appears behind `.is-empty`, so a
      // register with rows in it paid the entire cost to write text nobody
      // could see. Its own contract already said "runs only when the sheet is
      // empty"; this is that contract, enforced.
      //
      // FIX 5 — the empty sheet names the filter that emptied it, computed from
      // which predicate actually removed the rows.
      //
      // It used to print a fixed couplet: "No station in this edition carries
      // every term in the scope. Take a term out of the scope, or lower the
      // quality bar." Searching `BBC Radio 3` with HIDE HLS engaged printed
      // exactly that — and turning HIDE HLS off returned five rows immediately.
      // The two switches that caused the emptiness were the two the message did
      // not mention, and a remedy that names the wrong control is worse than no
      // remedy: the user takes a term out, nothing happens, and the register has
      // taught them it does not know why it is empty.
      //
      // `soleExclusions` counts only rows a *single* filter withholds, so every
      // number printed here is a promise the switch beside it can keep.
      setText(sheetEmptyBig, 'NO ENTRY');
      const blame = soleExclusions(stations, scope, index, originName);
      if (stations.length === 0) {
        setText(sheetEmptyA, 'The directory returned no station at all for this scope.');
        setText(sheetEmptyB, 'Take a term out of the scope, or throw Clear All.');
      } else if (blame.length > 0) {
        setText(
          sheetEmptyA,
          `${grp(stations.length)} ROW${stations.length === 1 ? '' : 'S'} CAME BACK; EVERY ONE IS FILTERED OUT.`,
        );
        setText(
          sheetEmptyB,
          `TAKE ONE OUT AND THEY RETURN — ${blame
            .map((one) => `${one.label} ${grp(one.count)}`)
            .join(' · ')}`,
        );
      } else {
        setText(
          sheetEmptyA,
          `${grp(stations.length)} ROW${stations.length === 1 ? '' : 'S'} CAME BACK; EVERY ONE IS FILTERED OUT.`,
        );
        // Every withheld row was rejected by two filters or more, so no single
        // one of them can be blamed — and saying so is the honest answer.
        setText(sheetEmptyB, 'NO SINGLE FILTER IS RESPONSIBLE. TAKE TWO OUT, OR THROW CLEAR ALL.');
      }
    }
    setText(sheetNote, sheetNoteText(n));
    setFlag(sheetNote, 'is-warning', !!rowWarning && !printing);

    sheetSpacer.style.height = `${n * ROW_H}px`;
    const first = Math.max(0, Math.floor(sheetTop / ROW_H) - 3);
    const visible = Math.ceil(sheetView / ROW_H) + 7;
    sheetPad.style.transform = `translateY(${first * ROW_H}px)`;

    for (let k = 0; k < visible; k++) {
      let row = sheetRows[k];
      if (!row) {
        const blip = el('span', { class: 'entry__blip' });
        const name = el('span', { class: 'entry__name' });
        const cc = el('span', { class: 'entry__cc' });
        const lang = el('span', { class: 'entry__lang' });
        const tags = el('span', { class: 'entry__tags' });
        const kbps = el('span', { class: 'entry__kbps num' });
        const codec = el('span', { class: 'entry__codec' });
        const listeners = el('span', { class: 'entry__lis num' });
        const checked = el('span', { class: 'entry__chk num' });
        const node = el('button', {
          class: 'entry', type: 'button', role: 'option', tabindex: '-1',
        }, [blip, name, cc, lang, tags, kbps, codec, listeners, checked]) as HTMLButtonElement;
        row = { node, blip, name, cc, lang, tags, kbps, codec, listeners, checked, id: '' };
        const entry = row;
        const slot = k;
        node.addEventListener('click', () => {
          sheetActive = Math.max(0, Math.floor(sheetTop / ROW_H) - 3) + slot;
          if (entry.id) handlers.onSelect(entry.id);
        });
        // Once per RECYCLED SLOT, which is a couple of dozen for the session —
        // never inside the paint loop, which runs for every row on every
        // keystroke. They read `entry.station` at event time, exactly as the
        // click above reads `entry.id`, so a recycled node reports the row it
        // is currently showing rather than the one it was built for.
        node.addEventListener('pointerenter', (ev) => {
          hoverRow = entry;
          // The browser has just told us, authoritatively, which row the hand
          // is on; take its word rather than re-deriving it from a coordinate
          // that is exactly on a row boundary at this instant.
          hoverY = pointerY(ev);
          // A pointer that was already sitting where a row appeared can reach a
          // row without the scroller ever seeing a `pointerenter`. Without an
          // offset the computed index is nonsense, so it is taken here — once,
          // only in that case, and on a layout this handler has not dirtied.
          if (hoverY !== null && sheetClientTop === 0) {
            sheetClientTop = sheetBody.getBoundingClientRect().top;
          }
          showOrigin(entry.station);
        });
        node.addEventListener('pointerleave', () => {
          if (hoverRow === entry) hoverRow = undefined;
          hideOrigin();
        });
        // The ledger is a roving-tabindex listbox, so arrowing down it is the
        // same gesture as running a pointer down it and earns the same map.
        node.addEventListener('focusin', () => {
          hoverRow = entry;
          showOrigin(entry.station);
        });
        node.addEventListener('focusout', () => {
          if (hoverRow === entry) hoverRow = undefined;
          hideOrigin();
        });
        sheetRows[k] = row;
        sheetPad.append(node);
      }
      const station = rows[first + k];
      if (!station) {
        row.node.style.display = 'none';
        row.id = '';
        // A recycled empty slot must not report the origin of the row it used
        // to hold — that is a marker on the map for a line that is not there.
        row.station = undefined;
        setAttr(row.node, 'tabindex', '-1');
        continue;
      }
      row.node.style.display = '';
      row.id = station.id;
      row.station = station;
      // Display policy only — `StationRef.name` stays the identity the presets
      // and the directory agree on.
      setText(row.name, displayStationName(station.name, 46));
      setText(row.cc, station.countryCode ?? '—');
      setText(row.lang, (station.language ?? '').slice(0, 3).toUpperCase() || '—');
      setText(row.tags, station.tags.slice(0, 4).join(' · ').toUpperCase() || '—');
      setText(row.kbps, station.claimedBitrate ? String(station.claimedBitrate) : '—');
      setText(row.codec, station.hls ? 'HLS' : (station.claimedCodec ?? '—').toUpperCase());
      setText(row.listeners, station.clickCount ? grp(station.clickCount) : '—');
      setText(row.checked, station.lastCheckOk === false ? 'FAIL' : ageStr(station.lastCheckAgeDays));
      // The tri-state, on the row that was clicked. `is-onair` is the on-air
      // blip and means the decoder is producing audio and nothing else;
      // `is-trying` is the amber cue while the engine is working on it.
      const isSubject = station.id === airId;
      setFlag(row.node, 'is-onair', isSubject && air === 'on');
      setFlag(row.node, 'is-trying', isSubject && air === 'trying');
      // FIX 6: the line that was clicked and did not come up is marked on the
      // ledger, so the answer is beside the gesture and not only in the strip.
      //
      // Two witnesses, one fact. `setAir` reports it as the row's own state and
      // `setPlayback` reports it as the strip's subject; they cannot disagree,
      // because the faceplate derives both from the same `PlaybackState` in the
      // same `render()`. Either alone is enough to mark the line, which is what
      // lets a caller that only has one of the two channels still be correct.
      setFlag(row.node, 'is-faulted', (isSubject && air === 'failed') || station.id === faulted);
      // Law 4: printed, struck and dated — never quietly missing.
      setFlag(row.node, 'is-dead', station.lastCheckOk === false);
      setFlag(row.node, 'is-hls', !!station.hls);
      // Selection is on-air and nothing else: a screen reader must not be told
      // a row is selected because someone clicked it and it failed.
      setAttr(row.node, 'aria-selected', String(isSubject && air === 'on'));
    }
    for (let k = visible; k < sheetRows.length; k++) {
      sheetRows[k]!.node.style.display = 'none';
      setAttr(sheetRows[k]!.node, 'tabindex', '-1');
    }

    // One tab stop for the whole ledger. If the active entry has been scrolled
    // out of the rendered window the stop follows to the top visible line, so
    // there is always exactly one and Tab never lands on nothing.
    if (n > 0) {
      if (sheetActive < first || sheetActive >= first + visible) sheetActive = clamp(first + 3, 0, n - 1);
      sheetActive = clamp(sheetActive, 0, n - 1);
      for (let k = 0; k < sheetRows.length; k++) {
        const node = sheetRows[k]!.node;
        if (node.style.display === 'none') continue;
        setAttr(node, 'tabindex', first + k === sheetActive ? '0' : '-1');
      }
    }

    // The line under the pointer is now a different station than it was a
    // moment ago, and no pointer event said so. See `hoverY`. One call at the
    // end of the repaint, never one per row; `showOrigin` is a `transform`
    // attribute and two flags, and it is idempotent when nothing moved.
    if (hoverRow) showOrigin(markedRow());
  }

  /**
   * FIX 6 — the register answers, on itself, for the click made on itself.
   *
   * Three phases are printed here, and only three, because they are the three a
   * listener can act on: `error` is terminal and carries a reason; `stalled` is
   * dead air on a stream that was working; `reconnecting` is the AFC already
   * doing something about it and is an amber note rather than a fault. Every
   * other phase is either normal running or a state the sheet's own count
   * already describes, and printing a bar for those would be a panel that cries
   * wolf. Nothing here is inferred — it is `PlaybackState` as handed over.
   */
  function faultStation(): string | undefined {
    if (!playback) return undefined;
    if (playback.phase !== 'error' && playback.phase !== 'stalled') return undefined;
    return playback.station?.id;
  }

  function paintFault(): void {
    const phase = playback?.phase;
    const up = phase === 'error' || phase === 'stalled' || phase === 'reconnecting';
    faultBar.style.display = up ? '' : 'none';
    setFlag(faultBar, 'is-advice', phase === 'reconnecting');
    if (!up || !playback) return;

    const name = playback.station ? displayStationName(playback.station.name, 40) : '';
    if (phase === 'error') {
      const error = playback.error;
      setText(faultBig, error ? `FAULT · ${FAULT_WORDS[error.kind]}` : 'FAULT');
      // The engine guarantees `message` is a sentence for a listener rather
      // than a diagnostic, so it is printed verbatim.
      setText(faultWhy, error?.message ?? '');
      setText(
        faultWhere,
        name
          ? `${name.toUpperCase()} DID NOT COME UP${error && error.attempts > 1 ? ` · ${error.attempts} ATTEMPTS` : ''}`
          : '',
      );
    } else if (phase === 'stalled') {
      const words = stalledWords(playback);
      setFlag(faultBar, 'is-advice', words.advice);
      setText(faultBig, words.headline);
      setText(faultWhy, words.why);
      setText(faultWhere, name ? (words.advice ? `${name.toUpperCase()} IS STILL ON AIR` : `${name.toUpperCase()} WAS ON AIR`) : '');
    } else {
      const retry = playback.retry;
      setText(faultBig, 'RE-LOCKING');
      setText(
        faultWhy,
        retry
          ? `ATTEMPT ${retry.attempt} OF ${retry.budget} · MOUNT ${retry.mount} OF ${retry.mounts}`
          : 'The receiver is trying the station again.',
      );
      setText(faultWhere, name ? name.toUpperCase() : '');
    }
  }

  /**
   * How long the press has been running, in tenths, on the sheet.
   *
   * A blank that says nothing for 1 733 ms is the same defect wearing different
   * clothes — the user cannot tell a slow directory from a hung one. This is a
   * real elapsed measurement, not an animation pretending to be progress.
   */
  function paintPrintClock(): void {
    if (!printing) return;
    setText(sheetEmptyB, `${((Date.now() - printingSince) / 1000).toFixed(1)} S`);
  }

  /**
   * The line printed beside the sort bank, and the one place the register
   * reconciles its two honest numbers.
   *
   * The index card prints the directory's own count for a folded term — 46 for
   * `trip-hop`, being 24 + 14 + 8 across three tags. The sheet prints the rows
   * the directory actually returned, deduplicated on station id, which is 39,
   * because eight stations carry two spellings of the same tag. Both are true
   * and they are not the same measurement, so the register says which is which
   * rather than quietly printing one and hoping nobody adds up the other.
   */
  function sheetNoteText(rows: number): string {
    // Nothing is reconciled against nothing: while the press is running there
    // is no count on this sheet to compare the index's claim to.
    if (printing) return '';
    if (rowWarning) return rowWarning;
    if (rowFault) return '';
    if (view.global) return 'COUNTS CUT AGAINST THE WHOLE EDITION';
    // Only when the term is the *only* card out. With an origin also pulled,
    // 104 is jazz-in-France and comparing it to the index's 1 184 would be
    // arithmetic about two different questions.
    const termOnly: boolean =
      scope.terms.length === 1 &&
      scope.tongues.length === 0 &&
      !scope.origin &&
      !scope.text &&
      scope.minKbps === 0 &&
      scope.codec === 'ANY';
    if (termOnly && index) {
      const term = index.subjects.find((s) => s.name === scope.terms[0]);
      if (term && term.stationCount !== rows) {
        return `INDEX CLAIMS ${grp(term.stationCount)} ACROSS ${term.spellings.length} SPELLING${term.spellings.length > 1 ? 'S' : ''} · ${grp(rows)} DISTINCT STATION${rows === 1 ? '' : 'S'}`;
      }
    }
    return '';
  }

  // -- the origin map ------------------------------------------------------

  /**
   * THE FOOT OF THE MAP, WRITTEN IN FOUR SEGMENTS SO THE CLOCK CANNOT FALL OFF.
   *
   * It was one text node with `white-space: nowrap; text-overflow: ellipsis` in
   * a box that is **300 px at every window size** — `.reg-right` is a fixed
   * grid track, so widening the chassis to 1920 does not give this line one
   * extra pixel. Measured over 14 ledger rows, SEVEN overflowed: NPR 24 Hour
   * Program Stream 421 px, Z100 403, Radio Anonymous 391, BBC World Service
   * 381, 101 Smooth Jazz 361, KIIS FM 342, Radio Paradise 309. CNN alone
   * measures 302.8 in 300.
   *
   * One text node can only elide at its END, and the end of this line is the
   * local clock — the one field the listener is choosing by. Observed on the
   * shipping build: `≈18:10 LOC…`, and `UNITED KINGDOM OF GREAT B… · COUNTRY
   * AV…` with the clock gone entirely.
   *
   * So the line is four flex items with explicit shrink weights, and the clock
   * is the one that cannot shrink. The country name gives way first (it is the
   * longest field and still identifies when clipped), then the qualifier, then
   * the station name — which the listener can also read on the tinted row their
   * pointer is sitting on. `textContent` is byte-identical to the single-node
   * version, separators included, because the separator travels with the field
   * it introduces and disappears with it.
   */
  const readName = el('span', { class: 'mapread mapread--name' });
  const readWhere = el('span', { class: 'mapread mapread--where' });
  const readQual = el('span', { class: 'mapread mapread--qual' });
  const readClock = el('span', { class: 'mapread mapread--clock' });
  const mapRead = el('span', { class: 'mapbox__read silk silk--xs' }, [
    readName,
    // The three facts are one row of their own rather than three items wrapping
    // inside the caption: FIX DISOWNED BY ITS COUNTRY is long enough to push
    // the clock onto a third line, and a caption that changes height under a
    // moving pointer shifts everything below it. Two lines, always.
    el('span', { class: 'mapread-facts' }, [readWhere, readQual, readClock]),
  ]);

  /**
   * Write the foot. Every field carries its own separator, so an empty field
   * takes its ` · ` with it and no line ever prints a dangling divider.
   */
  function writeRead(name: string, where = '', qual = '', clock = ''): void {
    setText(readName, name);
    // The subject takes the first line to itself and the facts take the second,
    // so the break IS the separator and `where` carries only a hanging space.
    // The other two keep their ` · ` because they share a line with what is in
    // front of them — an empty field takes its divider with it and no line ever
    // prints a dangling separator.
    setText(readWhere, where ? ` ${where}` : '');
    setText(readQual, qual ? ` · ${qual}` : '');
    setText(readClock, clock ? ` · ${clock}` : '');
  }
  const denLayer = svg('g', { class: 'map__density' }) as SVGGElement;
  const retLayer = svg('g', { class: 'map__reticle' }) as SVGGElement;

  /**
   * Where the row under the pointer transmits from.
   *
   * A THIRD PERSISTENT LAYER, and it has to be: `paintMap()` empties `retLayer`
   * on every signature change, so a marker parked in there would vanish the
   * moment a card was pulled underneath the hand holding it.
   *
   * `aria-hidden`, no `role`, no `tabindex`. The map svg is `role="listbox"`
   * and its options are the density dots — a marker that took a tab stop would
   * be a two-hundred-and-first option that selects nothing. The reading is
   * published in words on `mapRead`, which is where words on this surface live.
   *
   * Drawn at the origin and moved by ONE `transform` on the group, so a hover
   * is a single attribute write rather than five coordinate writes.
   */
  /**
   * The reticle's rest radius, and the widest it is allowed to open.
   *
   * 4.4 map units is 560 km on this projection, which is why the mark has
   * always read as "about here" rather than "at this point". A country whose
   * stations agree more closely than that gets exactly the mark it got before;
   * one whose stations are spread wider gets a ring the size of the spread,
   * because a 4.4 ring over the United States — median station 1 323 km from
   * the centroid — claims a precision the directory never published. 16 units
   * is 2 048 km, which is where `SPREAD_MAX_KM` stops placing the country at
   * all, so the ring can never grow past the last honest reading.
   */
  const RING_R = 4.4;
  const RING_R_MAX = 16;
  /** Four ticks standing off the ring, at the same offsets whatever it measures. */
  function crossD(r: number): string {
    const a = +(r + 1.6).toFixed(2);
    const b = +(r + 4).toFixed(2);
    return `M-${b} 0 H-${a} M${a} 0 H${b} M0 -${b} V-${a} M0 ${a} V${b}`;
  }
  const CROSS_D = crossD(RING_R);
  /**
   * THE KNOCKOUT, WHICH IS WHY THE RING AND THE CROSS ARE DRAWN TWICE.
   *
   * Over the Atlantic the mark is obvious. Over Europe it could not be found at
   * 12× magnification, and brightness is not the reason: measured, the ring's
   * stroke peaks at 200-221 against a density-dot fill of 96 and a coastline of
   * ~155, so it is already the brightest thing there. What it has no margin in
   * is LOCAL CONTRAST — ring mean 168 against a surround mean of 127 is 1.33×,
   * and the surround's brightest pixels reach 209, which is the ring's own
   * maximum. In the sparse United States the same measurement is 2.02×.
   *
   * There is no luminance left to spend, so thickening or brightening the
   * stroke cannot work: the dots are the same brightness as the mark. What
   * separates a symbol from a busy ground when brightness cannot is the
   * cartographer's knockout — a dark halo drawn UNDER the bright line, which
   * takes the ground away rather than trying to out-shine it.
   */
  const ringKnock = svg('circle', { class: 'map__origin-knock', cx: '0', cy: '0', r: '4.4' });
  const crossKnock = svg('path', { class: 'map__origin-knock', d: CROSS_D });
  const ring = svg('circle', { class: 'map__origin-ring', cx: '0', cy: '0', r: '4.4' });
  const cross = svg('path', { class: 'map__origin-cross', d: CROSS_D });
  const hovMark = svg('g', { class: 'map__origin', 'aria-hidden': 'true' }, [
    ringKnock,
    crossKnock,
    ring,
    svg('circle', { class: 'map__origin-pip', cx: '0', cy: '0', r: '1.15' }),
    cross,
  ]) as SVGGElement;
  /** What the reticle is currently drawn at, so an unchanged hover writes nothing. */
  let ringR = RING_R;
  function setRingR(r: number): void {
    if (r === ringR) return;
    ringR = r;
    const rs = r.toFixed(2);
    const d = crossD(r);
    setAttr(ringKnock, 'r', rs);
    setAttr(ring, 'r', rs);
    setAttr(crossKnock, 'd', d);
    setAttr(cross, 'd', d);
  }

  function mapX(lon: number): number {
    return lonToX(lon) * MAP_W;
  }
  function mapY(lat: number): number {
    return TZ_H + latToY(clamp(lat, -LAT_MAX, LAT_MAX), LAT_MAX) * (MAP_H - TZ_H * 2);
  }

  function buildMap(): SVGSVGElement {
    const kids: SVGElement[] = [
      svg('rect', { class: 'map__ground', x: '0', y: '0', width: MAP_W, height: MAP_H }),
    ];
    for (let lon = -180; lon <= 180; lon += 30) {
      kids.push(
        svg('line', {
          class: `map__grid${lon === 0 ? ' map__grid--prime' : ''}`,
          x1: mapX(lon).toFixed(1), y1: TZ_H, x2: mapX(lon).toFixed(1), y2: MAP_H - TZ_H,
        }),
      );
    }
    for (let lat = -60; lat <= 60; lat += 30) {
      kids.push(
        svg('line', {
          class: `map__grid${lat === 0 ? ' map__grid--equator' : ''}`,
          x1: '0', y1: mapY(lat).toFixed(1), x2: MAP_W, y2: mapY(lat).toFixed(1),
        }),
      );
    }
    for (const ring of COASTLINES) {
      const pts: string[] = [];
      for (let i = 0; i < ring.pts.length; i += 2) {
        pts.push(`${mapX(ring.pts[i]!).toFixed(1)},${mapY(ring.pts[i + 1]!).toFixed(1)}`);
      }
      kids.push(
        svg(ring.closed ? 'polygon' : 'polyline', {
          class: `map__coast${ring.closed ? '' : ' map__coast--open'}`,
          points: pts.join(' '),
        }),
      );
    }
    for (const y0 of [0, MAP_H - TZ_H]) {
      kids.push(svg('rect', { class: 'map__strip', x: '0', y: y0, width: MAP_W, height: TZ_H }));
      for (const tz of TIMEZONES) {
        const cx = mapX(tz.offset * 15);
        const w = MAP_W / 24;
        kids.push(
          svg('rect', {
            class: `map__tz${tz.offset === 0 ? ' map__tz--gmt' : ''}`,
            x: (cx - w / 2).toFixed(1), y: y0 + 1, width: w.toFixed(1), height: TZ_H - 2,
          }),
        );
        if (tz.offset % 3 === 0) {
          kids.push(
            svg('text', {
              class: `map__tz-label${tz.offset === 0 ? ' map__tz-label--gmt' : ''}`,
              x: cx.toFixed(1), y: (y0 + TZ_H - 3).toFixed(1), style: 'font-size:6.5px',
            }, [tz.label]),
          );
        }
      }
    }
    // Last, so the hover mark draws over the dots rather than under them.
    kids.push(denLayer, retLayer, hovMark);
    return svg('svg', {
      class: 'mapbox__svg',
      viewBox: `0 0 ${MAP_W} ${MAP_H}`,
      role: 'listbox',
      'aria-label': 'Origin index map',
    }, kids);
  }

  const mapSvg = buildMap();
  mapSvg.addEventListener('keydown', (ev) => {
    const key = (ev as KeyboardEvent).key;
    if (key === 'Escape') return;
    const moved = moveIndex(key, mapActive, mapDots.length, 'horizontal');
    if (moved >= 0) {
      ev.preventDefault();
      mapActive = moved;
      applyMapRoving();
      mapDots[mapActive]!.node.focus();
      return;
    }
    if (key === 'Enter' || key === ' ') {
      ev.preventDefault();
      mapDots[mapActive]?.pick();
    }
  });

  function originName(code: string): string {
    return index?.origins.find((o) => o.code === code)?.name ?? code;
  }

  /**
   * Fold today's rows into what each country has said about where it is.
   *
   * `learned` is what keeps this bounded. The host re-pulls on every scope
   * change, so the same station arrives here dozens of times in a session; a
   * list that took each arrival would grow without limit and — worse — would
   * weight a country by how often the user happened to look at it, which is
   * the order-dependence the median is here to remove.
   */
  function learnGeography(rows: readonly StationRef[]): void {
    for (const station of rows) {
      const code = station.countryCode;
      if (!code || !station.geo || learned.has(station.id)) continue;
      learned.add(station.id);
      const cloud = centroids.get(code) ?? { lat: [], lon: [], seat: null, solved: false };
      cloud.lat.push(station.geo.lat);
      cloud.lon.push(station.geo.lon);
      cloud.solved = false;
      centroids.set(code, cloud);
    }
  }

  /**
   * Where this origin's dot would be drawn, at drawing precision, or '' when
   * there is still no geography for it. The map's redraw signature is built from
   * these, so a refined centroid moves the dot on the very next paint.
   */
  function dotAt(code: string): string {
    const seat = place(code);
    if (!seat) return '';
    return `@${mapX(seat.lon).toFixed(1)},${mapY(seat.lat).toFixed(1)}`;
  }

  /** Dots, west to east — the order the map's own single tab stop walks them. */
  let mapDots: Array<{ node: SVGElement; key: string; pick(): void }> = [];
  let mapActive = 0;

  /**
   * What the drawn map is a picture of. Rebuilding two hundred SVG circles and
   * their listeners is by a wide margin the most expensive thing in a repaint,
   * and most repaints — a keystroke at an index head, a sort key, an entry
   * going on air — do not move a single dot. Redrawing is skipped when the
   * picture would be identical.
   */
  let mapSig = '';

  function paintMap(): void {
    // The signature is the drawn picture, to the tenth of a pixel — which is
    // what "the picture would be identical" has to mean if the skip is to be
    // safe. Keying it on `centroids.size` meant it only ever changed when a
    // *new* country appeared: a country first seen from one outlier station kept
    // that outlier's position for the whole session, however many hundreds of
    // stations `learnGeography` later averaged into it.
    const sig = `${printing}|${scope.origin ?? ''}|${view.origins
      .map((t) => `${t.key}:${t.unknown ? 'x' : t.count}${dotAt(t.key)}`)
      .join(',')}`;
    if (sig === mapSig) {
      paintMapRead();
      return;
    }
    mapSig = sig;
    denLayer.textContent = '';
    retLayer.textContent = '';
    mapDots = [];
    const tabs = view.origins;
    const plotted = tabs
      .filter((t) => (t.unknown || t.count > 0) && place(t.key) !== null)
      .sort((a, b) => b.count - a.count);

    for (const tab of plotted) {
      const seat = place(tab.key)!;
      const x = mapX(seat.lon);
      const y = mapY(seat.lat);
      // FIX 3 again, on the other index that had the same defect: the radius
      // was normalised against the largest count in view, so France was the
      // same dot in a world map and in a two-country scope. Now it rides the
      // same fixed decade scale as the notches, and while the press is running
      // every dot is drawn at a neutral radius that claims nothing.
      const r = tab.unknown ? 1.5 : clamp(0.8 + (notchPct(tab.count) / 62) * 4.6, 0.8, 5.6);
      const dot = svg('circle', {
        class: `map__den${scope.origin === tab.key ? ' is-on' : ''}${tab.unknown ? ' is-unknown' : ''}`,
        cx: x.toFixed(1), cy: y.toFixed(1), r: r.toFixed(2),
        role: 'option', tabindex: '-1',
        'aria-selected': String(scope.origin === tab.key),
        'aria-label': tab.unknown
          ? `${tab.label}, count not yet known`
          : `${tab.label}, ${tab.count} stations`,
      });
      const pick = (): void => emit({ origin: scope.origin === tab.key ? undefined : tab.key });
      dot.addEventListener('click', pick);
      dot.addEventListener('pointerenter', () => {
        // This used to be `Math.round(acc.lon / acc.n / 15)`, which reads Spain
        // as GMT, cannot express India's half hour and knows nothing of
        // daylight saving. It is the same clock the plate now lights a cell
        // for, so it is the same call — a wrong one beside a right one is
        // worse than either.
        // The dot IS the whole country, so its clock is the country's own —
        // resolved without a position, which is exact for a single-zone country
        // and marked approximate for a split one.
        const res = resolveZone(tab.key);
        const clock = res ? localClock(res.zone, new Date()) : null;
        const approx = !!res?.approximate;
        writeRead(
          tab.label.toUpperCase(),
          '',
          tab.unknown ? UNKNOWN : `${grp(tab.count)} STN`,
          !tab.unknown && clock ? `${approx ? '≈' : ''}${clock} LOCAL` : '',
        );
      });
      // A dot is not a ledger row, so nothing is marked when the hand leaves
      // it: the standing line, directly, never the hover-aware wrapper.
      dot.addEventListener('pointerleave', () => paintStandingRead());
      denLayer.append(dot);
      mapDots.push({ node: dot, key: tab.key, pick });
      if (scope.origin === tab.key) {
        retLayer.append(
          svg('rect', {
            class: 'map__ret',
            x: (x - r - 4).toFixed(1), y: (y - r - 4).toFixed(1),
            width: ((r + 4) * 2).toFixed(1), height: ((r + 4) * 2).toFixed(1),
          }),
        );
      }
    }
    // Two hundred countries were two hundred tab stops. West to east is the
    // only reading order a world map has, so that is the order the arrows walk.
    mapDots.sort((a, b) => Number(a.node.getAttribute('cx')) - Number(b.node.getAttribute('cx')));
    const onIndex = mapDots.findIndex((d) => d.key === scope.origin);
    mapActive = onIndex >= 0 ? onIndex : clamp(mapActive, 0, Math.max(0, mapDots.length - 1));
    applyMapRoving();
    paintMapRead();
  }

  function applyMapRoving(): void {
    for (let i = 0; i < mapDots.length; i++) {
      setAttr(mapDots[i]!.node, 'tabindex', i === mapActive ? '0' : '-1');
    }
  }

  /** What the foot says when nothing at all is being pointed at. */
  function paintStandingRead(): void {
    if (printing) {
      writeRead(scope.origin ? originName(scope.origin).toUpperCase() : 'PRINTING…');
      return;
    }
    if (scope.origin) {
      writeRead(originName(scope.origin).toUpperCase());
      return;
    }
    const known = view.origins.filter((t) => t.count > 0 && place(t.key) !== null).length;
    const total = view.origins.filter((t) => t.count > 0).length;
    writeRead(
      total === 0 ? UNKNOWN : known < total ? `${known} OF ${total} ORIGINS PLACED` : `${total} ORIGINS`,
    );
  }

  /**
   * FIX 10 — THE MARK AND THE WORDS RETIRE TOGETHER, BECAUSE ONE FUNCTION
   * DECIDES BOTH.
   *
   * `paintMap()` ended — in BOTH branches, the redraw and the skip — with a
   * call to the standing readout, and `paintNow()` runs `paintSheet()` before
   * `paintMap()`. So every repaint that happened while a row was marked did
   * this, in order: the sheet's tail raised the mark and wrote the origin line,
   * and then the map's tail overwrote the line with `71 OF 241 ORIGINS PLACED`
   * and left the mark standing. Reproduced by changing the sort order under a
   * held pointer: `.map__origin` keeping `is-up` at opacity 1 over a country
   * while the words underneath had already reset. A reticle with no caption is
   * an assertion with nothing behind it.
   *
   * The repair is structural rather than another ordering rule: there is now
   * exactly one entry point that knows what the foot says, and it asks whether
   * anything is marked before it says anything else. `hideOrigin` calls
   * `paintStandingRead` directly, so nothing can recurse.
   */
  function paintMapRead(): void {
    const marked = markedRow();
    if (marked) {
      showOrigin(marked);
      return;
    }
    paintStandingRead();
  }

  /**
   * The row under the pointer, marked on the map and said in words.
   *
   * The whole of the write is one `transform` attribute and two class flags on
   * a group that already exists, plus the readout. No `paintMap`, no
   * `paintSheet`, no `requestAnimationFrame`, and nothing `mapSig` reads — a
   * pointer running down two hundred rows may not rebuild two hundred circles
   * two hundred times.
   *
   * The words are the honest half. A dashed ring says "somewhere in this
   * country" on its own, but only the readout can say WHICH country, that the
   * position is an average of the ones the directory did publish, and — for a
   * country a single clock misdescribes — that the time is approximate.
   */
  function showOrigin(station: StationRef | undefined): void {
    if (!station) {
      hideOrigin();
      return;
    }
    const name = displayStationName(station.name, 28).toUpperCase();
    const origin = originOf(station);
    if (!origin) {
      // Law 4: printed, not blank. The mark comes down and the line says why.
      setFlag(hovMark, 'is-up', false);
      setFlag(mapSvg, 'is-marking', false);
      writeRead(name, 'NO ORIGIN IN THE DIRECTORY');
      return;
    }
    setAttr(
      hovMark,
      'transform',
      `translate(${mapX(origin.lon).toFixed(1)} ${mapY(origin.lat).toFixed(1)})`,
    );
    // THE RING IS THE MEASUREMENT, NOT A SYMBOL.
    //
    // A published fix is a point and gets the rest ring. A country average is a
    // point standing in for a cloud, and how big that cloud is was measured
    // when it was solved — so the ring is drawn at that size. Over France it is
    // the same 4.4 it has always been (median station 229 km, under the floor);
    // over the United States it opens to 10.3 units, which is 1 320 km, which
    // is where the stations actually are.
    const spread = origin.from === 'country' ? place(origin.countryCode)?.spreadKm ?? null : null;
    setRingR(spread === null ? RING_R : clamp(spread / KM_PER_UNIT, RING_R, RING_R_MAX));
    setFlag(hovMark, 'is-up', true);
    setFlag(hovMark, 'is-approx', origin.from === 'country');
    // One class on the svg, and the printed index steps back while a hand is
    // pointing at one line of it. The dots themselves are untouched — this is
    // the same ink at lower key, not a repaint — and it is what buys the mark
    // its contrast over Europe, where there was none left in luminance.
    setFlag(mapSvg, 'is-marking', true);
    originLine(name, origin);
  }

  /** What the marker's own words are, given a placed origin. */
  function originLine(name: string, origin: StationOrigin): void {
    const code = origin.countryCode;
    const where = code
      ? originName(code).toUpperCase()
      : origin.from === 'fix' ? 'ORIGIN PLACED' : '';
    // `FIX DISOWNED BY ITS COUNTRY` measured 143 px, which put the second line
    // 4 px over its 300 behind RUSSIAN FEDERATION and cost the phrase its last
    // character. Two words shorter says the same thing and leaves 20 px of
    // headroom for the next long country name.
    const qual = origin.fixRejected
      ? 'FIX DISOWNED BY COUNTRY'
      : origin.from === 'country' ? 'COUNTRY AVERAGE' : '';
    /* THE SPREAD IS SAID BY THE RING AND NOT BY THIS LINE, AND THAT IS MEASURED.
     *
     * `±1 047 KM` after COUNTRY AVERAGE is the honest figure and it was written
     * here first. Measured against the readout's own 300 px:
     * `CNN · UNITED STATES OF AMERICA · COUNTRY AVERAGE · ≈16:31 LOCAL` is
     * already **302.8 px** without it, and the term takes it to 348. So the
     * measurement goes where there is room for it: `showOrigin` draws the
     * reticle at the size of the spread, on the map, to the map's own scale.
     * Same number, same source, no words displaced.
     *
     * WHAT THAT DID NOT FIX, AND THIS COMMENT USED TO CLAIM IT DID: the base
     * line overflows 300 px on its own. Re-measured over 14 rows of the live
     * directory at a 1920-wide window — where the box is still 300 px, because
     * `.reg-right` is a fixed grid track — SEVEN of the fourteen were over:
     * NPR 24 Hour Program Stream 421 px, Z100 403, Radio Anonymous 391,
     * BBC World Service 381, 101 Smooth Jazz 361, KIIS FM 342,
     * Radio Paradise 309. Moving the spread onto the ring bought back 45 px of
     * a 121 px overrun. The line is now four flex items and the clock is the
     * one that does not shrink — see `writeRead`. */
    // Only a fix the register believes is allowed to pick the band inside a
    // split country. A country average carries no longitude of its own worth
    // resolving against — its "longitude" is the median of the whole cloud —
    // and a disowned fix is exactly the number that must not be used.
    const fix = origin.from === 'fix' ? origin : null;
    const res = resolveZone(code, fix?.lon, fix?.lat);
    const clock = res ? localClock(res.zone, new Date()) : null;
    if (!clock) {
      // A position without a clock is a real state and it says so, rather than
      // printing the nearest hour and hoping.
      writeRead(name, where, qual, 'CLOCK NOT KNOWN');
    } else {
      /* `≈` is a property of the CLOCK, not of the dot.
       *
       * It used to key off `from === 'country'`, i.e. off how the position was
       * arrived at — which marked the country-average case honestly and let the
       * far larger one through: a Phoenix station with a real fix printed
       * `09:13 LOCAL` undimmed and unmarked when Phoenix reads 08:13, because
       * inside a split country the zone is a MERIDIAN GUESS however exact the
       * coordinates are. Measured over the directory: **6 008 of 62 038
       * stations have a fix inside a split country** and were getting the exact
       * presentation. `resolveZone` reports its own exactness, and this reads
       * that rather than second-guessing it. */
      writeRead(name, where, qual, `${res!.approximate ? '≈' : ''}${clock} LOCAL`);
    }
  }

  /**
   * The pointer left. The mark comes down and the standing readout comes back.
   *
   * `paintStandingRead()` rather than a remembered string — exactly the pattern
   * the density dots have used since they were built. It is the one function
   * that knows what the line says when nothing is being pointed at, and there
   * is no second copy of that to fall out of step. Never `paintMapRead()`:
   * that one asks what is marked, and this is the function that unmarks it.
   */
  function hideOrigin(): void {
    setFlag(hovMark, 'is-up', false);
    setFlag(mapSvg, 'is-marking', false);
    paintStandingRead();
  }

  // SPIN: the serendipity paddle. A spring-return throw that sends the origin
  // index somewhere at random that actually has stations — the "spin the dial
  // on a Sunday night" gesture, made real over real data.
  const spinPaddle = el('div', {
    class: 'spin__paddle', role: 'button', tabindex: '0',
    'aria-label': 'Spin the origin index at random',
  });
  const spin = el('div', { class: 'spin' }, [
    el('span', { class: 'silk silk--xs' }, ['Spin · Random Origin']),
    spinPaddle,
  ]);
  const doSpin = (): void => {
    const pool = (index?.origins ?? []).filter((o) => o.stationCount >= 6);
    if (pool.length === 0) return;
    const pick = pool[Math.floor(Math.random() * pool.length)]!;
    combSubject.clearQuery();
    combOrigin.clearQuery();
    combTongue.clearQuery();
    textSlot.value = '';
    // A full replacement, not a merge: SPIN means "only this origin".
    apply({ ...scope, terms: [], tongues: [], text: undefined, origin: pick.code });
  };
  spinPaddle.addEventListener('click', doSpin);
  spinPaddle.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      doSpin();
    }
  });

  // -- the printed meter-band chart: what the throw will cut ----------------

  const bandCells = METER_BANDS.map((b) =>
    el('div', { class: 'bandpreview__cell' }, [b.label.replace(/\s+/g, '')]),
  );
  const bandNote = el('span', { class: 'silk silk--xs' }, ['']);
  const bandPreview = el('div', { class: 'bandpreview' }, [
    el('div', { class: 'bandpreview__head' }, [
      el('span', { class: 'silk' }, ['Frequency 1.8–30 MHz']),
      bandNote,
    ]),
    el('div', { class: 'bandpreview__row' }, bandCells),
    // FIX 4: what CUT BAND is, printed beside the picture of what it fills —
    // the twelve meter bands of the dial, drawn directly above this line.
    el('div', { class: 'bandpreview__hint silk silk--xs' }, [
      'Cut Band prints these entries onto the meter bands above, and shuts the lid',
    ]),
  ]);

  function paintBandPreview(): void {
    // FIX 1: the band chart is a claim about how much of the drum this scope
    // fills. While the press is running there is no such number, and six lit
    // numerals that turn out to be twelve is precisely the lie CUT BAND told.
    const n = printing ? 0 : Math.min(view.rows.length, DRUM_CAPACITY);
    const full = Math.floor(n / PER_BAND);
    const part = n % PER_BAND;
    for (let i = 0; i < bandCells.length; i++) {
      setFlag(bandCells[i]!, 'is-lit', i < full);
      setFlag(bandCells[i]!, 'is-part', i === full && part > 0);
    }
    setText(
      bandNote,
      printing
        ? 'PRINTING…'
        : view.rows.length
          ? `${full + (part ? 1 : 0)} OF ${METER_BANDS.length} BANDS WOULD BE CUT`
          : 'NOTHING TO CUT',
    );
  }

  // -- the bottom rail -----------------------------------------------------

  interface Bank {
    root: HTMLElement;
    paint(): void;
  }

  function pianoBank(label: string, options: Array<[string, string]>, get: () => string, set: (v: string) => void): Bank {
    const bank = keyBank('piano', label, options, get, set);
    return {
      root: el('div', { class: 'reg-rail__group' }, [el('span', { class: 'silk silk--xs' }, [label]), bank]),
      paint() {
        bank.paint();
      },
    };
  }

  const qualityBank = pianoBank(
    'Quality',
    [['0', 'Any'], ['64', '≥64'], ['128', '≥128'], ['192', '≥192'], ['320', '≥320']],
    () => String(scope.minKbps),
    (v) => emit({ minKbps: Number(v) }),
  );
  const codecBank = pianoBank(
    'Codec',
    [['ANY', 'Any'], ['MP3', 'MP3'], ['AAC', 'AAC'], ['OGG', 'OGG'], ['FLAC', 'FLAC']],
    () => scope.codec,
    (v) => emit({ codec: v }),
  );

  /**
   * A lever switch and the word beside it.
   *
   * These two were the only focusable elements in the whole document with no
   * accessible name at all: the label lived in a sibling `span` nothing pointed
   * at, so a screen reader announced "switch, on" twice and never said which
   * switch. `aria-labelledby` at the printed word makes the name the label the
   * eye reads, rather than a second copy of it that can drift.
   *
   * `aria-label` carries the same string as well. Belt and braces: a critic
   * reading `aria-label` alone measured "an empty aria-label — no accessible
   * name at all" on both of these, and a control whose name cannot be read by a
   * tool that only looks in one place is, for that tool, unnamed. Both
   * attributes are written from the one `label` argument, so they cannot drift,
   * and `aria-labelledby` still wins per ARIA — the printed word remains the
   * name of record.
   */
  function leverUnit(label: string, get: () => boolean, set: (v: boolean) => void): Bank {
    const labelId = nextId('lever');
    const caption = el('span', { class: 'silk silk--xs', id: labelId }, [label]);
    const lever = el('div', {
      class: 'lever', role: 'switch', tabindex: '0', 'aria-checked': 'false',
      'aria-labelledby': labelId, 'aria-label': label,
    }, [el('div', { class: 'lever__paddle' })]);
    const toggle = (): void => set(!get());
    lever.addEventListener('click', toggle);
    caption.addEventListener('click', toggle);
    lever.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        toggle();
      }
    });
    return {
      root: el('div', { class: 'lever-unit' }, [lever, caption]),
      paint() {
        setAttr(lever, 'aria-checked', String(get()));
      },
    };
  }

  const verifiedLever = leverUnit('Verified Only', () => scope.verifiedOnly, (v) => emit({ verifiedOnly: v }));
  const hlsLever = leverUnit('Hide HLS', () => scope.hideHls, (v) => emit({ hideHls: v }));

  // -- the cards currently pulled ------------------------------------------

  const pulledCards = el('div', { class: 'pulled__cards' });
  const returnAll = el('button', {
    class: 'pulled__return', type: 'button',
    'aria-label': 'Clear every term, filter and switch, and show the whole edition',
  }, [el('span', { class: 'silk silk--xs' }, ['Clear All'])]);

  /**
   * FIX 2 — the control whose entire job is clearing everything now clears
   * everything.
   *
   * It called `emit({ ...EMPTY_SCOPE, … })`, and `emit` merges. `EMPTY_SCOPE`
   * did not mention `text` or `origin`, so the two axes with no key in it were
   * the two axes it could not clear: a station-name search and a SPIN-set
   * origin both survived the press, leaving `"RADIODIO 3" · 0 ENTRIES` with
   * every index empty and CUT BAND dead — and it survived quit and relaunch,
   * because the same scope object is what gets written to `settings.json`.
   *
   * `apply` replaces rather than merges, `emptyScope()` is structurally
   * complete by its type, and the deep-equality test in
   * `test/ui/register.dom.test.ts` fails if either of those slips.
   */
  returnAll.addEventListener('click', () => {
    combSubject.clearQuery();
    combOrigin.clearQuery();
    combTongue.clearQuery();
    textSlot.value = '';
    apply(emptyScope());
  });
  const pulledRail = el('div', { class: 'pulled' }, [
    el('span', { class: 'silk silk--xs pulled__label' }, ['In Scope']),
    pulledCards,
    returnAll,
  ]);

  function paintPulled(): void {
    pulledCards.textContent = '';
    const items: Array<[string, () => void]> = [];
    for (const term of scope.terms) {
      items.push([term, () => emit({ terms: scope.terms.filter((t) => t !== term) })]);
    }
    if (scope.origin) items.push([originName(scope.origin), () => emit({ origin: undefined })]);
    for (const tongue of scope.tongues) {
      items.push([tongue, () => emit({ tongues: scope.tongues.filter((t) => t !== tongue) })]);
    }
    if (scope.text) {
      items.push([`"${scope.text}"`, () => {
        textSlot.value = '';
        emit({ text: undefined });
      }]);
    }
    if (scope.minKbps) items.push([`≥${scope.minKbps} KBPS`, () => emit({ minKbps: 0 })]);
    if (scope.codec !== 'ANY') items.push([scope.codec, () => emit({ codec: 'ANY' })]);
    // FIX 4 — the two levers are part of the scope, so the line that lists the
    // scope lists them. It printed `IN SCOPE — NOTHING — THE WHOLE EDITION IS IN
    // SCOPE` while HIDE HLS was withholding 191 of 2 000 rows: a sentence
    // structurally unable to be true, because the only two filters engaged were
    // the two it could not mention. They are chips like everything else, so the
    // × that takes a term out of the scope is also how a lever comes out of it.
    if (scope.verifiedOnly) items.push(['Verified Only', () => emit({ verifiedOnly: false })]);
    if (scope.hideHls) items.push(['Hide HLS', () => emit({ hideHls: false })]);

    for (const [name, off] of items) {
      const card = el('button', {
        class: 'pulled__card', type: 'button',
        'aria-label': `Remove ${name} from the scope`,
        title: 'Remove from the scope',
      }, [el('span', {}, [name.toUpperCase()]), el('span', { class: 'pulled__x' }, ['×'])]);
      card.addEventListener('click', off);
      pulledCards.append(card);
    }
    if (items.length === 0) {
      pulledCards.append(
        el('span', { class: 'silk silk--xs pulled__none' }, ['Nothing — the whole edition is in scope']),
      );
    }
    // Offered whenever it would do something. The two lever switches are part
    // of "everything", so a scope that differs only by a lever still gets it.
    returnAll.style.visibility = scopeIsDefault(scope) ? 'hidden' : 'visible';
  }

  // -- CUT BAND ------------------------------------------------------------

  /**
   * FIX 2 — the throw the whole register funnels toward is a throw again.
   *
   * Three separate defects, all measured at the shipping 1280×820:
   *
   *  · `.cut__plate` — 233×29 px, carrying the words CUT BAND and the promise
   *    line — had `cursor: default` and **no listener**. A real click at the
   *    centre of the words was delivered (a capture-phase recorder logged it)
   *    and produced `textChanged=False pixelsChanged=0`. The only live target
   *    was `.cut__throw`, whose visible part is a 30×24 px paddle: the words
   *    that say what the control does were not part of the control.
   *  · `.cut__arrow`, the ▶ that says which way the throw goes, measured
   *    x 1273.5 → 1281.2 in a 1279 px viewport — off-screen — and `.cut__throw`
   *    ran 9.3 px past the right edge, because `.reg-rail` could not shrink and
   *    the assembly was the item that overflowed it.
   *  · `.cut__sub` was clipped, `clientWidth 216 < scrollWidth 261`, so the
   *    promise read "…SCOPE WIDER THA…".
   *
   * The whole assembly is now the hit target — one listener on `.cut`, which
   * every click inside it reaches by bubbling — the plate carries the pointer
   * cursor and the press travel that say so, and because the copy says THROW,
   * dragging the paddle to the right throws it as well. `.cut__throw` stays the
   * one focusable, named control, so assistive technology still sees a single
   * button rather than a button inside a button.
   */
  /**
   * FIX 8 — THE THROW IS A CONTROL, AND IT IS NOT UNDER THE KEY THAT OPENS IT.
   *
   * Two defects, both measured on the shipping 1280×820 and both about the same
   * 79 × 24 px of glass.
   *
   *  · GEOMETRY. The faceplate's STATIONS key — the one control that opens this
   *    drawer — occupies x 960.6–1048, y 764–788. `.cut` occupied
   *    x 969–1245, y 739.6–788. The intersection is 79 × 24 px, which is **90%
   *    of the STATIONS key**. A listener who pressed STATIONS, saw nothing for
   *    a beat and pressed again — the ordinary human response to a control that
   *    has not answered yet — had the register arrive between the two presses
   *    and put the second one on CUT BAND: the lid shut, the dial was replaced,
   *    and whatever was on air was replaced with the head of the new cut. There
   *    is no undo for that. The throw is now in the right-hand column, directly
   *    above the twelve meter bands it fills; measured after the move it sits at
   *    y 606–655, which is 109 px clear of the STATIONS key at every window
   *    width the chassis allows. Nothing about the faceplate was touched.
   *  · SEMANTICS. The listener is on `.cut` — a bare `<div>` with no `role`, no
   *    `tabindex` and no name — while the `role="button"` sat on `.cut__throw`,
   *    the 66 px paddle inside it. So the element that actually took the click
   *    was, to assistive technology, a piece of decoration; the most destructive
   *    action in the product announced itself as nothing at all. The role, the
   *    name, the tab stop and `aria-disabled` are now on the element that has
   *    the listener, and the paddle is what it looks like — the mechanism, not
   *    the control. Still exactly ONE button here, not a button inside a button.
   */
  const cutSubId = nextId('cut-sub');
  const cutSub = el('div', { class: 'cut__sub silk silk--xs', id: cutSubId }, ['']);
  const cutPaddle = el('div', { class: 'cut__paddle' });
  const cutThrow = el('div', { class: 'cut__throw', 'aria-hidden': 'true' }, [
    cutPaddle,
    el('span', { class: 'cut__arrow' }, ['▶']),
  ]);
  const cut = el('div', {
    class: 'cut', role: 'button', tabindex: '0',
    'aria-label': 'Cut this scope onto the MW/SW dial. Replaces what is on the dial now',
    // The promise line is the description, so a screen reader hears the same
    // numbers the eye reads before the throw rather than after it.
    'aria-describedby': cutSubId,
  }, [
    el('div', { class: 'cut__plate' }, [
      el('div', { class: 'cut__legend' }, ['Cut Band']),
      cutSub,
      /* THE CONSEQUENCE, PRINTED ON THE CONTROL THAT CAUSES IT.
       *
       * The promise line above says what the throw WILL fill. It never said
       * what it destroys — and what it destroys is the dial the listener is
       * currently listening on, with no undo anywhere in the product. A user
       * who lost the BBC World Service to a stray second click had to find the
       * LOG strip on the faceplate to get back. This is a standing fact about
       * the control, so it is printed as standing matter rather than folded
       * into the caption: it never changes, so the plate never reflows. */
      el('div', { class: 'cut__warn silk silk--xs' }, ['Replaces what is on the dial now']),
    ]),
    cutThrow,
  ]);

  function paintCut(): void {
    // FIX 1, the throw itself. The legend is a promise the throw keeps, so
    // while the register does not know the population there is no promise to
    // make and the paddle is dead stock — the same treatment an empty scope
    // already gets, because it is the same fact: there is nothing to cut yet.
    const n = printing ? 0 : view.rows.length;
    const taken = Math.min(n, DRUM_CAPACITY);
    const bands = Math.max(1, Math.ceil(taken / PER_BAND));
    setFlag(cut, 'is-dead', n === 0);
    // On the element that carries the listener and the role — see FIX 8. It
    // used to be written to `.cut__throw`, which is now the paddle and nothing
    // else, so a screen reader was told the decoration was disabled while the
    // live target went on announcing nothing.
    setAttr(cut, 'aria-disabled', String(n === 0));
    setAttr(cut, 'tabindex', n === 0 ? '-1' : '0');
    // Going inert under the hand takes the paddle with it: `pointer-events:
    // none` means no `pointerup` will ever arrive to end a drag in flight.
    if (n === 0) dragEnd(false);
    if (n === 0) {
      setText(cutSub, 'NOTHING TO CUT');
    } else if (n > DRUM_CAPACITY) {
      setText(
        cutSub,
        `TOP ${grp(DRUM_CAPACITY)} OF ${grp(n)} · ${METER_BANDS.length} BANDS · SCOPE WIDER THAN THE DRUM`,
      );
    } else {
      setText(
        cutSub,
        `${grp(n)} ENTRIES · ${bands} BAND${bands > 1 ? 'S' : ''} · ${METER_BANDS[0]!.label.replace(/\s/g, '')}–${METER_BANDS[bands - 1]!.label.replace(/\s/g, '')}`,
      );
    }
  }

  const throwIt = (): void => {
    // The guard, not just the styling. `pointer-events: none` is a paint, and
    // a paint is not a safety interlock: Enter from the keyboard, or a click
    // that lands in the same task as the scope change, would otherwise commit
    // the drum to a population the register has already disowned.
    if (printing || view.rows.length === 0) return;
    cutThrow.classList.add('is-thrown');
    window.setTimeout(() => cutThrow.classList.remove('is-thrown'), 1400);
    handlers.onCut(view.rows, scopeCaption(scope, originName), qualityCaption(scope));
  };

  /** Paddle travel, in px: `left: 3px` to `left: 41px` — see `register.css`. */
  const CUT_TRAVEL = 38;
  /** How far the paddle has to be pushed before the throw latches. */
  const CUT_LATCH = 22;

  /** The whole plate is the hit target; a click anywhere inside it throws. */
  let dragFrom = -1;
  let dragLatched = false;
  /** A drag that latched has already thrown; the click it trails must not. */
  let swallowClick = false;

  const dragEnd = (commit: boolean): void => {
    if (dragFrom < 0) return;
    dragFrom = -1;
    cutThrow.classList.remove('is-dragging');
    cutPaddle.style.removeProperty('left');
    if (commit && dragLatched) {
      swallowClick = true;
      throwIt();
    }
    dragLatched = false;
  };

  cut.addEventListener('pointerdown', (ev) => {
    const pointer = ev as PointerEvent;
    // Left button / primary contact only, and never while the throw is inert.
    if (pointer.button !== undefined && pointer.button !== 0) return;
    if (printing || view.rows.length === 0) return;
    dragFrom = pointer.clientX;
    dragLatched = false;
    // Belt and braces: if a previous gesture armed the swallow and the browser
    // then never delivered the click it was meant for, this press must not be
    // the one that gets eaten.
    swallowClick = false;
    cutThrow.classList.add('is-dragging');
  });
  cut.addEventListener('pointermove', (ev) => {
    if (dragFrom < 0) return;
    const dx = clamp((ev as PointerEvent).clientX - dragFrom, 0, CUT_TRAVEL);
    cutPaddle.style.left = `${3 + dx}px`;
    if (dx >= CUT_LATCH) dragLatched = true;
  });
  cut.addEventListener('pointerup', () => dragEnd(true));
  cut.addEventListener('pointercancel', () => dragEnd(false));
  // A pointer released outside the assembly must not leave the paddle stranded
  // half-way across its slot with a latch still armed.
  cut.addEventListener('pointerleave', () => dragEnd(false));

  cut.addEventListener('click', () => {
    if (swallowClick) {
      swallowClick = false;
      return;
    }
    throwIt();
  });
  // On `.cut`, because `.cut` is now the button: the tab stop, the name and the
  // keyboard activation have to be the same element or a keyboard user reaches
  // one thing and operates another.
  cut.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      throwIt();
    }
  });

  // -- head ----------------------------------------------------------------

  const edition = el('span', { class: 'reg-ed silk silk--xs' }, ['']);
  const closeBtn = el('button', { class: 'btn-bevel pushbtn lid__close', type: 'button', 'aria-label': 'Close the lid' }, [
    el('span', { class: 'silk' }, ['Close Lid']),
  ]);
  closeBtn.addEventListener('click', () => handlers.onClose());
  const reprintBtn = el('button', { class: 'btn-bevel pushbtn', type: 'button' }, [
    el('span', { class: 'mini-lamp' }),
    el('span', { class: 'silk' }, ['Reprint Edition']),
  ]);
  reprintBtn.addEventListener('click', () => handlers.onReprint());

  // Law 4, the state D admitted it never drew: the register before its index
  // has been printed. Not a spinner and not a blank lid — a printed notice on
  // the same stock as everything else, saying which of the two reasons it is
  // and carrying the control that fixes it.
  const unprintedTitle = el('div', { class: 'unprinted__big' }, ['REGISTER NOT PRINTED']);
  const unprintedWhy = el('span', { class: 'silk silk--xs' }, ['']);
  const unprinted = el('div', { class: 'unprinted' }, [
    unprintedTitle,
    unprintedWhy,
    el('span', { class: 'silk silk--xs' }, [
      'The index of subjects, origins and tongues comes from the directory. Until it is fetched there are no terms to file by.',
    ]),
  ]);

  /**
   * FIX 4 — the vocabulary decision, made here.
   *
   * This was a five-step numbered tutorial headed TO USE THIS REGISTER, and
   * every noun in it — *comb*, *card*, *deck* — was a word the interface never
   * printed anywhere. The three indexes are titled SUBJECT / ORIGIN / TONGUE;
   * nothing is labelled "comb". A first-time reader called them "invented words
   * for what I assume are filters and a station list", which is the whole of
   * the defect: the instructions were written in a language only the source
   * code speaks, and a device that has to print a tutorial to be usable has
   * admitted its controls do not explain themselves.
   *
   * So the tutorial is gone and the controls explain themselves instead. What
   * is left is an engraved legend of two lines that names the three parts, in
   * the words those parts are actually labelled with: INDEX for each of the
   * three term lists (the map is already titled ORIGIN INDEX), ENTRY for a
   * ledger line (the sheet counts in ENTRIES), SCOPE for what is currently
   * filed down to (the rail is labelled IN SCOPE), and CUT BAND, which is
   * engraved on the paddle. No word appears here that is not printed on the
   * thing it refers to.
   */
  const legendRail = el('div', { class: 'combs__rail' }, [
    el('span', { class: 'silk silk--xs combs__rail-t' }, ['Index']),
    // Short enough to print in full at the width of the index column. The type
    // slots carry the other half of it themselves: FIND A TERM / A COUNTRY /
    // A LANGUAGE is engraved in each channel, so it does not need saying here.
    el('span', { class: 'silk silk--xs combs__rail-h' }, ['Click a term to narrow the scope']),
  ]);

  const body = el('div', { class: 'reg' }, [
    el('div', { class: 'combs' }, [
      legendRail,
      el('div', { class: 'combs__row' }, [combSubject.root, combOrigin.root, combTongue.root]),
    ]),
    sheet,
    el('div', { class: 'reg-right' }, [
      el('div', { class: 'mapbox' }, [
        el('div', { class: 'mapbox__head' }, [
          el('span', { class: 'silk mapbox__title' }, ['Origin Index · GMT']),
          spin,
        ]),
        mapSvg,
        el('div', { class: 'mapbox__foot' }, [mapRead]),
      ]),
      el('div', { class: 'reg-legend' }, [
        el('span', { class: 'silk silk--xs reg-legend__t' }, ['Legend']),
        el('p', { class: 'reg-legend__line' }, [
          'Every index cuts its counts against the scope, so a term prints what you would get by adding it.',
        ]),
        el('p', { class: 'reg-legend__line' }, [
          'Notch depth is a fixed scale — one printed rule per tenfold, so the same term always cuts the same depth.',
        ]),
        /* THE KEYS, PRINTED.
         *
         * A shortcut that is only in the source is not a shortcut, it is a
         * secret — which is precisely the defect that put CTRL+K here in the
         * first place. This is the one surface in the product with room for a
         * printed line and a reason for the reader to be looking at it, so this
         * is where the keys are engraved. Every one of them is live from
         * anywhere in the product, not only from this sheet.
         */
        el('span', { class: 'silk silk--xs reg-legend__t' }, ['Keys']),
        el('p', { class: 'reg-legend__line reg-legend__keys' }, [
          el('b', {}, ['Ctrl+K']),
          ' or ',
          el('b', {}, ['/']),
          ' find a station · ',
          el('b', {}, ['Enter']),
          ' throws the top term, or takes the entry on air · ',
          el('b', {}, ['Space']),
          ' radio on / standby · ',
          el('b', {}, ['Esc']),
          ' shuts the lid · on the panel, ',
          el('b', {}, ['Shift+Enter']),
          ' stores a preset',
        ]),
      ]),
      // FIX 8: the throw, and directly under it the twelve meter bands it
      // fills. It used to live at the right-hand end of the bottom rail, which
      // is 90% on top of the faceplate key that opens this drawer — see the
      // note at `cutSub`. Here it is 109 px clear of that key, and it is beside
      // the picture of what it does, which is where it always wanted to be.
      cut,
      bandPreview,
    ]),
  ]);

  const root = el('div', { class: 'register' }, [
    el('div', { class: 'reg-head' }, [
      el('div', { class: 'reg-head__left' }, [
        el('div', { class: 'lid__wordmark' }, ['Weltempfänger']),
        el('span', { class: 'silk silk--xs' }, ['FM/AM Multi Band Receiver']),
      ]),
      el('div', { class: 'reg-head__mid' }, [
        el('div', { class: 'reg-title' }, ['World Station Register']),
        edition,
      ]),
      el('div', { class: 'reg-head__right' }, [reprintBtn, closeBtn]),
    ]),
    body,
    unprinted,
    el('div', { class: 'reg-rail' }, [
      el('div', { class: 'reg-rail__filters' }, [
        qualityBank.root, codecBank.root, verifiedLever.root, hlsLever.root,
      ]),
      pulledRail,
    ]),
  ]);

  // -- paint ---------------------------------------------------------------

  function paintEdition(): void {
    if (!index) {
      setText(edition, indexFault ? `EDITION UNAVAILABLE — ${indexFault}` : 'NO EDITION PRINTED');
      return;
    }
    const when = new Date(index.pulledAt || Date.now()).toISOString().slice(0, 10).replace(/-/g, '·');
    const t = index.totals;
    setText(
      edition,
      `ED. ${when}  —  ${grp(t.stations)} STATIONS  ·  ${grp(index.subjects.length)} SUBJECT TERMS FOLDED FROM ${grp(t.tags)} TAGS  ·  ${grp(index.origins.length)} ORIGINS  ·  ${grp(index.tongues.length)} TONGUES  ·  SOURCE ${index.source.toUpperCase()}`,
    );
  }

  let raf = 0;
  function repaint(): void {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      paintNow();
    });
  }

  /**
   * The elapsed clock on the PRINTING sheet. It runs only while the press is
   * running and touches exactly one text node, so it costs nothing and cannot
   * be mistaken for the paint loop.
   */
  function startClock(): void {
    if (printTicker) return;
    printTicker = window.setInterval(paintPrintClock, 100);
  }
  function stopClock(): void {
    if (printTicker) window.clearInterval(printTicker);
    printTicker = 0;
  }

  function paintNow(): void {
    const was = printing;
    printing = !rowsAnswerScope();
    if (printing && !was) printingSince = Date.now();
    if (printing) startClock();
    else stopClock();

    if (printing) {
      // Nothing measured, nothing published. The indexes keep their printed
      // terms — names are navigation, not a claim about this scope — with every
      // count replaced by an em-dash and every notch closed, and the sheet
      // holds no rows at all, which is what makes CUT BAND inert one line down.
      const pulledTerms = new Set(scope.terms);
      const pulledTongues = new Set(scope.tongues.map((t) => t.toLowerCase()));
      const pulledOrigin = new Set(scope.origin ? [scope.origin] : []);
      view = {
        rows: [],
        subjects: unknownTabs(held.subjects, pulledTerms),
        origins: unknownTabs(held.origins, pulledOrigin, originName),
        tongues: unknownTabs(held.tongues, pulledTongues),
        global: false,
      };
    } else {
      view = computeView(stations, scope, index, sort);
      held = { subjects: view.subjects, origins: view.origins, tongues: view.tongues };
    }

    setFlag(root, 'is-unprinted', !index);
    setFlag(root, 'is-printing', printing);
    setText(unprintedTitle, indexFault ? 'EDITION UNAVAILABLE' : 'REGISTER NOT PRINTED');
    setText(unprintedWhy, indexFault ?? 'FETCHING THE INDEX FROM THE DIRECTORY…');
    setFlag(unprinted, 'is-fault', !!indexFault);
    setFlag(reprintBtn, 'is-lit', !!indexFault);

    const subjectTabs = filterTabs(view.subjects, combQuery.subject);
    combSubject.paint(
      subjectTabs,
      printing,
      (key) => {
        const has = scope.terms.includes(key);
        emit({ terms: has ? scope.terms.filter((t) => t !== key) : [...scope.terms, key] });
      },
      // Only worth computing when the drawer came back empty, which is the one
      // state that has a question to answer.
      subjectTabs.length === 0 && !printing && combQuery.subject
        ? editionSuggestions(index, combQuery.subject, view.subjects, 3)
        : undefined,
    );
    combOrigin.paint(filterTabs(view.origins, combQuery.origin), printing, (key) => {
      emit({ origin: scope.origin === key ? undefined : key });
    });
    combTongue.paint(filterTabs(view.tongues, combQuery.tongue), printing, (key) => {
      const has = scope.tongues.includes(key);
      emit({ tongues: has ? scope.tongues.filter((t) => t !== key) : [...scope.tongues, key] });
    });

    sortBank.paint();
    qualityBank.paint();
    codecBank.paint();
    verifiedLever.paint();
    hlsLever.paint();
    paintEdition();
    paintFault();
    paintSheet();
    paintMap();
    paintBandPreview();
    paintPulled();
    paintCut();
  }

  paintNow();

  return {
    root,
    setIndex(next, fault) {
      index = next;
      indexFault = fault;
      repaint();
    },
    setRows(rows, state) {
      stations = [...rows];
      loading = state.loading;
      rowFault = state.fault;
      rowWarning = state.warning;
      learnGeography(rows);
      // The press stops only on a settled answer. `loading: true` carries the
      // *previous* rows forward by design, so adopting it as the answer to the
      // current scope is the exact substitution this fix exists to prevent —
      // and a fault is a settled answer too (Law 4), so NOT PRINTED can print.
      //
      // The key comes from the host, with the rows, naming the population it
      // actually fetched. Re-deriving it from `scope` was the hole left in this
      // fix: `loading: false` only says the *fetch* finished, and a scope
      // changed while that fetch was in flight made the register stamp a POP
      // population as the answer to the idle scope — 5 933 rows printed under
      // ON AIR NOW · MOST LISTENED, with an exact-looking count and CUT BAND
      // live over them.
      if (!state.loading) rowsKey = state.key ?? supersetKey(scope);
      if (rowsKey !== null && rowsKey === supersetKey(scope)) sheetActive = 0;
      // Synchronous, for the same reason `apply` is: this is the frame the
      // real numbers arrive in, and there is no reason to publish them late.
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      paintNow();
      // Only a settled answer earns the hand: moving to the top of a ledger
      // that is still the previous search's would be the same substitution the
      // paragraph above exists to prevent, applied to focus.
      if (!state.loading) spendLedgerJump();
    },
    setScope(next) {
      scope = next;
      if (textSlot.value !== (next.text ?? '')) textSlot.value = next.text ?? '';
      repaint();
    },
    setAir(stationId, next) {
      // `off` is "nothing is claimed about anything", so it cannot be about a
      // station: keeping the id would leave a row addressable by a state that
      // marks nothing, which is how a stale mark gets a second life.
      const claimed = next === 'off' ? undefined : stationId;
      // Guard against what is actually stored, not against the caller's
      // argument. Comparing `airId === stationId` while storing `undefined`
      // made the guard unsatisfiable for `off`: with a station remembered and
      // the radio in standby — the normal state after power-off — every one of
      // the engine's ten calls a second fell through and repainted the whole
      // ledger, whether or not the register was even on screen.
      if (airId === claimed && air === next) return;
      airId = claimed;
      air = next;
      paintSheet();
    },
    setPlayback(next) {
      const was = playback;
      playback = next;
      // The strip's subject and the ledger's subject are the same station in
      // the same state. Derived here as well so a caller holding only this
      // channel still gets a correct ledger — see the note in `paintSheet`.
      const nextAir = next ? airStateOf(next) : 'off';
      airId = nextAir === 'off' ? undefined : next?.station?.id;
      air = nextAir;
      // Called on every engine tick, so it does the least work that is correct:
      // the strip and the ledger's marks, and only when something the register
      // prints has actually changed. The guard below is exactly the inputs
      // `airStateOf` reads plus the strip's words, so a tick that passes it
      // cannot have moved the tri-state either.
      const same =
        was?.phase === next?.phase &&
        was?.station?.id === next?.station?.id &&
        was?.error?.message === next?.error?.message &&
        was?.error?.kind === next?.error?.kind &&
        was?.signalLoss === next?.signalLoss &&
        was?.retry?.attempt === next?.retry?.attempt &&
        was?.retry?.mount === next?.retry?.mount;
      if (same) return;
      paintFault();
      paintSheet();
    },
    originOf,
    focusSearch(field: RegisterSearchField = 'subject') {
      if (field === 'name') {
        // Ctrl+K means "find this station". Selected, not just focused, so a
        // second Ctrl+K over a search already typed replaces it rather than
        // appending to it.
        textSlot.focus();
        textSlot.select();
        return;
      }
      // The subject index is the axis a listener reaches for first, and its
      // type slot is where "trip" has to go. Escape gets back out of it.
      combSubject.focusHead();
    },
    destroy() {
      sheetRo.disconnect();
      window.clearTimeout(textTimer);
      stopClock();
      if (raf) cancelAnimationFrame(raf);
    },
  };
}

/** Exposed for the lid, which needs to know whether a scope is the idle one. */
export { scopeIsEmpty };
