import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DirectoryError } from '../../src/main/directory/http';
import {
  buildSearchParams,
  mapStation,
  mapStations,
  normalisePopularity,
  popularityScore,
  RadioBrowserProvider,
  type RbStation,
} from '../../src/main/directory/radioBrowser';
import { startJsonServer, type JsonServer } from '../helpers/fixtureServer';

// ---------------------------------------------------------------------------
// Pure mapping
// ---------------------------------------------------------------------------

describe('mapping a directory record onto a StationRef', () => {
  const full: RbStation = {
    stationuuid: 'uuid-1',
    name: '  Radio Example  ',
    url: 'http://old.example.invalid/stream',
    url_resolved: 'https://new.example.invalid/stream',
    homepage: 'https://example.invalid',
    favicon: 'https://example.invalid/icon.png',
    tags: 'Jazz, blues ,JAZZ,,swing',
    country: 'Germany',
    countrycode: 'de',
    language: 'german,english',
    codec: 'MP3',
    bitrate: 128,
    votes: 100,
    clickcount: 50,
    geo_lat: 52.52,
    geo_long: 13.405,
  };

  it('prefers the resolved URL but only when there is one', () => {
    expect(mapStation(full)?.url).toBe('https://new.example.invalid/stream');
    expect(mapStation({ ...full, url_resolved: '' })?.url).toBe('http://old.example.invalid/stream');
  });

  it('trims the station name', () => {
    expect(mapStation(full)?.name).toBe('Radio Example');
  });

  it('lowercases tags, drops blanks and removes duplicates', () => {
    expect(mapStation(full)?.tags).toEqual(['jazz', 'blues', 'swing']);
  });

  it('uppercases the country code', () => {
    expect(mapStation(full)?.countryCode).toBe('DE');
  });

  it('takes the first language when several are listed', () => {
    expect(mapStation(full)?.language).toBe('german');
  });

  it('keeps every language, because the directory matches on any of them', () => {
    // `language=english` really does return this station, so throwing away
    // everything after the comma made the register filter it straight back out
    // — and made two tongue cards pulled together unsatisfiable by construction.
    expect(mapStation(full)?.languages).toEqual(['german', 'english']);
  });

  it('lowercases and de-duplicates the language list, as it does the tags', () => {
    const s = mapStation({ ...full, language: 'German, ENGLISH , german,' });
    expect(s?.languages).toEqual(['german', 'english']);
    expect(s?.language).toBe('german');
  });

  it('leaves both language fields off a record that carries none', () => {
    const s = mapStation({ ...full, language: '  ' });
    expect(s?.language).toBeUndefined();
    expect(s?.languages).toBeUndefined();
  });

  it('carries the claimed bitrate and codec as advisory values', () => {
    expect(mapStation(full)).toMatchObject({ claimedBitrate: 128, claimedCodec: 'MP3' });
  });

  it('omits a bitrate of zero rather than claiming the stream is silent', () => {
    expect(mapStation({ ...full, bitrate: 0 })?.claimedBitrate).toBeUndefined();
  });

  it('omits a codec the directory itself calls UNKNOWN', () => {
    expect(mapStation({ ...full, codec: 'UNKNOWN' })?.claimedCodec).toBeUndefined();
  });

  it('carries coordinates through for the world map', () => {
    expect(mapStation(full)?.geo).toEqual({ lat: 52.52, lon: 13.405 });
  });

  it('treats (0,0) as "not set" rather than putting a station in the Atlantic', () => {
    expect(mapStation({ ...full, geo_lat: 0, geo_long: 0 })?.geo).toBeUndefined();
  });

  it('omits coordinates that are out of range', () => {
    expect(mapStation({ ...full, geo_lat: 999, geo_long: 5 })?.geo).toBeUndefined();
  });

  it('omits coordinates when only one of the pair is present', () => {
    expect(mapStation({ ...full, geo_long: null })?.geo).toBeUndefined();
  });

  it('rejects a record with no id, no name or no URL, because it cannot be tuned', () => {
    expect(mapStation({ ...full, stationuuid: '' })).toBeNull();
    expect(mapStation({ ...full, name: '  ' })).toBeNull();
    expect(mapStation({ ...full, url: '', url_resolved: '' })).toBeNull();
  });
});

