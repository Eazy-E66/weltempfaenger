/**
 * Radio Browser (https://api.radio-browser.info) directory provider.
 *
 * Chosen deliberately over the SHOUTcast directory API, which is proprietary,
 * key-gated and not ours to depend on. Radio Browser is community-run, open
 * data, and needs no credentials — but it does have operational rules we must
 * respect:
 *
 *   1. There is no stable single hostname to hit. Clients are expected to
 *      discover the current mirror set and pick one, spreading load. We
 *      randomise the pick and cache it for the session, then fall down the
 *      list on failure.
 *   2. Every request must carry a descriptive User-Agent. Their docs are
 *      explicit that anonymous clients may be blocked.
 *
 * Nothing here is allowed to take the app down: exhausting every mirror throws
 * a typed `DirectoryError` that the UI can render as "directory unreachable",
 * and `reportListening` swallows everything.
 */

import type {
  DirectoryProvider,
  GenreTag,
  RegisterIndex,
  RegisterPlace,
  RegisterTongue,
  StationQuery,
  StationRef,
} from '../../shared/contracts';
import { DirectoryError, getJson, type FetchLike } from './http';
import { foldForMatch, groupKey, groupTags, type RawTag } from './tags';

/** Where the mirror list itself lives. This host is DNS round-robin over all mirrors. */
export const MIRROR_DISCOVERY_URL = 'https://all.api.radio-browser.info/json/servers';

/**
 * Used only when discovery itself fails. Hardcoding these is a last resort, not
 * the normal path — mirrors come and go and this list will rot.
 */
export const FALLBACK_MIRRORS = [
  'https://de1.api.radio-browser.info',
  'https://de2.api.radio-browser.info',
  'https://at1.api.radio-browser.info',
  'https://nl1.api.radio-browser.info',
];

export const DEFAULT_USER_AGENT = 'Weltempfaenger/0.1';

/** Big enough to cover the whole tag list with room to grow; see `listGenres`. */
const TAG_PAGE = 100000;

/**
 * Law 4: a folded group whose expansion only partly succeeded.
 *
 * `trip-hop` is three tag queries. If one of them fails the caller has 32
 * stations out of 46 and no way to know it — which reads as "the directory has
 * 32", a quiet lie. This says so instead, and the panel prints it.
 */
export interface PartialExpansion {
  /** The genre as asked for. */
  genre: string;
  /** Spellings in the folded group. */
  spellings: number;
  /** Spellings that actually answered. */
  fetched: number;
  /** Why the rest did not. */
  message: string;
}

export interface DirectorySearchOptions {
  signal?: AbortSignal;
  /**
   * Called when some — but not all — of a folded group's queries failed. Never
   * called on the happy path, and never called when everything failed: that is
   * a thrown `DirectoryError`, not a partial result.
   */
  onPartial?(note: PartialExpansion): void;
}

export interface RadioBrowserOptions {
  /** Skip discovery and use exactly these base URLs, in order. For tests and pinning. */
  mirrors?: string[];
  /** Per-request timeout, ms. Default 8000. */
  timeoutMs?: number;
  userAgent?: string;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: FetchLike;
  /** Injectable for tests so mirror choice can be made deterministic. */
  random?: () => number;
  /** How long a discovered mirror list stays valid, ms. Default 30 minutes. */
  mirrorTtlMs?: number;
}

// ---------------------------------------------------------------------------
// Wire types (only the fields we actually consume)
// ---------------------------------------------------------------------------

interface RbServer {
  name?: string;
  ip?: string;
}

interface RbTag {
  name?: string;
  stationcount?: number;
}

/** `/json/countries` and `/json/states` share the shape we care about. */
interface RbPlace {
  name?: string;
  stationcount?: number;
  iso_3166_1?: string;
}

interface RbLanguage {
  name?: string;
  stationcount?: number;
}

/** `/json/stats` — what the directory says about its own size. */
interface RbStats {
  stations?: number;
  tags?: number;
  countries?: number;
  languages?: number;
}

export interface RbStation {
  stationuuid?: string;
  lastcheckok?: number | boolean;
  lastcheckoktime_iso8601?: string | null;
  name?: string;
  url?: string;
  url_resolved?: string;
  homepage?: string;
  favicon?: string;
  tags?: string;
  country?: string;
  countrycode?: string;
  language?: string;
  codec?: string;
  bitrate?: number;
  votes?: number;
  clickcount?: number;
  geo_lat?: number | null;
  geo_long?: number | null;
}

