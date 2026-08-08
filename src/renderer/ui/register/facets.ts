/**
 * The register's facet engine.
 *
 * A printed station handbook is filed on three axes — subject, origin, tongue —
 * and the whole point of a card index is that every comb re-cuts its counts
 * against the cards already pulled. A printed number has to mean *"this is what
 * you get if you pull this card"*, or the index is decoration.
 *
 * Radio Browser has no faceted-count endpoint. There is no server-side way to
 * ask "how many jazz stations are there in France at ≥128 kbps", so the counts
 * are computed here, over the rows the register is holding.
 *
 * ## Why the counts are exact rather than sampled
 *
 * The register never facets a *page*. When any card is pulled, the host fetches
 * the complete population of the most selective pulled axis — every station
 * carrying that subject term (across all its folded spellings), or every station
 * from that origin, or every station in that tongue. The largest such
 * population in the live directory is `pop` at 5 933 rows, which one request
 * returns. Everything narrower than that axis is then applied here, over a set
 * that provably contains every row that could match. So the counts printed on
 * the cards are the directory's own numbers, not a sample of them.
 *
 * The one exception is the idle scope, where nothing is pulled: there is no
 * axis to fetch, so the sheet shows the most-listened page and the combs print
 * the directory's *global* index counts instead. Those are exact too — they are
 * what the directory reports about itself — and the caption says so.
 *
 * Everything in this module is pure and synchronous.
 */

import type {
  GenreTag,
  RegisterIndex,
  RegisterScope,
  StationQuery,
  StationRef,
} from '../../../shared/contracts';
import { EMPTY_SCOPE } from '../../../shared/contracts';
import { groupKey } from '../../../main/directory/tags';

/** One divider tab: a printed name, a printed count, and whether it is pulled. */
export interface Tab {
  /** The value the scope stores — a canonical term, an ISO code, a language. */
  key: string;
  /** What is printed on the tab. */
  label: string;
  count: number;
  pulled: boolean;
  /**
   * How many directory spellings folded into this term. Printed when it is
   * more than one, because that is the fact the card is making: `TRIP-HOP ·
   * 3 SPELLINGS · 46` is one card where the directory holds three tags.
   */
  spellings?: number;
  /**
   * Everything this card answers to, folded with `groupKey` and space-joined.
   *
   * The fold exists so nobody has to know how the directory spells things, and
   * the box that finds a folded group matched only its canonical label — so the
   * one phrase a user actually says was the one that failed. `trip hop` found
   * nothing; `trip-hop` found `trip-hop · 3 SPELLINGS · 46`. This is what
   * `filterTabs` matches against, so every member spelling selects the group.
   *
   * Space-joined rather than concatenated: a folded query can never contain a
   * space, so no query can match across the seam between two spellings.
   */
  folded?: string;
  /**
   * The count is not known yet — the rows this scope needs are still being
   * fetched, so `count` is meaningless and must not be printed. Law 2 for the
   * index: a number is a measurement of rows in hand, and when there are no
   * rows in hand for this question the register prints an em-dash instead of
   * the answer to the previous question.
   */
  unknown?: boolean;
}

export type SortKey = 'listeners' | 'votes' | 'bitrate' | 'checked' | 'name';

export interface RegisterView {
  /** Rows in scope, sorted. */
  rows: StationRef[];
  subjects: Tab[];
  origins: Tab[];
  tongues: Tab[];
  /**
   * True when the comb counts come from the directory's global index rather
   * than from the rows in hand — i.e. nothing is pulled. The register prints
   * this distinction rather than blurring it.
   */
  global: boolean;
}

// ---------------------------------------------------------------------------
// Folding a station's raw tags onto the index's canonical terms
// ---------------------------------------------------------------------------

/**
 * `groupKey` → canonical term, built once from the index.
 *
 * A station arrives carrying `trip hop`; the index files it under `trip-hop`.
 * Without this table the ledger row and the divider tab would disagree about
 * what the same station is, which is precisely the defect the fold exists to
 * remove.
 */