describe('popularity', () => {
  it('rises with votes and with clicks', () => {
    expect(popularityScore({ votes: 100, clickcount: 10 })).toBeGreaterThan(
      popularityScore({ votes: 10, clickcount: 10 }),
    );
    expect(popularityScore({ votes: 10, clickcount: 100 })).toBeGreaterThan(
      popularityScore({ votes: 10, clickcount: 10 }),
    );
  });

  it('treats missing counters as zero rather than as NaN', () => {
    expect(popularityScore({})).toBe(0);
  });

  it('normalises a result set onto 0..1 inclusive', () => {
    const out = normalisePopularity([1, 5, 3, 9]);
    expect(Math.min(...out)).toBe(0);
    expect(Math.max(...out)).toBe(1);
  });

  it('keeps the ordering of the input', () => {
    const out = normalisePopularity([1, 5, 3, 9]);
    expect(out[3]).toBeGreaterThan(out[1]!);
    expect(out[1]).toBeGreaterThan(out[2]!);
  });

  it('gives a neutral value when every station scores the same', () => {
    expect(normalisePopularity([7, 7, 7])).toEqual([0.5, 0.5, 0.5]);
  });

  it('gives a lone station a neutral value rather than a fake maximum', () => {
    expect(normalisePopularity([42])).toEqual([0.5]);
  });

  it('handles an empty result set', () => {
    expect(normalisePopularity([])).toEqual([]);
  });

  it('does not let one runaway station flatten everyone else to zero', () => {
    // Log scaling is the whole point: linear scaling would put the mid-table
    // station at ~0.0003, and dial-slot width is derived from this.
    const out = mapStations([
      { stationuuid: 'a', name: 'A', url: 'http://a/', votes: 300000, clickcount: 5000 },
      { stationuuid: 'b', name: 'B', url: 'http://b/', votes: 3000, clickcount: 300 },
      { stationuuid: 'c', name: 'C', url: 'http://c/', votes: 1, clickcount: 0 },
    ]);
    expect(out[1]!.popularity).toBeGreaterThan(0.3);
    expect(out[1]!.popularity).toBeLessThan(1);
  });

  it('assigns 0..1 across whatever the search returned', () => {
    const out = mapStations([
      { stationuuid: 'a', name: 'A', url: 'http://a/', votes: 10 },
      { stationuuid: 'b', name: 'B', url: 'http://b/', votes: 1000 },
    ]);
    expect(out.map((s) => s.popularity).sort()).toEqual([0, 1]);
  });

  it('skips unusable records while mapping a set', () => {
    const out = mapStations([
      { stationuuid: 'a', name: 'A', url: 'http://a/' },
      { stationuuid: '', name: 'broken', url: 'http://b/' },
    ]);
    expect(out.map((s) => s.id)).toEqual(['a']);
  });
});

