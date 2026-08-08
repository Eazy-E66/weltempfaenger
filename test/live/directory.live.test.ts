/**
 * LIVE — hits the real Radio Browser API. Not part of `npm test`.
 * See test/live/README.md.
 */

import { describe, expect, it } from 'vitest';
import { RadioBrowserProvider } from '../../src/main/directory/radioBrowser';

const KNOWN_MIRROR = 'https://de1.api.radio-browser.info';

describe('LIVE: Radio Browser mirror discovery', () => {
  it('discovers at least one usable mirror from the real servers endpoint', async () => {
    const mirrors = await new RadioBrowserProvider({ timeoutMs: 15_000 }).getMirrors();
    expect(mirrors.length).toBeGreaterThan(0);
    for (const mirror of mirrors) expect(mirror).toMatch(/^https:\/\/[a-z0-9.-]+$/);
  });
});

describe('LIVE: genres from the real directory', () => {
  const provider = new RadioBrowserProvider({ mirrors: [KNOWN_MIRROR], timeoutMs: 20_000 });

  it('returns a large list of real genres with real counts', async () => {
    const genres = await provider.listGenres(50);
    expect(genres.length).toBeGreaterThan(50);
    expect(genres.every((g) => g.stationCount >= 50)).toBe(true);
  });

  it('includes genres a listener would actually look for', async () => {
    const names = (await provider.listGenres(50)).map((g) => g.name);
    for (const expected of ['jazz', 'classical', 'rock', 'pop']) {
      expect(names).toContain(expected);
    }
  });

  it('has already removed the junk the live directory is full of', async () => {
    const names = (await provider.listGenres(50)).map((g) => g.name);
    expect(names.some((n) => /^\d+$/.test(n))).toBe(false);
    expect(names.some((n) => n.includes('http'))).toBe(false);
    expect(names.some((n) => n.length > 28)).toBe(false);
    expect(names).not.toContain('radio');
  });

  it('returns the biggest genres first', async () => {
    const counts = (await provider.listGenres(50)).map((g) => g.stationCount);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });
});

describe('LIVE: searching the real directory', () => {
  const provider = new RadioBrowserProvider({ mirrors: [KNOWN_MIRROR], timeoutMs: 20_000 });

  it('returns real jazz stations with playable-looking URLs', async () => {
    const found = await provider.search({ genre: 'jazz', limit: 20 });
    expect(found.length).toBeGreaterThan(5);
    for (const station of found) {
      expect(station.id).toMatch(/^[0-9a-f-]{36}$/i);
      expect(station.url).toMatch(/^https?:\/\//);
      expect(station.popularity).toBeGreaterThanOrEqual(0);
      expect(station.popularity).toBeLessThanOrEqual(1);
    }
  });

  it('normalises popularity across whatever the search returned', async () => {
    const found = await provider.search({ genre: 'jazz', limit: 20 });
    expect(Math.max(...found.map((s) => s.popularity))).toBeCloseTo(1, 6);
    expect(Math.min(...found.map((s) => s.popularity))).toBeCloseTo(0, 6);
  });

  it('honours a country filter', async () => {
    const found = await provider.search({ countryCode: 'DE', limit: 20 });
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((s) => s.countryCode === 'DE')).toBe(true);
  });

  it('honours a free-text search', async () => {
    const found = await provider.search({ text: 'soma', limit: 20 });
    expect(found.length).toBeGreaterThan(0);
    expect(found.some((s) => s.name.toLowerCase().includes('soma'))).toBe(true);
  });

  it('returns coordinates for enough stations to draw a world map', async () => {
    const found = await provider.search({ genre: 'jazz', limit: 50 });
    const located = found.filter((s) => s.geo);
    expect(located.length).toBeGreaterThan(0);
    for (const station of located) {
      expect(Math.abs(station.geo!.lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(station.geo!.lon)).toBeLessThanOrEqual(180);
    }
  });

  it('pages with offset', async () => {
    const first = await provider.search({ genre: 'jazz', limit: 5 });
    const second = await provider.search({ genre: 'jazz', limit: 5, offset: 5 });
    expect(second.map((s) => s.id)).not.toEqual(first.map((s) => s.id));
  });
});