export function canonicalTerms(subjects: readonly GenreTag[]): Map<string, string> {
  const cached = FOLD_CACHE.get(subjects);
  if (cached) return cached;
  const table = new Map<string, string>();
  for (const subject of subjects) {
    for (const spelling of subject.spellings) {
      const key = groupKey(spelling);
      if (key) table.set(key, subject.name);
    }
    const key = groupKey(subject.name);
    if (key) table.set(key, subject.name);
  }
  FOLD_CACHE.set(subjects, table);
  return table;
}

/**
 * The fold table, kept per edition rather than per paint.
 *
 * A live edition carries 10 028 subject terms across 11 818 spellings, and this
 * table was rebuilt from all of them on *every* repaint — including once per
 * keystroke typed at an index head. It is a pure function of an array the
 * register holds for the lifetime of the edition, so it is cached against that
 * array's identity: a new edition is a new array and gets a new table, and a
 * `WeakMap` means the old one is collected with it.
 */
const FOLD_CACHE = new WeakMap<readonly GenreTag[], Map<string, string>>();

interface EditionTables {
  spellingCount: Map<string, number>;
  originNames: Map<string, string>;
  /** Subject term → every spelling of it, folded. See `Tab.folded`. */
  subjectFolded: Map<string, string>;
  /** ISO code → its printed name *and* the code itself, folded. */
  originFolded: Map<string, string>;
  /** Tongue → folded. */
  tongueFolded: Map<string, string>;
}
const EDITION_CACHE = new WeakMap<RegisterIndex, EditionTables>();
function emptyTables(): EditionTables {
  return {
    spellingCount: new Map(),
    originNames: new Map(),
    subjectFolded: new Map(),
    originFolded: new Map(),
    tongueFolded: new Map(),
  };
}
const EMPTY_TABLES: EditionTables = emptyTables();

/**
 * The other per-edition lookups, cached for the same reason and lifetime.
 *
 * The folded match strings belong here rather than being built during a paint:
 * a live edition carries 10 028 subject terms across 11 818 spellings, and
 * `filterTabs` runs once per keystroke at an index head. Folding all of them per
 * keystroke is exactly the cost `FOLD_CACHE` above exists to avoid.
 */
function editionTables(index: RegisterIndex | null): EditionTables {
  if (!index) return EMPTY_TABLES;
  const cached = EDITION_CACHE.get(index);
  if (cached) return cached;
  const tables = emptyTables();
  for (const subject of index.subjects) {
    tables.spellingCount.set(subject.name, subject.spellings.length);
    const keys: string[] = [];
    for (const spelling of [subject.name, ...subject.spellings]) {
      const key = groupKey(spelling);
      if (key && !keys.includes(key)) keys.push(key);
    }
    tables.subjectFolded.set(subject.name, keys.join(' '));
  }
  for (const origin of index.origins) {
    tables.originNames.set(origin.code, origin.name);
    tables.originFolded.set(origin.code, `${groupKey(origin.name)} ${groupKey(origin.code)}`);
  }
  for (const tongue of index.tongues) tables.tongueFolded.set(tongue.name, groupKey(tongue.name));
  EDITION_CACHE.set(index, tables);
  return tables;
}

/**
 * Every tongue a station is filed under, lowercased.
 *
 * `StationRef.language` is the *first* of them, and matching on it alone was two
 * defects at once. A station listed `english,german` is genuinely part of the
 * German population and is genuinely what a `language=german` fetch returns —
 * dropping it locally under-reported every tongue and skewed the sheet's
 * reconciliation against the index's own count. And because one field cannot
 * hold two values, an AND across two pulled tongue cards could never match
 * anything at all: the comb was unsatisfiable by construction.
 *
 * Falls back to the single field so a `StationRef` from any other provider, or
 * one read back off disk before this contract existed, still files correctly.
 */