describe('building the search request', () => {
  it('orders by click count descending', () => {
    const params = buildSearchParams({ limit: 10 });
    expect(params.get('order')).toBe('clickcount');
    expect(params.get('reverse')).toBe('true');
  });

  /**
   * This asserted `hidebroken=true` and that is precisely what made VERIFIED
   * ONLY a control with no possible job: the directory had already removed every
   * row the switch could remove. Measured on the running product — 14 229 rows
   * in hand, zero with `lastCheckOk === false`, and a real toggle of the lever
   * leaving the count fixed at 5 634. The rows have to arrive for the lever to
   * be able to filter them.
   */
  it('never asks the directory to hide broken stations, so the lever can', () => {
    const params = buildSearchParams({ limit: 10 });
    expect(params.get('hidebroken')).toBeNull();
    expect(params.toString()).not.toContain('hidebroken');
  });

  it('maps the genre onto the tag parameter', () => {
    expect(buildSearchParams({ genre: 'Jazz', limit: 10 }).get('tag')).toBe('jazz');
  });

  it('maps the country code onto countrycode, uppercased', () => {
    expect(buildSearchParams({ countryCode: 'de', limit: 10 }).get('countrycode')).toBe('DE');
  });

  it('maps free text onto the name parameter', () => {
    expect(buildSearchParams({ text: ' soma ', limit: 10 }).get('name')).toBe('soma');
  });

  it('passes limit and offset through', () => {
    const params = buildSearchParams({ limit: 25, offset: 50 });
    expect(params.get('limit')).toBe('25');
    expect(params.get('offset')).toBe('50');
  });

  it('omits offset when there is none, rather than sending zero', () => {
    expect(buildSearchParams({ limit: 25 }).get('offset')).toBeNull();
  });

  it('clamps an absurd limit', () => {
    // The ceiling is 10 000 rather than 500 because the register's printed
    // counts are only honest if a pulled card fetches the *whole* population
    // of its axis; the largest single term in the live directory is `pop` at
    // 5 933, so a 500-row cap would silently make every count "of the top 500".
    expect(buildSearchParams({ limit: 100000 }).get('limit')).toBe('10000');
    expect(buildSearchParams({ limit: 0 }).get('limit')).toBe('1');
  });

  it('omits filters that were not asked for', () => {
    const params = buildSearchParams({ limit: 10 });
    expect(params.get('tag')).toBeNull();
    expect(params.get('countrycode')).toBeNull();
    expect(params.get('name')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Against a local stand-in for the API
// ---------------------------------------------------------------------------

describe('talking to a Radio Browser mirror', () => {
  let api: JsonServer;

  beforeEach(async () => {
    api = await startJsonServer();
  });
  afterEach(async () => {
    await api.close();
  });

  function provider(extra: Record<string, unknown> = {}): RadioBrowserProvider {
    return new RadioBrowserProvider({ mirrors: [api.base], timeoutMs: 2000, ...extra });
  }

  it('sends a descriptive User-Agent, as the API asks clients to', async () => {
    let seen: string | undefined;
    const p = new RadioBrowserProvider({
      mirrors: [api.base],
      fetchImpl: async (input, init) => {
        seen = new Headers(init?.headers).get('user-agent') ?? undefined;
        return fetch(input, init);
      },
    });
    await p.listGenres(1);
    expect(seen).toBe('Weltempfaenger/0.1');
  });

  it('builds the band list from the live tag endpoint', async () => {
    const genres = await provider().listGenres(1);
    expect(genres.length).toBeGreaterThan(0);
    expect(genres.map((g) => g.name)).toContain('jazz');
  });

  it('reports real counts, merged across casing variants', async () => {
    const genres = await provider().listGenres(1);
    expect(genres.find((g) => g.name === 'jazz')?.stationCount).toBe(1402 + 61 + 12);
  });

  it('strips the junk tags the directory is full of', async () => {
    const names = (await provider().listGenres(1)).map((g) => g.name);
    for (const junk of ['128', '2024', 'radio', 'music', 'undefined', '-', 'a', 'aaaaaaaa']) {
      expect(names).not.toContain(junk);
    }
  });

  it('applies the minimum station count', async () => {
    const genres = await provider().listGenres(500);
    expect(genres.every((g) => g.stationCount >= 500)).toBe(true);
    expect(genres.map((g) => g.name)).not.toContain('trance');
  });

  it('hits the real tag endpoint rather than a hardcoded list', async () => {
    await provider().listGenres(1);
    expect(api.requests.some((r) => r.includes('/json/tags'))).toBe(true);
  });

  it('asks the directory which names are places rather than hardcoding an atlas', async () => {
    await provider().listGenres(1);
    expect(api.requests.some((r) => r.includes('/json/countries'))).toBe(true);
    expect(api.requests.some((r) => r.includes('/json/states'))).toBe(true);
  });

  it('drops directory junk that is a place, a brand or a generic word', async () => {
    const names = (await provider().listGenres(1)).map((g) => g.name);
    // Places, from the directory's own country and state lists.
    expect(names).not.toContain('méxico');
    expect(names).not.toContain('veracruz');
    // A continent, from the closed region set.
    expect(names).not.toContain('norteamérica');
    // A contributor's name applied across a catalogue.
    expect(names).not.toContain('moi merino');
    // A word true of every station, in the language it was typed.
    expect(names).not.toContain('entretenimiento');
  });

  it('keeps a genuine non-English genre on the dial', async () => {
    const names = (await provider().listGenres(1)).map((g) => g.name);
    expect(names).toContain('música en español');
  });

  it('caches the place vocabulary rather than re-fetching it per genre load', async () => {
    const p = provider();
    await p.listGenres(1);
    const first = api.requests.filter((r) => r.includes('/json/countries')).length;
    await p.listGenres(1);
    expect(api.requests.filter((r) => r.includes('/json/countries')).length).toBe(first);
  });

  it('still returns genres when the geography endpoints are unreachable', async () => {
    const p = provider();
    api.failures.set('/json/countries', 'error');
    api.failures.set('/json/states', 'error');
    const names = (await p.listGenres(1)).map((g) => g.name);
    expect(names).toContain('jazz');
    // Without the vocabulary the place tags survive — degraded, not broken.
    expect(names).toContain('méxico');
  });

  it('maps a search result onto StationRefs with normalised popularity', async () => {
    const found = await provider().search({ genre: 'jazz', limit: 10 });
    expect(found.map((s) => s.name)).toEqual([
      'Classic Vinyl HD',
      'Radio Swiss Jazz',
      'Null Island Jazz',
    ]);
    expect(Math.max(...found.map((s) => s.popularity))).toBe(1);
    expect(Math.min(...found.map((s) => s.popularity))).toBe(0);
  });

  it('drops records that could never be tuned', async () => {
    const found = await provider().search({ genre: 'jazz', limit: 10 });
    expect(found.map((s) => s.id)).not.toContain('');
    expect(found.some((s) => s.name === 'Station with no url at all')).toBe(false);
  });

  it('sends the query parameters it was asked for', async () => {
    await provider().search({ genre: 'jazz', countryCode: 'de', text: 'swiss', limit: 5, offset: 10 });
    const request = api.requests.find((r) => r.includes('/json/stations/search'))!;
    expect(request).toContain('tag=jazz');
    expect(request).toContain('countrycode=DE');
    expect(request).toContain('name=swiss');
    expect(request).toContain('limit=5');
    expect(request).toContain('offset=10');
    expect(request).not.toContain('hidebroken');
  });

  it('does not hide broken stations from the tag index either', async () => {
    await provider().listGenres(1);
    const request = api.requests.find((r) => r.includes('/json/tags'))!;
    // The printed edition and the idle scope have to be counting the same
    // population, or a card reading POP 5 933 sits over a sheet reading 7 100.
    expect(request).not.toContain('hidebroken');
  });

  it('posts to the click endpoint when a listen is reported', async () => {
    await provider().reportListening('uuid-1');
    expect(api.requests).toContain('POST /json/url/uuid-1');
  });
});

describe('surviving a directory that is having a bad day', () => {
  let api: JsonServer;
  beforeEach(async () => {
    api = await startJsonServer();
  });
  afterEach(async () => {
    await api.close();
  });

  it('falls through to the next mirror when the first refuses the connection', async () => {
    const p = new RadioBrowserProvider({
      mirrors: ['http://127.0.0.1:1', api.base],
      timeoutMs: 2000,
    });
    expect((await p.listGenres(1)).length).toBeGreaterThan(0);
  });

  it('falls through when a mirror returns a server error', async () => {
    const broken = await startJsonServer();
    broken.failures.set('*', 'error');
    try {
      const p = new RadioBrowserProvider({ mirrors: [broken.base, api.base], timeoutMs: 2000 });
      expect((await p.listGenres(1)).length).toBeGreaterThan(0);
    } finally {
      await broken.close();
    }
  });

  it('falls through when a mirror returns something that is not JSON', async () => {
    const captive = await startJsonServer();
    captive.failures.set('*', 'garbage');
    try {
      const p = new RadioBrowserProvider({ mirrors: [captive.base, api.base], timeoutMs: 2000 });
      expect((await p.listGenres(1)).length).toBeGreaterThan(0);
    } finally {
      await captive.close();
    }
  });

  it('falls through when a mirror accepts the connection and then says nothing', async () => {
    const silent = await startJsonServer();
    silent.failures.set('*', 'hang');
    try {
      const p = new RadioBrowserProvider({ mirrors: [silent.base, api.base], timeoutMs: 400 });
      expect((await p.listGenres(1)).length).toBeGreaterThan(0);
    } finally {
      await silent.close();
    }
  });

  it('raises a typed directory error only once every mirror has failed', async () => {
    const p = new RadioBrowserProvider({
      mirrors: ['http://127.0.0.1:1', 'http://127.0.0.1:2'],
      timeoutMs: 500,
    });
    await expect(p.listGenres(1)).rejects.toBeInstanceOf(DirectoryError);
    await expect(p.listGenres(1)).rejects.toThrow(/mirror\(s\) failed/);
  });

  it('never lets a failed listen report reach the caller', async () => {
    const p = new RadioBrowserProvider({ mirrors: ['http://127.0.0.1:1'], timeoutMs: 300 });
    await expect(p.reportListening('uuid-1')).resolves.toBeUndefined();
  });

  it('never lets a listen report with a nonsense id reach the caller', async () => {
    const p = new RadioBrowserProvider({ mirrors: [api.base], timeoutMs: 300 });
    await expect(p.reportListening('')).resolves.toBeUndefined();
  });

  it('times out rather than hanging the receiver forever', async () => {
    const silent = await startJsonServer();
    silent.failures.set('*', 'hang');
    try {
      const p = new RadioBrowserProvider({ mirrors: [silent.base], timeoutMs: 300 });
      const started = Date.now();
      await expect(p.listGenres(1)).rejects.toBeInstanceOf(DirectoryError);
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      await silent.close();
    }
  });
});

describe('finding a mirror to talk to', () => {
  let api: JsonServer;
  beforeEach(async () => {
    api = await startJsonServer();
  });
  afterEach(async () => {
    await api.close();
  });

  it('discovers mirrors from the servers endpoint', async () => {
    const p = new RadioBrowserProvider({
      fetchImpl: (input, init) =>
        fetch(String(input).replace('https://all.api.radio-browser.info', api.base), init),
      random: () => 0,
    });
    const mirrors = await p.getMirrors();
    expect(mirrors).toContain('https://de1.api.radio-browser.info');
    expect(mirrors).toContain('https://at1.api.radio-browser.info');
  });

  it('lists each mirror once even though the endpoint repeats names per IP', async () => {
    const p = new RadioBrowserProvider({
      fetchImpl: (input, init) =>
        fetch(String(input).replace('https://all.api.radio-browser.info', api.base), init),
      random: () => 0,
    });
    const mirrors = await p.getMirrors();
    expect(new Set(mirrors).size).toBe(mirrors.length);
    expect(mirrors).toHaveLength(3);
  });

  it('spreads load by shuffling the list rather than always picking the first', async () => {
    const make = (r: number): RadioBrowserProvider =>
      new RadioBrowserProvider({
        fetchImpl: (input, init) =>
          fetch(String(input).replace('https://all.api.radio-browser.info', api.base), init),
        random: () => r,
      });
    const a = await make(0).getMirrors();
    const b = await make(0.999).getMirrors();
    expect(a).not.toEqual(b);
  });

  it('caches the mirror list instead of rediscovering on every call', async () => {
    const p = new RadioBrowserProvider({
      fetchImpl: (input, init) =>
        fetch(String(input).replace('https://all.api.radio-browser.info', api.base), init),
    });
    await p.getMirrors();
    await p.getMirrors();
    expect(api.requests.filter((r) => r.includes('/json/servers'))).toHaveLength(1);
  });

  it('falls back to a known mirror list when discovery itself is unreachable', async () => {
    const p = new RadioBrowserProvider({
      fetchImpl: () => Promise.reject(new Error('DNS is down')),
    });
    const mirrors = await p.getMirrors();
    expect(mirrors.length).toBeGreaterThan(0);
    expect(mirrors.every((m) => m.startsWith('https://'))).toBe(true);
  });

  it('does not call the servers endpoint at all when mirrors were pinned', async () => {
    const p = new RadioBrowserProvider({ mirrors: [api.base] });
    await p.listGenres(1);
    expect(api.requests.some((r) => r.includes('/json/servers'))).toBe(false);
  });

  it('strips a trailing slash so URLs never end up doubled', async () => {
    const p = new RadioBrowserProvider({ mirrors: [`${api.base}/`] });
    await p.listGenres(1);
    expect(api.requests.some((r) => r.includes('//json/tags'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Folded groups: one card in the register, N queries on the wire
// ---------------------------------------------------------------------------

describe('expanding a folded group back into the queries the directory understands', () => {
  let api: JsonServer;
  beforeEach(async () => {
    api = await startJsonServer();
  });
  afterEach(async () => {
    await api.close();
  });

  const provider = (): RadioBrowserProvider =>
    new RadioBrowserProvider({ mirrors: [api.base], timeoutMs: 1500, random: () => 0 });

  it('files three spellings as one subject term with the summed count', async () => {
    const index = await provider().listIndex();
    const tripHop = index.subjects.filter((s) => s.spellings.includes('triphop'));
    expect(tripHop).toHaveLength(1);
    expect(tripHop[0]!.name).toBe('trip-hop');
    expect(tripHop[0]!.stationCount).toBe(46);
    expect(tripHop[0]!.spellings).toEqual(['trip-hop', 'trip hop', 'triphop']);
  });

  it('issues one tag query per spelling, because tagList is an AND', async () => {
    const p = provider();
    await p.listIndex();
    const before = api.requests.filter((r) => r.includes('/json/stations/search')).length;
    await p.search({ genre: 'trip-hop', limit: 50 });
    const sent = api.requests
      .filter((r) => r.includes('/json/stations/search'))
      .slice(before)
      .map((r) => decodeURIComponent(new URL(r.split(' ')[1]!, api.base).searchParams.get('tag') ?? ''));
    expect(sent.sort()).toEqual(['trip hop', 'trip-hop', 'triphop']);
  });

  it('de-duplicates the union on station id rather than returning a row three times', async () => {
    // The fixture answers every tag with the same three stations, which is the
    // real shape of the problem: a station tagged `trip-hop` *and* `triphop`
    // comes back from two of the three queries.
    const p = provider();
    await p.listIndex();
    const found = await p.search({ genre: 'trip-hop', limit: 50 });
    expect(found).toHaveLength(3);
    expect(new Set(found.map((s) => s.id)).size).toBe(3);
  });

  it('still sends exactly one query for a genre with one spelling', async () => {
    const p = provider();
    await p.listIndex();
    const before = api.requests.filter((r) => r.includes('/json/stations/search')).length;
    await p.search({ genre: 'jazz', limit: 50 });
    expect(api.requests.filter((r) => r.includes('/json/stations/search')).length - before).toBe(1);
  });

  it('falls back to the single tag when the group index was never pulled', async () => {
    // A cold provider has no expansion table. One query for one tag is what it
    // did before folding existed: degraded, never broken.
    const found = await provider().search({ genre: 'trip-hop', limit: 50 });
    expect(found).toHaveLength(3);
    expect(api.requests.filter((r) => r.includes('/json/stations/search'))).toHaveLength(1);
  });

  it('says so when only some of a group answered, instead of returning a short list silently', async () => {
    // Law 4. Two spellings of three means the band is short by an unknown
    // amount, and a caller shown 32 of 46 with no note reads it as "46".
    const p = new RadioBrowserProvider({
      mirrors: [api.base],
      timeoutMs: 1500,
      random: () => 0,
      fetchImpl: async (input, init) => {
        const url = String(input);
        if (url.includes('tag=triphop')) throw new Error('mirror dropped the connection');
        return fetch(input, init);
      },
    });
    await p.listIndex();
    const notes: unknown[] = [];
    const found = await p.search({ genre: 'trip-hop', limit: 50 }, { onPartial: (n) => notes.push(n) });
    expect(found.length).toBeGreaterThan(0);
    expect(notes).toEqual([
      { genre: 'trip-hop', spellings: 3, fetched: 2, message: expect.any(String) },
    ]);
  });

  it('throws rather than returning nothing when every spelling failed', async () => {
    const p = provider();
    await p.listIndex();
    api.failures.set('/json/stations/search', 'error');
    await expect(p.search({ genre: 'trip-hop', limit: 50 })).rejects.toBeInstanceOf(DirectoryError);
  });
});

describe('a single page that repeats a station', () => {
  it('is de-duplicated on stationuuid like a merged one, so the drum never carries a station twice', async () => {
    const row = {
      stationuuid: 'dup-1',
      name: 'Twice',
      url: 'http://stream.example.invalid/twice',
      tags: 'jazz',
      countrycode: 'DE',
      votes: 1,
      clickcount: 1,
    };
    const p = new RadioBrowserProvider({
      mirrors: ['http://directory.invalid'],
      fetchImpl: async () =>
        new Response(JSON.stringify([row, { ...row }, { ...row, stationuuid: 'other' }]), {
          headers: { 'content-type': 'application/json' },
        }),
    });
    const rows = await p.search({ limit: 50 });
    expect(rows.map((r) => r.id)).toEqual(['dup-1', 'other']);
  });
});