// ---------------------------------------------------------------------------
// Pure mapping helpers (exported: the mapping is worth testing on its own)
// ---------------------------------------------------------------------------

function cleanString(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

/**
 * Numeric fields, without JavaScript's helpful coercions.
 *
 * `Number(null)` is 0, which for a coordinate means a station with a latitude
 * but no longitude silently lands in the Gulf of Guinea. Absent must stay
 * absent.
 */
function toNumber(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  if (typeof v !== 'number' && typeof v !== 'string') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function splitTags(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const tag = part.trim().toLowerCase();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

/**
 * Raw popularity score before normalisation.
 *
 * Log-scaled because the distribution is brutally long-tailed: one station with
 * 300k votes would otherwise squash every other station to a popularity of
 * ~0, and since popularity drives dial-slot width that would produce a band
 * with one wide station and a hundred invisible slivers.
 */
export function popularityScore(station: RbStation): number {
  const votes = Math.max(0, Number(station.votes) || 0);
  const clicks = Math.max(0, Number(station.clickcount) || 0);
  return 0.5 * Math.log1p(votes) + 0.5 * Math.log1p(clicks);
}

/**
 * Min-max normalise scores across the result set to 0..1. When every station
 * scores identically (including a single-station result) there is no ranking
 * to express, so everything gets a neutral 0.5 rather than a fake 1.
 */
export function normalisePopularity(scores: number[]): number[] {
  if (scores.length === 0) return [];
  let min = Infinity;
  let max = -Infinity;
  for (const s of scores) {
    if (s < min) min = s;
    if (s > max) max = s;
  }
  const span = max - min;
  if (!Number.isFinite(span) || span <= 1e-9) return scores.map(() => 0.5);
  return scores.map((s) => (s - min) / span);
}

/** Map one wire station onto a `StationRef`, with popularity left at 0. */
export function mapStation(raw: RbStation): StationRef | null {
  const id = cleanString(raw.stationuuid);
  const name = cleanString(raw.name);
  // `url_resolved` is Radio Browser's own post-redirect answer and is usually
  // directly playable; `url` is what the submitter typed. Prefer the former,
  // keep the latter as the fallback candidate.
  const url = cleanString(raw.url_resolved) ?? cleanString(raw.url);
  if (!id || !name || !url) return null;

  const station: StationRef = {
    id,
    name,
    url,
    tags: splitTags(raw.tags),
    popularity: 0,
  };

  const homepage = cleanString(raw.homepage);
  if (homepage) station.homepage = homepage;
  const favicon = cleanString(raw.favicon);
  if (favicon) station.faviconUrl = favicon;
  const countryCode = cleanString(raw.countrycode);
  if (countryCode) station.countryCode = countryCode.toUpperCase();
  const country = cleanString(raw.country);
  if (country) station.country = country;
  // The whole list, not just the head of it. The directory's `language=` query
  // matches any member, so a station returned by a German fetch may perfectly
  // well read `english,german` — and dropping everything after the comma is what
  // made the register filter that station straight back out again.
  // `splitTags` is exactly the right shape here: the same comma-separated
  // free-text list, lowercased and de-duplicated, which is how the directory's
  // own `/json/languages` index spells its terms.
  const languages = splitTags(raw.language);
  if (languages.length > 0) {
    station.language = languages[0];
    station.languages = languages;
  }

  const bitrate = toNumber(raw.bitrate);
  if (bitrate !== undefined && bitrate > 0) station.claimedBitrate = bitrate;
  const codec = cleanString(raw.codec);
  if (codec && codec.toUpperCase() !== 'UNKNOWN') station.claimedCodec = codec;

  // The register's columns. Every one of these is the directory's own
  // bookkeeping about itself — printed as such, never as a measurement.
  const clicks = toNumber(raw.clickcount);
  if (clicks !== undefined && clicks >= 0) station.clickCount = Math.floor(clicks);
  const votes = toNumber(raw.votes);
  if (votes !== undefined && votes >= 0) station.votes = Math.floor(votes);
  station.lastCheckOk = raw.lastcheckok === 1 || raw.lastcheckok === true;
  const checked = checkAgeDays(raw.lastcheckoktime_iso8601);
  if (checked !== undefined) station.lastCheckAgeDays = checked;
  if (looksLikeHls(url)) station.hls = true;

  const lat = toNumber(raw.geo_lat);
  const lon = toNumber(raw.geo_long);
  // Both or neither. (0,0) is Null Island — Radio Browser uses it as a
  // "not set" sentinel far more often than it has stations in the Gulf of
  // Guinea, so it is dropped too.
  if (
    lat !== undefined &&
    lon !== undefined &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180 &&
    !(lat === 0 && lon === 0)
  ) {
    station.geo = { lat, lon };
  }

  return station;
}

/**
 * Days since the directory last reached this stream, from its own timestamp.
 * Undefined when it has never said — which prints as an em-dash, not as zero.
 */
function checkAgeDays(iso: unknown): number | undefined {
  if (typeof iso !== 'string' || !iso) return undefined;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return undefined;
  return Math.max(0, Math.floor((Date.now() - then) / 86400000));
}

/**
 * An HLS manifest, by the only signal available before a fetch: the URL.
 *
 * Deliberately cheap and deliberately advisory. The resolver is what actually
 * decides, by content type — this is only good enough to print a warning in the
 * ledger's CODEC column so the row is marked rather than silently unplayable.
 */
function looksLikeHls(url: string): boolean {
  return /\.m3u8(\?|#|$)/i.test(url);
}

/** Map a whole result set, assigning popularity relative to the set. */
export function mapStations(raw: RbStation[]): StationRef[] {
  const pairs: Array<{ station: StationRef; score: number }> = [];
  for (const item of raw) {
    const station = mapStation(item);
    if (station) pairs.push({ station, score: popularityScore(item) });
  }
  const normalised = normalisePopularity(pairs.map((p) => p.score));
  return pairs.map((p, i) => ({ ...p.station, popularity: normalised[i]! }));
}

/**
 * The union of several `tag=` result sets, de-duplicated on `stationuuid`.
 *
 * Radio Browser has no OR: `tagList=trip-hop,triphop` is an AND, and there is
 * no other multi-tag parameter — so a folded group can only be fetched as one
 * request per spelling and merged here. The merge is done on the *wire* rows
 * rather than on mapped `StationRef`s on purpose: `mapStations` min-max
 * normalises popularity across the set it is given, so mapping each sub-result
 * separately would produce three incompatible popularity scales and a dial
 * whose slot widths meant nothing.
 *
 * Order is re-established across the union by the same signal the directory
 * sorts by, because each sub-result is only sorted within itself.
 */
export function mergeTagResults(pages: RbStation[][]): RbStation[] {
  const byId = new Map<string, RbStation>();
  for (const page of pages) {
    for (const row of Array.isArray(page) ? page : []) {
      const id = cleanString(row.stationuuid);
      if (!id || byId.has(id)) continue;
      byId.set(id, row);
    }
  }
  return [...byId.values()].sort(
    (a, b) =>
      (Number(b.clickcount) || 0) - (Number(a.clickcount) || 0) ||
      (Number(b.votes) || 0) - (Number(a.votes) || 0) ||
      (cleanString(a.name) ?? '').localeCompare(cleanString(b.name) ?? ''),
  );
}

/** Row ceiling for one search. See `buildSearchParams`. */
export const MAX_SEARCH_LIMIT = 10000;

export function clampLimit(limit: number): number {
  return Math.min(Math.max(Math.floor(limit) || 1, 1), MAX_SEARCH_LIMIT);
}

/** Build the query string for `/json/stations/search` from a `StationQuery`. */
export function buildSearchParams(query: StationQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.genre) params.set('tag', query.genre.trim().toLowerCase());
  if (query.countryCode) params.set('countrycode', query.countryCode.trim().toUpperCase());
  if (query.language) params.set('language', query.language.trim().toLowerCase());
  if (query.text) params.set('name', query.text.trim());
  // The ceiling is high on purpose. The register's counts are only honest if a
  // pulled card fetches *every* station under it — the largest single term in
  // the live directory is `pop` at 5 933 — so a 500-row cap would turn every
  // printed count into "of the top 500", which is not what the card says.
  params.set('limit', String(clampLimit(query.limit)));
  if (query.offset && query.offset > 0) params.set('offset', String(Math.floor(query.offset)));
  // Strongest-first is what a dial wants: the loud stations should be the ones
  // you land on. clickcount is the better live signal; votes is the tiebreak
  // the API applies internally.
  params.set('order', 'clickcount');
  params.set('reverse', 'true');
  // `hidebroken=true` is deliberately NOT set — see HIDDEN_BROKEN below.
  return params;
}

/**
 * Why no station query asks for `hidebroken=true`.
 *
 * It was set unconditionally here, which meant the directory had already
 * removed every row VERIFIED ONLY could remove before the register ever saw
 * one. Measured: 14 229 rows in hand, zero with `lastCheckOk === false`, and a
 * real toggle of the lever left the count fixed at 5 634. That is a control with
 * no possible job, which Law 1 forbids — and the honest fix is the one that
 * gives it a job rather than the one that cuts it, because the rows it was
 * suppressing are rows a listener may well want:
 *
 *   · the directory's verdict is *its* last check, not a measurement this app
 *     made (Law 2). A station it could not reach an hour ago very often plays.
 *   · the ledger already draws the designed state for one — struck through,
 *     `FAIL` in the CHECKED column, `.entry.is-dead` — and that code path was
 *     unreachable, because no row could ever carry the flag (Law 4).
 *   · a silently missing row is a defect; a printed, struck, dated row is a
 *     designed state.
 *
 * So the rows arrive, VERIFIED ONLY filters them locally on `lastCheckOk`, and
 * the switch demonstrably changes the count in both directions.
 *
 * The tag index drops it for the same reason: the printed edition and the idle
 * scope have to be counting the same population, or a card reading `POP 5 933`
 * sits above a sheet reading `7 100 ENTRIES` and the register looks broken.
 * `/json/countries` and `/json/languages` never had it, so all three axes now
 * agree.
 */
export const HIDDEN_BROKEN = false;

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class RadioBrowserProvider implements DirectoryProvider {
  readonly id = 'radio-browser';

  private readonly timeoutMs: number;
  private readonly userAgent: string;
  private readonly fetchImpl: FetchLike;
  private readonly random: () => number;
  private readonly mirrorTtlMs: number;
  private readonly pinnedMirrors: string[] | null;

  private mirrors: string[] = [];
  private mirrorsFetchedAt = 0;
  private discovery: Promise<string[]> | null = null;
  /** The directory's own place names, folded. Cached on the mirror list's TTL. */
  private places: ReadonlySet<string> | null = null;
  private placesFetchedAt = 0;
  /**
   * groupKey → the spellings folded into it, canonical first.
   *
   * Built as a side effect of `listGenres`, from the *unfiltered* grouping, so
   * a three-station genre nobody would ever put on the dial can still be
   * expanded correctly when the lid's index tunes to it. Kept as a plain field
   * rather than fetched on demand inside `search` so that a tune never pays for
   * a tag-list round trip, and so a directory that answered the tag endpoint
   * once keeps working when it stops answering it.
   */
  private tagGroups: Map<string, string[]> = new Map();

  constructor(options: RadioBrowserOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.random = options.random ?? Math.random;
    this.mirrorTtlMs = options.mirrorTtlMs ?? 30 * 60 * 1000;
    this.pinnedMirrors = options.mirrors ? options.mirrors.map(stripTrailingSlash) : null;
  }

  // --- mirror handling ----------------------------------------------------

  /**
   * The mirror list, discovered once per TTL and shuffled so a fleet of these
   * apps does not all hammer whichever server sorts first.
   */
  async getMirrors(): Promise<string[]> {
    if (this.pinnedMirrors) return this.pinnedMirrors;
    const fresh = Date.now() - this.mirrorsFetchedAt < this.mirrorTtlMs;
    if (this.mirrors.length > 0 && fresh) return this.mirrors;
    // Collapse concurrent discovery into one request.
    this.discovery ??= this.discoverMirrors().finally(() => {
      this.discovery = null;
    });
    return this.discovery;
  }

  private async discoverMirrors(): Promise<string[]> {
    try {
      const servers = await getJson<RbServer[]>(MIRROR_DISCOVERY_URL, {
        timeoutMs: this.timeoutMs,
        userAgent: this.userAgent,
        fetchImpl: this.fetchImpl,
      });
      const names = new Set<string>();
      for (const server of Array.isArray(servers) ? servers : []) {
        const name = cleanString(server.name);
        // Names, not IPs: the mirrors are HTTPS and the certificates are issued
        // for the hostname.
        if (name) names.add(`https://${name.toLowerCase()}`);
      }
      const list = this.shuffle([...names]);
      if (list.length > 0) {
        this.mirrors = list;
        this.mirrorsFetchedAt = Date.now();
        return list;
      }
    } catch {
      // Discovery is best-effort; the fallback list exists for exactly this.
    }
    const fallback = this.shuffle([...FALLBACK_MIRRORS]);
    this.mirrors = fallback;
    this.mirrorsFetchedAt = Date.now();
    return fallback;
  }

  /** Fisher-Yates using the injected RNG, so tests can pin the order. */
  private shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      const a = items[i]!;
      items[i] = items[j]!;
      items[j] = a;
    }
    return items;
  }

  /** Try each mirror in turn; only give up when every one has failed. */
  private async withMirrors<T>(
    path: string,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    const mirrors = await this.getMirrors();
    if (mirrors.length === 0) {
      throw new DirectoryError('no-mirror', 'No Radio Browser mirror could be found');
    }
    let last: DirectoryError | null = null;
    for (const base of mirrors) {
      try {
        return await getJson<T>(`${base}${path}`, {
          timeoutMs: this.timeoutMs,
          userAgent: this.userAgent,
          fetchImpl: this.fetchImpl,
          signal,
        });
      } catch (err) {
        last = err instanceof DirectoryError ? err : new DirectoryError('network', String(err));
        if (signal?.aborted) throw last;
        // A mirror that is down or rate-limiting is not a reason to stop; the
        // next one very likely works.
      }
    }
    // Force rediscovery next time — the cached list is evidently stale.
    this.mirrorsFetchedAt = 0;
    throw new DirectoryError(
      last?.kind ?? 'network',
      `All ${mirrors.length} Radio Browser mirror(s) failed: ${last?.message ?? 'unknown error'}`,
    );
  }

  // --- DirectoryProvider --------------------------------------------------

  /**
   * Real tags with real counts. The band selector is built from this and
   * nothing else — there is no hardcoded genre list anywhere in the app.
   */
  async listGenres(minStations: number, opts?: { signal?: AbortSignal }): Promise<GenreTag[]> {
    // `limit` is not optional here. The endpoint's own default is the first
    // 1000 tags, which stops at around thirty stations — `trip hop` (14) and
    // `triphop` (8) are simply absent, and the fold that makes `trip-hop`
    // reachable at 46 could never happen. Ask for all 11 809.
    const raw = await this.withMirrors<RbTag[]>(
      // No `hidebroken`: the index and the idle scope count the same population.
      // See `HIDDEN_BROKEN`.
      `/json/tags?order=stationcount&reverse=true&limit=${TAG_PAGE}`,
      opts?.signal,
    );
    if (!Array.isArray(raw)) {
      throw new DirectoryError('malformed', 'Tag endpoint did not return a list');
    }
    const tags: RawTag[] = raw.map((t) => ({
      name: typeof t.name === 'string' ? t.name : '',
      count: Number(t.stationcount) || 0,
    }));
    const vocab = { places: await this.placeNames(opts?.signal) };

    // Every group the directory has, floor or no floor — this is the expansion
    // table, and a floor applied to it would make the small genres untunable
    // for a reason that has nothing to do with whether they fit on the dial.
    const all = groupTags(tags, vocab);
    const index = new Map<string, string[]>();
    for (const group of all) index.set(groupKey(group.name), group.spellings);
    this.tagGroups = index;

    const floor = Math.max(1, Math.floor(minStations));
    return all.filter((g) => g.stationCount >= floor);
  }

  /**
   * The whole printed index in one pull: subjects, origins, tongues, totals.
   *
   * Four endpoints, all of them the directory describing itself. Nothing here
   * is authored — the subject terms are the directory's own tag list put
   * through the documented hygiene filter and folded, the origins are its own
   * country list, the tongues its own language list, and the colophon numbers
   * come from `/json/stats`.
   *
   * Law 4: the three list endpoints are load-bearing and a failure throws, but
   * `/json/stats` is a colophon and its failure only costs the printed totals.
   */
  async listIndex(opts?: { signal?: AbortSignal }): Promise<RegisterIndex> {
    const subjects = await this.listGenres(1, opts);

    const [rawOrigins, rawTongues] = await Promise.all([
      this.withMirrors<RbPlace[]>('/json/countries', opts?.signal),
      this.withMirrors<RbLanguage[]>('/json/languages', opts?.signal),
    ]);

    const origins: RegisterPlace[] = [];
    for (const row of Array.isArray(rawOrigins) ? rawOrigins : []) {
      const code = cleanString(row.iso_3166_1)?.toUpperCase();
      const count = Math.max(0, Math.floor(Number(row.stationcount) || 0));
      if (!code || code.length !== 2 || count === 0) continue;
      origins.push({ code, name: shortPlace(cleanString(row.name) ?? code), stationCount: count });
    }
    origins.sort((a, b) => b.stationCount - a.stationCount || a.name.localeCompare(b.name));

    const tongues: RegisterTongue[] = [];
    for (const row of Array.isArray(rawTongues) ? rawTongues : []) {
      const name = cleanString(row.name)?.toLowerCase();
      const count = Math.max(0, Math.floor(Number(row.stationcount) || 0));
      // The language list is a free-text field too: it carries hashtags and
      // stray punctuation. One structural rule, no vocabulary.
      if (!name || count === 0 || !/^[\p{L}][\p{L} \-\u0027]{1,31}$/u.test(name)) continue;
      tongues.push({ name, stationCount: count });
    }
    tongues.sort((a, b) => b.stationCount - a.stationCount || a.name.localeCompare(b.name));

    let totals = { stations: 0, tags: 0, countries: origins.length, languages: tongues.length };
    try {
      const stats = await this.withMirrors<RbStats>('/json/stats', opts?.signal);
      totals = {
        stations: Math.max(0, Math.floor(Number(stats?.stations) || 0)),
        tags: Math.max(0, Math.floor(Number(stats?.tags) || 0)),
        countries: Math.max(0, Math.floor(Number(stats?.countries) || 0)) || origins.length,
        languages: Math.max(0, Math.floor(Number(stats?.languages) || 0)) || tongues.length,
      };
    } catch {
      // A colophon that reads "—" is a smaller loss than a register that will
      // not print because a statistics endpoint was down.
    }

    return { source: this.id, pulledAt: Date.now(), totals, subjects, origins, tongues };
  }

  /**
   * Every spelling the directory holds for a genre, canonical first.
   *
   * Falls back to the name as given when the group index is cold or the genre
   * is not in it — one query for one tag is what this provider did before
   * folding existed, and a degraded answer beats no answer.
   */
  spellingsFor(genre: string): string[] {
    const key = groupKey(genre);
    const known = key ? this.tagGroups.get(key) : undefined;
    if (known && known.length > 0) return known;
    const trimmed = genre.trim().toLowerCase();
    return trimmed ? [trimmed] : [];
  }

  /**
   * The directory's own geography, folded for matching.
   *
   * Radio Browser's tag list is a free-text field, so country and state names
   * end up in it in bulk — `méxico` alone carries 1988 stations and sorts eighth
   * overall. They are places, not genres, and the receiver already has a
   * control for places. Asking the directory which names *are* places beats
   * hardcoding an atlas that would go stale, and it costs one cached round trip
   * per session.
   *
   * Strictly best-effort: if these endpoints are unreachable the band list is
   * merely a little dirtier, which is not a reason to fail a genre load.
   */
  private async placeNames(signal: AbortSignal | undefined): Promise<ReadonlySet<string>> {
    if (this.places && Date.now() - this.placesFetchedAt < this.mirrorTtlMs) return this.places;

    const names = new Set<string>();
    for (const path of ['/json/countries', '/json/states']) {
      try {
        const rows = await this.withMirrors<RbPlace[]>(path, signal);
        for (const row of Array.isArray(rows) ? rows : []) {
          const name = cleanString(row.name);
          if (!name) continue;
          const folded = foldForMatch(name);
          // Single characters and empties would swallow real tags; the length
          // guard in normaliseTag would have caught them anyway, but a place
          // vocabulary that contains "" is a footgun waiting for a refactor.
          if (folded.length >= 2) names.add(folded);
        }
      } catch {
        // Best effort, by design.
      }
    }
    this.places = names;
    this.placesFetchedAt = Date.now();
    return names;
  }

  /**
   * Stations for a query. A genre that folded several spellings together is
   * expanded back into one `tag=` request per spelling, run in parallel and
   * merged on `stationuuid`.
   *
   * N is 1 for the overwhelming majority of genres and never more than 6 in the
   * live directory, so this is not a fan-out worth engineering around — it is
   * simply what the API allows. `tagList` is an AND (`tagList=trip-hop,triphop`
   * means "stations tagged both"), and there is no OR parameter, so N requests
   * is not a choice between designs; it is the only route to the 46 stations.
   */
  async search(query: StationQuery, opts?: DirectorySearchOptions): Promise<StationRef[]> {
    const spellings = query.genre ? this.spellingsFor(query.genre) : [];

    if (spellings.length <= 1) {
      const single = spellings.length === 1 ? { ...query, genre: spellings[0]! } : query;
      // One page, still merged: `mergeTagResults` is also the de-duplication on
      // `stationuuid`, and a single page is not guaranteed unique — a
      // duplicated row printed the same station twice on the drum.
      return mapStations(mergeTagResults([await this.searchPage(single, opts?.signal)]));
    }

    const settled = await Promise.allSettled(
      spellings.map((spelling) => this.searchPage({ ...query, genre: spelling }, opts?.signal)),
    );

    const pages: RbStation[][] = [];
    let failure: DirectoryError | null = null;
    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') pages.push(outcome.value);
      else {
        failure =
          outcome.reason instanceof DirectoryError
            ? outcome.reason
            : new DirectoryError('network', String(outcome.reason));
      }
    }

    // Nothing came back at all: that is a directory failure, not a short list.
    if (pages.length === 0) {
      throw failure ?? new DirectoryError('network', `No spelling of ${query.genre} could be fetched`);
    }
    // Something came back, but not everything. The caller is holding an
    // incomplete band and must be able to say so.
    if (pages.length < spellings.length && failure) {
      opts?.onPartial?.({
        genre: query.genre ?? '',
        spellings: spellings.length,
        fetched: pages.length,
        message: failure.message,
      });
    }

    return mapStations(mergeTagResults(pages).slice(0, clampLimit(query.limit)));
  }

  /** One `/json/stations/search` round trip, mirror-failover included. */
  private async searchPage(
    query: StationQuery,
    signal: AbortSignal | undefined,
  ): Promise<RbStation[]> {
    const params = buildSearchParams(query);
    const raw = await this.withMirrors<RbStation[]>(
      `/json/stations/search?${params.toString()}`,
      signal,
    );
    if (!Array.isArray(raw)) {
      throw new DirectoryError('malformed', 'Station search did not return a list');
    }
    return raw;
  }

  /**
   * Feed the community's own popularity signal. This is what keeps the
   * directory's ranking (and therefore our dial layout) meaningful, so it is
   * worth doing — but it is pure courtesy and must never surface as an error.
   */
  async reportListening(stationId: string): Promise<void> {
    try {
      const id = stationId.trim();
      if (!id) return;
      const mirrors = await this.getMirrors();
      const base = mirrors[0];
      if (!base) return;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        await this.fetchImpl(`${base}/json/url/${encodeURIComponent(id)}`, {
          method: 'POST',
          headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Deliberately silent. A click that fails to register is not a fault the
      // listener should ever hear about.
    }
  }
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Country names, shortened for print.
 *
 * The directory files the United Kingdom as
 * `The United Kingdom Of Great Britain And Northern Ireland` — 56 characters,
 * in a card index 150 pixels wide. This is typography, not a vocabulary: the
 * leading article goes, the shouted conjunctions come down to lower case, and
 * a name still too long for a divider tab is elided. No country is renamed and
 * no list of countries appears anywhere.
 */
export function shortPlace(name: string): string {
  const trimmed = name.replace(/^the\s+/i, '').replace(/\s+/g, ' ').trim();
  const cased = trimmed.replace(/\s+Of\s+/g, ' of ').replace(/\s+And\s+/g, ' and ');
  return cased.length > 26 ? `${cased.slice(0, 25).trimEnd()}…` : cased;
}
