/**
 * The register's facet engine.
 *
 * The register lives or dies on whether a printed count means what the card
 * says it means: "this is what you get if you pull this card". These pin the
 * three rules that make that true — SUBJECT and TONGUE cut against everything
 * pulled, ORIGIN cuts with ORIGIN lifted, and a station's raw tags are folded
 * onto the index's canonical terms before any of it happens.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { groupTags } from '../../src/main/directory/tags';
import {
  EMPTY_SCOPE,
  emptyScope,
  type GenreTag,
  type RegisterIndex,
  type RegisterScope,
  type StationRef,
} from '../../src/shared/contracts';
import {
  NOTCH_DECADE_PCT,
  NOTCH_SPAN_PCT,
  axisLabel,
  canonicalTerms,
  computeView,
  editionSuggestions,
  filterTabs,
  soleExclusions,
  notchPct,
  qualityCaption,
  scopeCaption,
  scopeIsDefault,
  scopeIsEmpty,
  supersetKey,
  supersetQuery,
  termsOf,
  tonguesOf,
  unknownTabs,
} from '../../src/renderer/ui/register/facets';

function tag(name: string, stationCount: number, spellings = [name]): GenreTag {
  return { name, stationCount, spellings };
}

function station(over: Partial<StationRef> & { id: string }): StationRef {
  return {
    name: over.id,
    url: `http://example.invalid/${over.id}`,
    tags: [],
    popularity: 0.5,
    ...over,
  };
}

const index: RegisterIndex = {
  source: 'test',
  pulledAt: 0,
  totals: { stations: 5, tags: 5, countries: 2, languages: 2 },
  subjects: [tag('trip-hop', 46, ['trip-hop', 'trip hop', 'triphop']), tag('jazz', 1402)],
  origins: [
    { code: 'FR', name: 'France', stationCount: 771 },
    { code: 'DE', name: 'Germany', stationCount: 1848 },
  ],
  tongues: [{ name: 'french', stationCount: 700 }, { name: 'german', stationCount: 1433 }],
};

describe('folding a station onto the index', () => {
  it('maps every spelling of a term to the one canonical name', () => {
    const table = canonicalTerms(index.subjects);
    expect(table.get('triphop')).toBe('trip-hop');
    expect(termsOf(station({ id: 'a', tags: ['trip hop'] }), table)).toEqual(['trip-hop']);
    expect(termsOf(station({ id: 'b', tags: ['TRIPHOP'] }), table)).toEqual(['trip-hop']);
  });

  it('counts a station carrying two spellings of one term exactly once', () => {
    // Eight live stations carry two spellings of trip-hop. Counting them twice
    // would make the sheet disagree with itself.
    const table = canonicalTerms(index.subjects);
    expect(termsOf(station({ id: 'c', tags: ['trip-hop', 'triphop'] }), table)).toEqual(['trip-hop']);
  });

  it('drops a tag the index does not file, rather than inventing a term', () => {
    const table = canonicalTerms(index.subjects);
    expect(termsOf(station({ id: 'd', tags: ['radio', 'jazz'] }), table)).toEqual(['jazz']);
  });
});

describe('the superset query', () => {
  it('asks the directory for the most selective pulled axis', () => {
    expect(supersetQuery({ ...EMPTY_SCOPE, terms: ['trip-hop'] }, 9)).toEqual({ genre: 'trip-hop', limit: 9 });
    expect(supersetQuery({ ...EMPTY_SCOPE, origin: 'FR' }, 9)).toEqual({ countryCode: 'FR', limit: 9 });
    expect(supersetQuery({ ...EMPTY_SCOPE, tongues: ['french'] }, 9)).toEqual({ language: 'french', limit: 9 });
  });

  it('prefers subject over origin, because it is the tighter superset', () => {
    expect(supersetQuery({ ...EMPTY_SCOPE, terms: ['jazz'], origin: 'FR' }, 9)).toEqual({ genre: 'jazz', limit: 9 });
  });

  it('has no axis to fetch when nothing is pulled', () => {
    expect(supersetQuery({ ...EMPTY_SCOPE }, 9)).toBeNull();
    expect(scopeIsEmpty({ ...EMPTY_SCOPE })).toBe(true);
    expect(scopeIsEmpty({ ...EMPTY_SCOPE, minKbps: 128 })).toBe(false);
  });
});

describe('what the register prints for a scope', () => {
  it('names the idle scope rather than showing a search box', () => {
    expect(scopeCaption({ ...EMPTY_SCOPE }, () => '')).toBe('ON AIR NOW · MOST LISTENED');
  });

  it('reads back every pulled card in order', () => {
    const caption = scopeCaption(
      { ...EMPTY_SCOPE, terms: ['jazz'], origin: 'FR', minKbps: 128 },
      (code) => (code === 'FR' ? 'France' : code),
    );
    expect(caption).toBe('JAZZ · FRANCE · ≥128K');
  });

  it('says ANY RATE rather than leaving the plate blank', () => {
    expect(qualityCaption({ ...EMPTY_SCOPE })).toBe('ANY RATE');
    expect(qualityCaption({ ...EMPTY_SCOPE, minKbps: 128, codec: 'MP3' })).toBe('≥128K · MP3');
  });
});

describe('re-cutting the combs against what is pulled', () => {
  const rows: StationRef[] = [
    station({ id: 'a', tags: ['trip hop'], countryCode: 'FR', language: 'french', claimedBitrate: 128, clickCount: 90 }),
    station({ id: 'b', tags: ['trip-hop', 'jazz'], countryCode: 'DE', language: 'german', claimedBitrate: 320, clickCount: 50 }),
    station({ id: 'c', tags: ['jazz'], countryCode: 'FR', language: 'french', claimedBitrate: 64, clickCount: 10 }),
  ];

  it('prints the directory global counts while nothing is pulled', () => {
    const view = computeView(rows, { ...EMPTY_SCOPE }, index, 'listeners');
    expect(view.global).toBe(true);
    expect(view.subjects.find((t) => t.key === 'trip-hop')?.count).toBe(46);
    expect(view.subjects.find((t) => t.key === 'trip-hop')?.spellings).toBe(3);
  });

  it('cuts subject counts against everything pulled once a card is out', () => {
    const view = computeView(rows, { ...EMPTY_SCOPE, origin: 'FR' }, index, 'listeners');
    expect(view.global).toBe(false);
    expect(view.rows.map((s) => s.id)).toEqual(['a', 'c']);
    expect(view.subjects.find((t) => t.key === 'trip-hop')?.count).toBe(1);
    expect(view.subjects.find((t) => t.key === 'jazz')?.count).toBe(1);
  });

  it('cuts origin counts with ORIGIN lifted, so the map keeps the whole world', () => {
    const view = computeView(rows, { ...EMPTY_SCOPE, origin: 'FR' }, index, 'listeners');
    // Germany is still counted even though France is pulled: ORIGIN is a single
    // throw, and a count of zero would say "you cannot go there", which is false.
    expect(view.origins.find((t) => t.key === 'DE')?.count).toBe(1);
    expect(view.origins.find((t) => t.key === 'FR')?.count).toBe(2);
    expect(view.origins.find((t) => t.key === 'FR')?.pulled).toBe(true);
  });

  it('combines two subject cards with AND', () => {
    const view = computeView(rows, { ...EMPTY_SCOPE, terms: ['trip-hop', 'jazz'] }, index, 'listeners');
    expect(view.rows.map((s) => s.id)).toEqual(['b']);
  });

  it('applies the quality bar to the claimed bitrate', () => {
    const view = computeView(rows, { ...EMPTY_SCOPE, minKbps: 128 }, index, 'listeners');
    expect(view.rows.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('keeps a pulled card visible even when it now counts zero', () => {
    const view = computeView([], { ...EMPTY_SCOPE, terms: ['trip-hop'] }, index, 'listeners');
    const tab = view.subjects.find((t) => t.key === 'trip-hop');
    expect(tab).toBeDefined();
    expect(tab!.pulled).toBe(true);
    expect(tab!.count).toBe(0);
  });

  it('orders the sheet by the bank that is pressed', () => {
    expect(computeView(rows, { ...EMPTY_SCOPE }, index, 'listeners').rows.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(computeView(rows, { ...EMPTY_SCOPE }, index, 'bitrate').rows.map((s) => s.id)).toEqual(['b', 'a', 'c']);
  });

  it('marks a station the directory could not reach rather than hiding it', () => {
    const dead = station({ id: 'x', lastCheckOk: false, tags: ['jazz'] });
    expect(computeView([dead], { ...EMPTY_SCOPE, verifiedOnly: false }, index, 'listeners').rows).toHaveLength(1);
    expect(computeView([dead], { ...EMPTY_SCOPE, verifiedOnly: true }, index, 'listeners').rows).toHaveLength(0);
  });
});

describe('typing at a comb head', () => {
  const tabs = [
    { key: 'trip-hop', label: 'trip-hop', count: 46, pulled: false },
    { key: 'jazz', label: 'jazz', count: 1402, pulled: true },
  ];

  it('narrows to what was typed', () => {
    // `jazz` survives only because it is pulled — see the next case.
    expect(filterTabs(tabs, 'trip').map((t) => t.key)).toEqual(['trip-hop', 'jazz']);
    expect(filterTabs([tabs[0]!], 'trip').map((t) => t.key)).toEqual(['trip-hop']);
    expect(filterTabs([tabs[0]!], 'reggae')).toEqual([]);
  });

  it('never hides a card that is already pulled', () => {
    expect(filterTabs(tabs, 'zzz').map((t) => t.key)).toEqual(['jazz']);
  });
});

// ---------------------------------------------------------------------------
// FIX 1 — which scopes the rows in hand can honestly answer
// ---------------------------------------------------------------------------

describe('the population a scope needs in hand', () => {
  it('is the same for every change the rows in hand already answer', () => {
    const pop: RegisterScope = { ...EMPTY_SCOPE, terms: ['pop'] };
    const key = supersetKey(pop);
    // Adding a second term: only terms[0] is ever fetched, so pop's own
    // population still provably contains every pop∧rock station.
    expect(supersetKey({ ...pop, terms: ['pop', 'rock'] })).toBe(key);
    // Narrowing by any axis that is applied locally over that population.
    expect(supersetKey({ ...pop, origin: 'FR' })).toBe(key);
    expect(supersetKey({ ...pop, tongues: ['french'] })).toBe(key);
    expect(supersetKey({ ...pop, text: 'radiodio' })).toBe(key);
    expect(supersetKey({ ...pop, minKbps: 320 })).toBe(key);
    expect(supersetKey({ ...pop, codec: 'FLAC' })).toBe(key);
    expect(supersetKey({ ...pop, verifiedOnly: false })).toBe(key);
    expect(supersetKey({ ...pop, hideHls: false })).toBe(key);
  });

  it('changes the moment a different fetch is needed', () => {
    const idle = supersetKey(EMPTY_SCOPE);
    const pop = supersetKey({ ...EMPTY_SCOPE, terms: ['pop'] });
    const jazz = supersetKey({ ...EMPTY_SCOPE, terms: ['jazz'] });
    const france = supersetKey({ ...EMPTY_SCOPE, origin: 'FR' });
    const french = supersetKey({ ...EMPTY_SCOPE, tongues: ['french'] });
    const text = supersetKey({ ...EMPTY_SCOPE, text: 'radiodio' });
    expect(new Set([idle, pop, jazz, france, french, text]).size).toBe(6);
    // Dropping the term that *was* the fetch is a different fetch too — this
    // is the direction the register used to keep the widest, wrongest numbers.
    expect(supersetKey({ ...EMPTY_SCOPE, terms: ['pop'], origin: 'FR' })).toBe(pop);
    expect(supersetKey({ ...EMPTY_SCOPE, origin: 'FR' })).toBe(france);
  });

  it('names the same axis the host actually fetches', () => {
    for (const scope of [
      { ...EMPTY_SCOPE, terms: ['pop'] },
      { ...EMPTY_SCOPE, origin: 'FR' },
      { ...EMPTY_SCOPE, tongues: ['french'] },
      { ...EMPTY_SCOPE, text: 'radiodio' },
      EMPTY_SCOPE,
    ]) {
      const query = supersetQuery(scope, 900);
      const key = supersetKey(scope);
      if (!query) expect(key).toBe('edition');
      else expect(key).toContain(String(query.genre ?? query.countryCode ?? query.language ?? query.text));
    }
  });
});

describe('the cards printed while the press is running', () => {
  const tabs = [
    { key: 'pop', label: 'pop', count: 5939, pulled: false },
    { key: 'jazz', label: 'jazz', count: 1402, pulled: false },
  ];

  it('keeps the names and voids every count', () => {
    const out = unknownTabs(tabs, new Set());
    expect(out.map((t) => t.label)).toEqual(['pop', 'jazz']);
    expect(out.every((t) => t.unknown === true)).toBe(true);
    expect(out.every((t) => t.count === 0)).toBe(true);
  });

  it('shows a term pulled a moment ago even before any rows arrive', () => {
    const out = unknownTabs(tabs, new Set(['reggae']));
    expect(out[0]!.key).toBe('reggae');
    expect(out[0]!.pulled).toBe(true);
    expect(out[0]!.unknown).toBe(true);
  });

  it('does not carry the previous scope’s pulled marks over', () => {
    const wasPulled = [{ key: 'pop', label: 'pop', count: 5939, pulled: true }];
    expect(unknownTabs(wasPulled, new Set())[0]!.pulled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FIX 3 — the notch is a scale, not a ranking
// ---------------------------------------------------------------------------

describe('notch depth', () => {
  it('does not move when the scope around it moves', () => {
    // The reported defect, in numbers: `pop` at 5 939 cut 62.0 %, and after
    // typing "trip" `trip-hop` at 46 also cut 62.0 %, because depth was
    // normalised against whatever was currently on top.
    expect(notchPct(5939)).not.toBeCloseTo(notchPct(46), 5);
    // Same count, same depth, forever — there is no second argument to pass.
    expect(notchPct(46)).toBe(notchPct(46));
  });

  it('keeps the whole live range legible and distinct', () => {
    const seen = [3, 12, 46, 240, 600, 5939, 12513].map(notchPct);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]!).toBeGreaterThan(seen[i - 1]!);
      // Every step is worth at least a pixel of a 228 px comb.
      expect(seen[i]! - seen[i - 1]!).toBeGreaterThan(0.4);
    }
    expect(notchPct(3)).toBeGreaterThan(4);
    expect(notchPct(12513)).toBeLessThan(NOTCH_SPAN_PCT);
  });

  it('gives every tenfold the same step, which is what the printed rules mark', () => {
    for (const decade of [1, 2, 3, 4]) {
      const step = notchPct(Math.pow(10, decade)) - notchPct(Math.pow(10, decade - 1));
      expect(step).toBeCloseTo(NOTCH_DECADE_PCT, 0);
    }
  });

  it('cuts nothing for nothing and never overruns the card', () => {
    expect(notchPct(0)).toBe(0);
    expect(notchPct(-1)).toBe(0);
    expect(notchPct(10_000_000)).toBeLessThanOrEqual(NOTCH_SPAN_PCT);
  });
});

// ---------------------------------------------------------------------------
// FIX 2 — the structurally complete idle scope
// ---------------------------------------------------------------------------

describe('the idle scope', () => {
  it('spells out every axis, including the two that could not be cleared', () => {
    // `in` rather than a truthiness check: the bug was a *missing key*, which
    // a merge cannot overwrite. A value of undefined is the fix, not the bug.
    for (const axis of ['terms', 'origin', 'tongues', 'text', 'minKbps', 'codec', 'verifiedOnly', 'hideHls']) {
      expect(Object.prototype.hasOwnProperty.call(EMPTY_SCOPE, axis)).toBe(true);
    }
    expect(EMPTY_SCOPE.origin).toBeUndefined();
    expect(EMPTY_SCOPE.text).toBeUndefined();
  });

  it('merging it over a filled scope now really does clear everything', () => {
    const filled: RegisterScope = {
      terms: ['jazz'], origin: 'FR', tongues: ['french'], text: 'radiodio 3',
      minKbps: 320, codec: 'FLAC', verifiedOnly: false, hideHls: false,
    };
    expect({ ...filled, ...EMPTY_SCOPE }).toEqual(EMPTY_SCOPE);
  });

  it('hands out fresh arrays, so two scopes cannot share one', () => {
    const a = emptyScope();
    const b = emptyScope();
    a.terms.push('jazz');
    expect(b.terms).toEqual([]);
    expect(EMPTY_SCOPE.terms).toEqual([]);
  });

  it('knows the difference between "nothing filed" and "nothing at all"', () => {
    expect(scopeIsDefault(EMPTY_SCOPE)).toBe(true);
    // scopeIsEmpty ignores the levers on purpose; scopeIsDefault must not.
    // (Engaged, not disengaged: both levers now start off, so a lever *on* is
    // the state that differs from the idle scope.)
    const leverOn: RegisterScope = { ...EMPTY_SCOPE, hideHls: true };
    expect(scopeIsEmpty(leverOn)).toBe(true);
    expect(scopeIsDefault(leverOn)).toBe(false);
  });

  /**
   * FIX 4 / FIX 3, at the source. The register prints `IN SCOPE — NOTHING — THE
   * WHOLE EDITION IS IN SCOPE` for this scope, and a critic measured that
   * sentence while HIDE HLS was withholding 191 of 2 000 rows. It is only a true
   * sentence if the idle scope really withholds nothing.
   */
  it('withholds nothing at all in the idle scope', () => {
    expect(EMPTY_SCOPE.verifiedOnly).toBe(false);
    expect(EMPTY_SCOPE.hideHls).toBe(false);
    expect(emptyScope().verifiedOnly).toBe(false);
    expect(emptyScope().hideHls).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The tongue comb
// ---------------------------------------------------------------------------

describe('a station that speaks more than one language', () => {
  /**
   * Radio Browser's `language` field is a comma-separated list and its
   * `language=` query matches *any* member of it. The provider kept only the
   * first, and the register then matched on that one field — so a station listed
   * `english,german`, returned by a German fetch, was dropped again locally, and
   * two tongue cards pulled together could never match anything at all.
   */
  const bilingual = station({
    id: 'bi',
    name: 'Deutsche Welle English',
    tags: ['news'],
    countryCode: 'DE',
    language: 'english',
    languages: ['english', 'german'],
    clickCount: 100,
  });
  const monolingual = station({
    id: 'mono',
    name: 'Bayern 2',
    tags: ['news'],
    countryCode: 'DE',
    language: 'german',
    languages: ['german'],
    clickCount: 50,
  });
  const rows = [bilingual, monolingual];

  it('reads every tongue off the record, not just the first', () => {
    expect(tonguesOf(bilingual)).toEqual(['english', 'german']);
    expect(tonguesOf(monolingual)).toEqual(['german']);
  });

  it('still files a station that only carries the single field', () => {
    // Rows read back off disk, or from another provider, predate `languages`.
    expect(tonguesOf(station({ id: 'old', language: 'French' }))).toEqual(['french']);
    expect(tonguesOf(station({ id: 'none' }))).toEqual([]);
  });

  it('keeps a station the German fetch really returned', () => {
    const view = computeView(rows, { ...EMPTY_SCOPE, tongues: ['german'] }, index, 'listeners');
    expect(view.rows.map((s) => s.id)).toEqual(['bi', 'mono']);
  });

  it('counts it under both of its tongues, so the comb can be pulled', () => {
    const view = computeView(rows, { ...EMPTY_SCOPE, origin: 'DE' }, index, 'listeners');
    expect(view.tongues.find((t) => t.key === 'german')?.count).toBe(2);
    expect(view.tongues.find((t) => t.key === 'english')?.count).toBe(1);
  });

  it('makes an AND across two tongue cards satisfiable at all', () => {
    // The defect in one line: a single-valued field cannot equal two things, so
    // this combination used to return zero rows by construction, whatever the
    // directory held.
    const view = computeView(rows, { ...EMPTY_SCOPE, tongues: ['english', 'german'] }, index, 'listeners');
    expect(view.rows.map((s) => s.id)).toEqual(['bi']);
  });

  it('still excludes a station that does not speak the tongue at all', () => {
    const french = station({ id: 'fr', language: 'french', languages: ['french'] });
    const view = computeView([...rows, french], { ...EMPTY_SCOPE, tongues: ['german'] }, index, 'listeners');
    expect(view.rows.map((s) => s.id)).not.toContain('fr');
  });

  it('is case-insensitive on both sides, as the directory is not consistent', () => {
    const shouty = station({ id: 'sh', languages: ['English', 'German'] });
    const view = computeView([shouty], { ...EMPTY_SCOPE, tongues: ['GERMAN'] }, index, 'listeners');
    expect(view.rows.map((s) => s.id)).toEqual(['sh']);
  });
});

// ---------------------------------------------------------------------------
// FIX 1 — the spelling fold is applied to the search that finds folded groups
// ---------------------------------------------------------------------------

/**
 * The client's own example, against the directory's own tag list.
 *
 * `test/fixtures/radiobrowser/tags.json` is a real capture: `trip-hop` 24,
 * `trip hop` 14, `triphop` 8, and `hip hop` 655. The register folds those into
 * one card each — and then the box that finds a card matched only the canonical
 * label, so `trip hop`, the one phrase a listener actually says, returned a red
 * `NO SUBJECT TERM MATCHES 'TRIP HOP' IN THIS SCOPE` and nothing else.
 *
 * The index here is built by the shipping `groupTags`, not written out by hand,
 * so the fixture and the fold are the same fold the app performs.
 */
describe('finding a folded group by any of its spellings', () => {
  const raw = JSON.parse(
    readFileSync(new URL('../fixtures/radiobrowser/tags.json', import.meta.url), 'utf8'),
  ) as Array<{ name: string; stationcount: number }>;
  const subjects = groupTags(raw.map((t) => ({ name: t.name, count: t.stationcount })));
  const folded: RegisterIndex = {
    source: 'fixture',
    pulledAt: 0,
    totals: { stations: 0, tags: raw.length, countries: 0, languages: 0 },
    subjects,
    origins: [],
    tongues: [],
  };
  /** The cards the register would print with nothing pulled. */
  const cards = computeView([], EMPTY_SCOPE, folded, 'listeners').subjects;

  it('folded the fixture the way the client described', () => {
    const group = subjects.find((s) => s.name === 'trip-hop')!;
    expect(group.spellings.sort()).toEqual(['trip hop', 'trip-hop', 'triphop']);
    expect(group.stationCount).toBe(46);
  });

  it('resolves every spelling of trip-hop to the one card', () => {
    const table = ['trip hop', 'triphop', 'trip-hop', 'trip', 'TRIP HOP', ' Trip-Hop '].map(
      (typed) => {
        const hits = filterTabs(cards, typed);
        const first = hits[0];
        return {
          typed,
          card: first ? `${first.label} · ${first.spellings ?? 1} SPELLINGS · ${first.count}` : null,
        };
      },
    );
    for (const row of table) {
      expect(row.card, `typing "${row.typed}"`).toBe('trip-hop · 3 SPELLINGS · 46');
    }
    // And it is one group, not four cards that merely look alike: the key the
    // scope would store is identical, which is what "selects the same group"
    // means.
    const keys = new Set(
      ['trip hop', 'triphop', 'trip-hop', 'trip'].map((t) => filterTabs(cards, t)[0]!.key),
    );
    expect([...keys]).toEqual(['trip-hop']);
  });

  it('does the same for the hip-hop family', () => {
    for (const typed of ['hip hop', 'hiphop', 'hip-hop', 'HIP  HOP']) {
      expect(filterTabs(cards, typed)[0]!.key, typed).toBe('hip hop');
    }
  });

  it('folds diacritics too, so an accent is not a failed search', () => {
    // `música en español` is in the fixture; typing it unaccented must find it.
    expect(filterTabs(cards, 'musica en espanol')[0]!.key).toBe('música en español');
    expect(filterTabs(cards, 'música en español')[0]!.key).toBe('música en español');
  });

  it('still finds nothing for a term the edition does not hold', () => {
    expect(filterTabs(cards, 'zzzznotagenre')).toEqual([]);
  });

  it('falls back to the raw test when the query folds to nothing', () => {
    // `groupKey('---')` is the empty string, which would otherwise match every
    // card in the comb.
    expect(filterTabs(cards, '---')).toEqual([]);
  });

  it('offers the edition’s own terms when the scope holds none of them', () => {
    const suggestions = editionSuggestions(folded, 'trip hop', [], 3);
    expect(suggestions[0]).toBe('TRIP-HOP 46');
    expect(editionSuggestions(folded, 'zzzznotagenre', [], 3)).toEqual([]);
    // A term already on screen is not "elsewhere".
    expect(editionSuggestions(folded, 'trip hop', cards, 3)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// FIX 5 — which predicate actually removed the rows
// ---------------------------------------------------------------------------

describe('attributing an empty sheet to the filter that emptied it', () => {
  const name = (code: string): string => (code === 'FR' ? 'France' : code);

  it('names the switch that withheld the rows, with the count it will return', () => {
    // The critic's scenario: five HLS mounts for a name search, HIDE HLS on.
    const rows = [1, 2, 3, 4, 5].map((i) =>
      station({ id: `hls-${i}`, name: 'BBC Radio 3', hls: true, tags: ['jazz'] }),
    );
    const scope: RegisterScope = { ...EMPTY_SCOPE, text: 'BBC Radio 3', hideHls: true };
    expect(computeView(rows, scope, index, 'listeners').rows).toHaveLength(0);
    expect(soleExclusions(rows, scope, index, name)).toEqual([
      { axis: 'hls', label: 'HIDE HLS', count: 5 },
    ]);
  });

  it('blames only a filter that is on its own responsible', () => {
    const rows = [
      // HLS alone.
      station({ id: 'a', hls: true, claimedBitrate: 320 }),
      // Bitrate alone.
      station({ id: 'b', claimedBitrate: 64 }),
      // Both: turning either one off returns nothing, so neither is blamed.
      station({ id: 'c', hls: true, claimedBitrate: 64 }),
    ];
    const scope: RegisterScope = { ...EMPTY_SCOPE, hideHls: true, minKbps: 192 };
    // Biggest first; equal counts break on the printed label.
    expect(soleExclusions(rows, scope, index, name)).toEqual([
      { axis: 'quality', label: '≥192 KBPS', count: 1 },
      { axis: 'hls', label: 'HIDE HLS', count: 1 },
    ]);
  });

  it('blames nothing when nothing is excluded', () => {
    const rows = [station({ id: 'a', claimedBitrate: 320 })];
    expect(soleExclusions(rows, EMPTY_SCOPE, index, name)).toEqual([]);
  });

  it('counts the VERIFIED ONLY lever, which can now actually fire', () => {
    const rows = [station({ id: 'dead', lastCheckOk: false })];
    const scope: RegisterScope = { ...EMPTY_SCOPE, verifiedOnly: true };
    expect(soleExclusions(rows, scope, index, name)).toEqual([
      { axis: 'verified', label: 'VERIFIED ONLY', count: 1 },
    ]);
  });

  it('names every filter in the words its own control is printed with', () => {
    const scope: RegisterScope = {
      terms: ['trip-hop'], origin: 'FR', tongues: ['french'], text: 'soma',
      minKbps: 128, codec: 'MP3', verifiedOnly: true, hideHls: true,
    };
    expect(axisLabel('verified', scope, name)).toBe('VERIFIED ONLY');
    expect(axisLabel('hls', scope, name)).toBe('HIDE HLS');
    expect(axisLabel('quality', scope, name)).toBe('≥128 KBPS');
    expect(axisLabel('codec', scope, name)).toBe('MP3');
    expect(axisLabel('text', scope, name)).toBe('"soma"');
    expect(axisLabel('subject', scope, name)).toBe('TRIP-HOP');
    expect(axisLabel('origin', scope, name)).toBe('FRANCE');
    expect(axisLabel('tongue', scope, name)).toBe('FRENCH');
  });
});