export function tonguesOf(station: StationRef): string[] {
  const list = station.languages;
  if (list && list.length > 0) return list.map((l) => l.toLowerCase());
  const one = station.language?.toLowerCase();
  return one ? [one] : [];
}

/**
 * A station's subject terms, folded and de-duplicated.
 *
 * Tags the index does not file — the junk the hygiene filter removed, and
 * anything the directory added since the index was pulled — are dropped rather
 * than invented into terms, so a row can never carry a term no card exists for.
 */
export function termsOf(station: StationRef, canonical: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  for (const tag of station.tags) {
    const term = canonical.get(groupKey(tag));
    if (term && !out.includes(term)) out.push(term);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

export function scopeIsEmpty(scope: RegisterScope): boolean {
  return (
    scope.terms.length === 0 &&
    scope.tongues.length === 0 &&
    !scope.origin &&
    !scope.text &&
    scope.minKbps === 0 &&
    scope.codec === 'ANY'
  );
}

/**
 * Is this the idle scope in *every* respect, levers included?
 *
 * `scopeIsEmpty` answers a different question — "are the comb counts global?" —
 * and deliberately ignores the two lever switches, because they do not change
 * which axis is fetched. CLEAR ALL needs the stricter reading: it is offered
 * only when there is something for it to clear, and after it there must be
 * nothing left, which is the defect it is fixing.
 */
export function scopeIsDefault(scope: RegisterScope): boolean {
  return (
    scopeIsEmpty(scope) &&
    scope.verifiedOnly === EMPTY_SCOPE.verifiedOnly &&
    scope.hideHls === EMPTY_SCOPE.hideHls
  );
}

/** The scope in printed words, as it appears on the sheet and on the plate. */
export function scopeCaption(scope: RegisterScope, originName: (code: string) => string): string {
  const bits: string[] = [];
  for (const term of scope.terms) bits.push(term);
  if (scope.origin) bits.push(originName(scope.origin));
  for (const tongue of scope.tongues) bits.push(tongue);
  if (scope.text) bits.push(`"${scope.text}"`);
  if (scope.minKbps) bits.push(`≥${scope.minKbps}K`);
  if (scope.codec !== 'ANY') bits.push(scope.codec);
  return bits.length ? bits.join(' · ').toUpperCase() : 'ON AIR NOW · MOST LISTENED';
}

/** The claimed-quality line, printed on the plate beside the scope. */
export function qualityCaption(scope: RegisterScope): string {
  const rate = scope.minKbps ? `≥${scope.minKbps}K` : 'ANY RATE';
  return scope.codec === 'ANY' ? rate : `${rate} · ${scope.codec}`;
}

/**
 * The single query whose answer provably contains every row in this scope.
 *
 * Most selective axis first, because the fetch is a superset and a tighter
 * superset means fewer rows to filter and a faster register. Subject beats
 * origin beats tongue beats free text; with nothing pulled there is no axis and
 * the caller falls back to the most-listened page.
 *
 * Only *one* axis goes to the server. Radio Browser's `tagList` is an AND, so
 * two folded terms would need one request per combination of spellings — up to
 * thirty-six for two six-spelling groups. Filtering the second term here costs
 * nothing and is exactly as correct.
 */
export function supersetQuery(scope: RegisterScope, limit: number): StationQuery | null {
  if (scope.terms.length > 0) return { genre: scope.terms[0]!, limit };
  if (scope.origin) return { countryCode: scope.origin, limit };
  if (scope.tongues.length > 0) return { language: scope.tongues[0]!, limit };
  if (scope.text) return { text: scope.text, limit };
  return null;
}

/**
 * The identity of the population a scope needs in hand before any number about
 * it can be printed. This is the whole of FIX 1 in one function.
 *
 * The register's counts are exact *because* the rows it holds are a provable
 * superset of the scope (see the header of this file). The corollary went
 * unwritten and therefore unenforced: the instant the scope needs a **different**
 * superset, every number derived from the rows in hand is not stale-ish, it is
 * an answer to a question nobody asked. Pulling POP while holding the
 * most-listened page printed `223 ENTRIES` — the pop stations that happened to
 * be on that page — for a term that holds 5 629, and CUT BAND committed to it.
 *
 * Two scopes share a key exactly when one fetch answers both, so:
 *
 *   · POP → POP + FRANCE          same key; France is filtered from pop's own
 *                                 population, so the count is exact and printing
 *                                 it immediately is honest, not optimistic.
 *   · POP → POP + ROCK            same key; only `terms[0]` reaches the server.
 *   · POP → ≥128 kbps, MP3, levers, station-name text — same key, all local.
 *   · nothing → POP               different key. Nothing may be printed.
 *   · POP → JAZZ, POP → nothing   different key. Nothing may be printed.
 *
 * That distinction is what keeps the honest state from becoming a blanket
 * spinner: the cheap two thirds of the register's gestures never blank at all,
 * and the third that genuinely does not know says so.
 */
export function supersetKey(scope: RegisterScope): string {
  const query = supersetQuery(scope, 1);
  if (!query) return 'edition';
  if (query.genre !== undefined) return `subject ${query.genre}`;
  if (query.countryCode !== undefined) return `origin ${query.countryCode}`;
  if (query.language !== undefined) return `tongue ${query.language}`;
  return `text ${query.text ?? ''}`;
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

type Axis = 'subject' | 'origin' | 'tongue' | null;

/**
 * Every filter the scope can apply, as the register labels it.
 *
 * Named, because the empty sheet has to be able to say which one emptied it.
 * `NO ENTRY — take a term out of the scope, or lower the quality bar` was
 * measured naming neither of the two switches that had actually done it:
 * searching `BBC Radio 3` with HIDE HLS engaged printed that sentence, and
 * turning HIDE HLS off returned five rows immediately.
 */
export type ScopeAxis = 'verified' | 'hls' | 'quality' | 'codec' | 'text' | Exclude<Axis, null>;

/**
 * The scope's predicates, in one ordered table.
 *
 * `passes` and `rejectedBy` are two readings of the same list rather than two
 * copies of it: the first asks "did anything reject this row", short-circuiting
 * as it always did, and the second asks "*what* rejected it". A second copy of
 * eight predicates is a defect waiting to be written, because the message on the
 * empty sheet would then be able to disagree with the filtering that produced it.
 */
const AXES: ReadonlyArray<{
  axis: ScopeAxis;
  rejects(station: StationRef, terms: readonly string[], scope: RegisterScope): boolean;
}> = [
  { axis: 'verified', rejects: (s, _t, sc) => sc.verifiedOnly && s.lastCheckOk === false },
  { axis: 'hls', rejects: (s, _t, sc) => sc.hideHls && !!s.hls },
  { axis: 'quality', rejects: (s, _t, sc) => sc.minKbps > 0 && (s.claimedBitrate ?? 0) < sc.minKbps },
  {
    axis: 'codec',
    rejects: (s, _t, sc) =>
      sc.codec !== 'ANY' && !(s.claimedCodec ?? '').toUpperCase().startsWith(sc.codec),
  },
  {
    axis: 'text',
    rejects: (s, _t, sc) => !!sc.text && !s.name.toLowerCase().includes(sc.text.toLowerCase()),
  },
  {
    axis: 'subject',
    rejects: (_s, terms, sc) => {
      for (const term of sc.terms) if (!terms.includes(term)) return true;
      return false;
    },
  },
  { axis: 'origin', rejects: (s, _t, sc) => !!sc.origin && (s.countryCode ?? '') !== sc.origin },
  {
    axis: 'tongue',
    rejects: (s, _t, sc) => {
      if (sc.tongues.length === 0) return false;
      const spoken = tonguesOf(s);
      for (const want of sc.tongues) if (!spoken.includes(want.toLowerCase())) return true;
      return false;
    },
  },
];

/**
 * Does this row survive the scope, with one axis lifted?
 *
 * The lift is what makes the printed counts honest. SUBJECT and TONGUE combine
 * with AND — pulling a second card narrows — so their counts are cut against
 * everything currently pulled, including the other cards in their own comb.
 * ORIGIN is a single throw (pulling France replaces Germany rather than
 * intersecting with it), so its counts are cut with ORIGIN lifted. That is why
 * the map keeps showing the whole world while you are standing in one country.
 */
function passes(
  station: StationRef,
  terms: readonly string[],
  scope: RegisterScope,
  skip: Axis,
): boolean {
  for (const entry of AXES) {
    if (entry.axis !== skip && entry.rejects(station, terms, scope)) return false;
  }
  return true;
}

/** Which of the scope's filters reject this row. Empty means it is in scope. */
function rejectedBy(
  station: StationRef,
  terms: readonly string[],
  scope: RegisterScope,
): ScopeAxis[] {
  const out: ScopeAxis[] = [];
  for (const entry of AXES) if (entry.rejects(station, terms, scope)) out.push(entry.axis);
  return out;
}

/** One filter, and how many rows it is on its own responsible for withholding. */
export interface Exclusion {
  axis: ScopeAxis;
  /** As the control that carries it is printed on the rail. */
  label: string;
  count: number;
}

/** What the register prints for a filter, in the words of the control itself. */
export function axisLabel(
  axis: ScopeAxis,
  scope: RegisterScope,
  originName: (code: string) => string,
): string {
  switch (axis) {
    case 'verified':
      return 'VERIFIED ONLY';
    case 'hls':
      return 'HIDE HLS';
    case 'quality':
      return `≥${scope.minKbps} KBPS`;
    case 'codec':
      return scope.codec;
    case 'text':
      return `"${scope.text ?? ''}"`;
    case 'subject':
      return scope.terms.join(' + ').toUpperCase();
    case 'origin':
      return (scope.origin ? originName(scope.origin) : '').toUpperCase();
    case 'tongue':
      return scope.tongues.join(' + ').toUpperCase();
  }
}

/**
 * For every filter in the scope, how many rows in hand it *alone* keeps out.
 *
 * Sole blame is the only attribution worth printing. A row rejected by both
 * HIDE HLS and ≥192 KBPS comes back for neither switch on its own, so counting
 * it against both would send the user to turn off a lever that changes nothing —
 * which is the same class of defect as naming no lever at all. Only rows that
 * one filter and one filter alone withholds are counted, so every number here is
 * a promise: turn this off and exactly this many rows appear.
 *
 * Runs only when the sheet is empty, so its cost is paid in the one state that
 * has nothing else to do.
 */
export function soleExclusions(
  stations: readonly StationRef[],
  scope: RegisterScope,
  index: RegisterIndex | null,
  originName: (code: string) => string,
): Exclusion[] {
  const canonical = canonicalTerms(index?.subjects ?? []);
  const counts = new Map<ScopeAxis, number>();
  for (const station of stations) {
    const blame = rejectedBy(station, termsOf(station, canonical), scope);
    if (blame.length !== 1) continue;
    const axis = blame[0]!;
    counts.set(axis, (counts.get(axis) ?? 0) + 1);
  }
  return [...counts]
    .map(([axis, count]) => ({ axis, label: axisLabel(axis, scope, originName), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

const SORTS: Record<SortKey, (a: StationRef, b: StationRef) => number> = {
  listeners: (a, b) => (b.clickCount ?? 0) - (a.clickCount ?? 0) || (b.votes ?? 0) - (a.votes ?? 0),
  votes: (a, b) => (b.votes ?? 0) - (a.votes ?? 0),
  bitrate: (a, b) => (b.claimedBitrate ?? 0) - (a.claimedBitrate ?? 0) || (b.clickCount ?? 0) - (a.clickCount ?? 0),
  // Freshest check first; a station the directory has never reached sorts last
  // rather than first, which an unguarded ascending sort on `undefined` would do.
  checked: (a, b) =>
    (a.lastCheckAgeDays ?? Number.MAX_SAFE_INTEGER) - (b.lastCheckAgeDays ?? Number.MAX_SAFE_INTEGER) ||
    (b.clickCount ?? 0) - (a.clickCount ?? 0),
  name: (a, b) => a.name.localeCompare(b.name),
};

function rank(counts: Map<string, number>, pulled: ReadonlySet<string>, label: (key: string) => string): Tab[] {
  const keys = new Set<string>([...counts.keys(), ...pulled]);
  const tabs: Tab[] = [];
  for (const key of keys) {
    tabs.push({ key, label: label(key), count: counts.get(key) ?? 0, pulled: pulled.has(key) });
  }
  tabs.sort(
    (a, b) =>
      Number(b.pulled) - Number(a.pulled) ||
      b.count - a.count ||
      a.label.localeCompare(b.label),
  );
  return tabs;
}

/**
 * Recompute the whole register: which rows are in scope, and what every comb
 * should print beside every card.
 *
 * One pass over the rows in hand. The largest set that ever reaches here is one
 * subject term's whole population — a few thousand rows — so this is a
 * sub-millisecond operation and the register can be a mechanical instrument
 * rather than something with a spinner in it.
 */
export function computeView(
  stations: readonly StationRef[],
  scope: RegisterScope,
  index: RegisterIndex | null,
  sort: SortKey,
): RegisterView {
  const canonical = canonicalTerms(index?.subjects ?? []);
  const { spellingCount, originNames, subjectFolded, originFolded, tongueFolded } =
    editionTables(index);

  const rows: StationRef[] = [];
  const subjectCounts = new Map<string, number>();
  const originCounts = new Map<string, number>();
  const tongueCounts = new Map<string, number>();

  for (const station of stations) {
    const terms = termsOf(station, canonical);
    const inScope = passes(station, terms, scope, null);
    if (inScope) {
      rows.push(station);
      for (const term of terms) subjectCounts.set(term, (subjectCounts.get(term) ?? 0) + 1);
      // Every tongue on the record, for the same reason `terms` is every subject
      // on it: a bilingual station is one card in each comb, and a comb that
      // counted only the first would print a number the pull cannot reproduce.
      for (const tongue of tonguesOf(station)) {
        tongueCounts.set(tongue, (tongueCounts.get(tongue) ?? 0) + 1);
      }
    }
    if (passes(station, terms, scope, 'origin')) {
      const code = station.countryCode;
      if (code) originCounts.set(code, (originCounts.get(code) ?? 0) + 1);
    }
  }
  rows.sort(SORTS[sort]);

  const global = scopeIsEmpty(scope);
  const pulledTerms = new Set(scope.terms);
  const pulledTongues = new Set(scope.tongues.map((t) => t.toLowerCase()));
  const pulledOrigin = new Set(scope.origin ? [scope.origin] : []);

  let subjects: Tab[];
  let origins: Tab[];
  let tongues: Tab[];

  if (global && index) {
    // Nothing pulled: the cards print the directory's own global counts, which
    // are the real numbers for the whole edition rather than for one page of it.
    subjects = index.subjects.map((s) => ({
      key: s.name,
      label: s.name,
      count: s.stationCount,
      pulled: false,
      spellings: s.spellings.length,
    }));
    origins = index.origins.map((o) => ({ key: o.code, label: o.name, count: o.stationCount, pulled: false }));
    tongues = index.tongues.map((t) => ({ key: t.name, label: t.name, count: t.stationCount, pulled: false }));
  } else {
    subjects = rank(subjectCounts, pulledTerms, (k) => k);
    origins = rank(originCounts, pulledOrigin, (k) => originNames.get(k) ?? k);
    tongues = rank(tongueCounts, pulledTongues, (k) => k);
    for (const tab of subjects) tab.spellings = spellingCount.get(tab.key);
  }
  // FIX 1: what each card answers to at its index head. A table lookup per
  // card, never a fold per card — the folding was done once for the edition.
  for (const tab of subjects) tab.folded = subjectFolded.get(tab.key);
  for (const tab of origins) tab.folded = originFolded.get(tab.key);
  for (const tab of tongues) tab.folded = tongueFolded.get(tab.key);

  return { rows, subjects, origins, tongues, global };
}

/**
 * Filter a comb's tabs by what was typed at its head. Pulled cards never hide.
 *
 * ## FIX 1 — the fold is applied to the box that finds the folded group
 *
 * The app folds 11 823 directory tags into 10 033 groups *specifically* so that
 * nobody has to know how the directory spells things. This search then matched
 * only the group's canonical label, so the one phrase a user actually says was
 * the one that failed:
 *
 *   | typed       | before                          | after                        |
 *   |-------------|---------------------------------|------------------------------|
 *   | `trip hop`  | NO SUBJECT TERM MATCHES…, 0     | trip-hop · 3 SPELLINGS · 46  |
 *   | `triphop`   | 0                               | trip-hop · 3 SPELLINGS · 46  |
 *   | `trip-hop`  | trip-hop · 3 SPELLINGS · 46     | unchanged                    |
 *   | `trip`      | trip-hop · 3 SPELLINGS · 46     | unchanged                    |
 *
 * Both sides now go through `groupKey`, the very key the index folded on:
 * diacritics folded, lowercased, every non-alphanumeric deleted. So `hip hop`,
 * `hiphop` and `hip-hop` are one query, `musica` finds `música`, and the card
 * that comes back is the same card in every case — which is what makes all four
 * spellings *select the same group* rather than merely find it.
 *
 * Folding can only ever add matches: both the query and the card lose the same
 * characters, so anything the plain substring test used to find is still found.
 * A query with no alphanumerics at all folds to nothing, and would otherwise
 * match every card in the comb, so that case falls back to the raw test.
 */
export function filterTabs(tabs: readonly Tab[], query: string): Tab[] {
  const raw = query.trim().toLowerCase();
  if (!raw) return [...tabs];
  const folded = groupKey(query);
  if (!folded) return tabs.filter((tab) => tab.pulled || tab.label.toLowerCase().includes(raw));
  return tabs.filter(
    (tab) => tab.pulled || (tab.folded ?? groupKey(tab.label)).includes(folded),
  );
}

/**
 * Terms the whole edition holds for this query that are *not* in the current
 * scope — what the comb offers instead of a flat red no-match.
 *
 * A term absent from the rows in hand is a real and useful fact ("no jazz in
 * Iceland"), but printing only the refusal leaves the user unable to tell it
 * apart from a spelling they got wrong. This is the difference, computed against
 * the same folded key the search uses.
 */
export function editionSuggestions(
  index: RegisterIndex | null,
  query: string,
  inScope: readonly Tab[],
  limit: number,
): string[] {
  const folded = groupKey(query);
  if (!index || !folded) return [];
  const { subjectFolded } = editionTables(index);
  const shown = new Set(inScope.map((tab) => tab.key));
  const out: string[] = [];
  for (const subject of index.subjects) {
    if (shown.has(subject.name)) continue;
    if (!(subjectFolded.get(subject.name) ?? groupKey(subject.name)).includes(folded)) continue;
    out.push(`${subject.name.toUpperCase()} ${subject.stationCount}`);
    if (out.length >= limit) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The notch: a printed depth scale, not a bar chart
// ---------------------------------------------------------------------------

/**
 * How deep the widest possible notch is cut, as a percentage of the tab.
 * Unchanged from the original drawing so the comb still looks like a comb.
 */
export const NOTCH_SPAN_PCT = 62;

/**
 * Decades of station count the notch scale spans: 1 station to 100 000.
 *
 * ## Why a fixed logarithmic scale
 *
 * The notch is the register's one claim to being a physical object: a divider
 * card cut to a depth that says how much is filed behind it. It was normalised
 * against `max(counts currently shown)`, which meant `pop` at 5 939 cut 62 % —
 * and after typing "trip" into the same comb, `trip-hop` at 46 also cut 62 %.
 * The deepest card was always full depth, so the depth carried no information
 * at all beyond rank, and two cards seen a second apart could not be compared.
 * A card that has been cut stays cut.
 *
 * So the scale is anchored to absolute counts. It has to stay legible from the
 * 3-station terms in the tail to `pop` at 12 513 in the fattest edition, four
 * decades apart:
 *
 *   · linear (÷100 000) puts everything under 1 000 in the first 1 % of the
 *     travel — the entire tail becomes one indistinguishable hairline;
 *   · square root, the old within-view curve, still spends two thirds of the
 *     travel above 10 000, which almost nothing reaches;
 *   · log10 gives every ×10 the *same* step. 3 → 5.9 %, 46 → 20.6 %,
 *     600 → 34.5 %, 5 939 → 46.8 %, 12 513 → 50.8 %. Adjacent terms in the
 *     tail stay distinguishable and the head does not saturate.
 *
 * Equal steps per decade is also what makes the scale readable rather than
 * merely stable: the comb prints a hairline rule every decade, so the notch can
 * be *counted off* — three rules deep is "thousands" — in any comb, in any
 * scope, in any edition. `NOTCH_DECADE_PCT` is that spacing, handed to the
 * stylesheet rather than duplicated in it.
 *
 * The ceiling is 100 000: above the largest tag any real directory carries, so
 * the scale never has to be re-cut, and no term can ever reach the end stop.
 */
export const NOTCH_DECADES = 5;

/** Percentage of tab width per decade of stations — the printed rule spacing. */
export const NOTCH_DECADE_PCT = NOTCH_SPAN_PCT / NOTCH_DECADES;

/**
 * Notch depth for a count, in percent of tab width, on the fixed decade scale.
 *
 * One station is the datum and cuts nothing — which is the honest reading, and
 * is the same place the first printed rule sits. Ten thousand cuts four rules
 * deep. Nothing can reach the end stop.
 */
export function notchPct(count: number): number {
  if (!(count > 1)) return 0;
  return Math.min(NOTCH_DECADES, Math.log10(count)) * NOTCH_DECADE_PCT;
}

// ---------------------------------------------------------------------------
// What a comb prints while it does not know
// ---------------------------------------------------------------------------

/**
 * The cards to print while the press is running: the names stay, the counts go.
 *
 * Emptying the combs during a fetch would be its own defect — the register's
 * three indexes would blink out for the better part of a second, and the pull
 * you just made would have nothing to show for it. Names are navigation and are
 * not a claim about this scope; counts are measurements and are. So the names
 * are held, every count becomes unknown, and any card pulled since is spliced
 * in at the top so the gesture registers instantly.
 */
export function unknownTabs(
  tabs: readonly Tab[],
  pulled: ReadonlySet<string>,
  label: (key: string) => string = (key) => key,
): Tab[] {
  const out: Tab[] = tabs.map((tab) => ({
    ...tab,
    count: 0,
    unknown: true,
    pulled: pulled.has(tab.key),
  }));
  const known = new Set(out.map((tab) => tab.key));
  for (const key of pulled) {
    if (!known.has(key)) out.unshift({ key, label: label(key), count: 0, pulled: true, unknown: true });
  }
  // Stable sort: pulled cards ride up, everything else keeps the order it had,
  // so the comb does not reshuffle under the hand while it waits.
  out.sort((a, b) => Number(b.pulled) - Number(a.pulled));
  return out;
}
