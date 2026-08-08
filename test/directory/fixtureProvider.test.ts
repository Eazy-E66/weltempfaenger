import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FixtureProvider } from '../../src/main/directory/fixtureProvider';
import { DirectoryError } from '../../src/main/directory/http';
import { layoutBand } from '../../src/main/tuning/bandLayout';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(HERE, '..', 'fixtures', 'directory');

function provider(): FixtureProvider {
  return new FixtureProvider({ dir: DIR });
}

describe('reading the offline directory', () => {
  it('loads the station set from disk', async () => {
    const stations = await provider().stations();
    expect(stations.length).toBeGreaterThan(10);
    expect(stations[0]).toMatchObject({ id: expect.any(String), name: expect.any(String) });
  });

  it('identifies itself so the UI can say where stations came from', () => {
    expect(provider().id).toBe('fixture');
  });

  it('fails with a directory error, not a raw filesystem error, when the file is missing', async () => {
    const missing = new FixtureProvider({ dir: path.join(DIR, 'nope') });
    await expect(missing.stations()).rejects.toBeInstanceOf(DirectoryError);
  });

  it('can be given stations directly, with no disk at all', async () => {
    const inline = new FixtureProvider({
      stations: [{ id: 'a', name: 'A', url: 'http://a/', tags: ['jazz'], popularity: 1 }],
    });
    expect(await inline.search({ limit: 10 })).toHaveLength(1);
  });
});

describe('genres from the offline directory', () => {
  it('counts genres from the stations that are actually present', async () => {
    const genres = await provider().listGenres(1);
    const jazz = genres.find((g) => g.name === 'jazz');
    expect(jazz?.stationCount).toBe(3);
  });

  it('filters out the junk tags exactly as the live provider does', async () => {
    const names = (await provider().listGenres(1)).map((g) => g.name);
    expect(names).not.toContain('128');
    expect(names).not.toContain('http://spam.example.invalid');
    expect(names).not.toContain('!!!!!!');
  });

  it('honours the minimum station count', async () => {
    const genres = await provider().listGenres(3);
    expect(genres.every((g) => g.stationCount >= 3)).toBe(true);
    expect(genres.length).toBeGreaterThan(0);
  });

  it('returns the biggest genres first', async () => {
    const counts = (await provider().listGenres(1)).map((g) => g.stationCount);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });

  it('gives the same answer every time', async () => {
    expect(await provider().listGenres(2)).toEqual(await provider().listGenres(2));
  });
});

describe('searching the offline directory', () => {
  it('filters by genre', async () => {
    const found = await provider().search({ genre: 'jazz', limit: 50 });
    expect(found.length).toBe(3);
    expect(found.every((s) => s.tags.includes('jazz'))).toBe(true);
  });

  it('filters by country code, case-insensitively', async () => {
    const found = await provider().search({ countryCode: 'de', limit: 50 });
    expect(found.length).toBe(2);
    expect(found.every((s) => s.countryCode === 'DE')).toBe(true);
  });

  it('filters by free text against the station name', async () => {
    const found = await provider().search({ text: 'nordic', limit: 50 });
    expect(found.map((s) => s.id)).toEqual(['fx-0015']);
  });

  it('combines filters', async () => {
    const found = await provider().search({ genre: 'jazz', countryCode: 'FR', limit: 50 });
    expect(found.map((s) => s.id)).toEqual(['fx-0014']);
  });

  it('returns the strongest stations first', async () => {
    const found = await provider().search({ limit: 50 });
    const popularities = found.map((s) => s.popularity);
    expect(popularities).toEqual([...popularities].sort((a, b) => b - a));
  });

  it('honours limit and offset', async () => {
    const all = await provider().search({ limit: 50 });
    const page = await provider().search({ limit: 3, offset: 2 });
    expect(page.map((s) => s.id)).toEqual(all.slice(2, 5).map((s) => s.id));
  });

  it('returns nothing rather than everything for a genre that does not exist', async () => {
    expect(await provider().search({ genre: 'no-such-genre', limit: 50 })).toEqual([]);
  });

  it('gives byte-identical results for identical queries', async () => {
    const a = await provider().search({ genre: 'ambient', limit: 10 });
    const b = await provider().search({ genre: 'ambient', limit: 10 });
    expect(a).toEqual(b);
  });

  it('hands back copies, so a caller cannot corrupt the directory', async () => {
    const p = provider();
    const first = await p.search({ limit: 1 });
    first[0]!.name = 'mutated';
    const second = await p.search({ limit: 1 });
    expect(second[0]!.name).not.toBe('mutated');
  });

  it('carries geo coordinates through for the world map', async () => {
    const found = await provider().search({ genre: 'jazz', limit: 10 });
    expect(found.every((s) => typeof s.geo?.lat === 'number')).toBe(true);
  });
});

describe('reporting a listen', () => {
  it('records the station and never throws', async () => {
    const p = provider();
    await expect(p.reportListening('fx-0001')).resolves.toBeUndefined();
    expect(p.reported).toEqual(['fx-0001']);
  });
});

describe('the offline directory drives a real band', () => {
  it('lays out a genre from the fixture directory end to end', async () => {
    const p = provider();
    const genres = await p.listGenres(2);
    expect(genres.length).toBeGreaterThan(0);
    const genre = genres[0]!.name;
    const found = await p.search({ genre, limit: 50 });
    const band = layoutBand(genre, found, { totalStations: genres[0]!.stationCount });
    expect(band.slots).toHaveLength(found.length);
    expect(band.genre).toBe(genre);
  });
});
