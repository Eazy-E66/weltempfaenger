/**
 * Folding spellings.
 *
 * The client's complaint, in one sentence: `trip hop` is unreachable. The live
 * directory holds it as three separate tags — `trip-hop` 24, `trip hop` 14,
 * `triphop` 8 — so at any sensible floor all three are invisible and the genre
 * with 46 stations behind it cannot be tuned at all.
 *
 * Every number in this file was measured against the live directory on
 * 2026-08-07 (`/json/tags?limit=100000`), not invented.
 */

import { describe, expect, it } from 'vitest';
import { cleanTags, groupKey, groupTags } from '../../src/main/directory/tags';

describe('the grouping key', () => {
  it('ignores every way a genre can be punctuated', () => {
    expect(groupKey('trip-hop')).toBe('triphop');
    expect(groupKey('trip hop')).toBe('triphop');
    expect(groupKey('triphop')).toBe('triphop');
    expect(groupKey('TRIP  HOP')).toBe('triphop');
  });

  it('folds diacritics, so an accent is not a second genre', () => {
    expect(groupKey('música pop')).toBe(groupKey('musica pop'));
    expect(groupKey("80´s")).toBe(groupKey('80s'));
  });

  it('strips emoji, which is de-noising as a consequence of de-duplicating', () => {
    expect(groupKey('news🇺🇸🇺🇸')).toBe('news');
    expect(groupKey('★ rock ★')).toBe('rock');
  });

  it('keeps non-Latin scripts rather than flattening them to nothing', () => {
    // An ASCII-only key would collide every Cyrillic tag in the directory into
    // one enormous group keyed on the empty string.
    expect(groupKey('музыка')).toBe('музыка');
    expect(groupKey('演歌')).toBe('演歌');
    expect(groupKey('музыка')).not.toBe(groupKey('演歌'));
  });

  it('does not fold two genuinely different genres together', () => {
    expect(groupKey('hard rock')).not.toBe(groupKey('hardstyle'));
    expect(groupKey('deep house')).not.toBe(groupKey('house'));
  });
});

describe('folding the directory tag list', () => {
  /** The live directory's three spellings, with their real counts. */
  const tripHop = [
    { name: 'trip-hop', count: 24 },
    { name: 'trip hop', count: 14 },
    { name: 'triphop', count: 8 },
  ];

  it("makes the client's own example reachable at all", () => {
    const groups = groupTags(tripHop);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.stationCount).toBe(46);
  });

  it('prints the highest-count spelling and keeps the rest', () => {
    const [group] = groupTags(tripHop);
    expect(group!.name).toBe('trip-hop');
    expect(group!.spellings).toEqual(['trip-hop', 'trip hop', 'triphop']);
  });

  it('always names the group with its own first spelling', () => {
    for (const group of groupTags([...tripHop, { name: 'jazz', count: 1402 }])) {
      expect(group.spellings[0]).toBe(group.name);
    }
  });

  it('folds the other measured groups the directory really has', () => {
    const measured = groupTags([
      { name: 'hiphop', count: 285 },
      { name: 'hip-hop', count: 223 },
      { name: 'hip hop', count: 174 },
      { name: '80s', count: 1215 },
      { name: "80's", count: 293 },
      { name: '#80s', count: 12 },
      { name: '80-s', count: 1 },
      { name: '80´s', count: 1 },
    ]);
    const by = (name: string) => measured.find((g) => g.name === name);
    expect(by('hiphop')?.stationCount).toBe(682);
    expect(by('hiphop')?.spellings).toHaveLength(3);
    expect(by('80s')?.stationCount).toBe(1522);
    expect(by('80s')?.spellings).toHaveLength(5);
  });

  it('folds an emoji-tailed tag into the plain one instead of listing both', () => {
    const groups = groupTags([
      { name: 'news', count: 2800 },
      { name: 'news🇺🇸🇺🇸', count: 3 },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.name).toBe('news');
    expect(groups[0]!.stationCount).toBe(2803);
  });

  it('still applies the documented hygiene before folding', () => {
    // The junk filter is not bypassed by the fold: `radio` and `norteamérica`
    // are removed, and no group is invented for them.
    const names = groupTags([
      { name: 'radio', count: 2267 },
      { name: 'r a d i o', count: 4 },
      { name: 'norteamérica', count: 1904 },
      { name: 'jazz', count: 1402 },
    ]).map((g) => g.name);
    expect(names).not.toContain('radio');
    expect(names).not.toContain('norteamérica');
    expect(names).toContain('jazz');
  });

  it('sorts by folded total, so a fold can overtake a single spelling', () => {
    const groups = groupTags([
      { name: 'gospel', count: 40 },
      { name: 'trip-hop', count: 24 },
      { name: 'trip hop', count: 14 },
      { name: 'triphop', count: 8 },
    ]);
    expect(groups.map((g) => g.name)).toEqual(['trip-hop', 'gospel']);
  });

  it('applies the floor to the folded total, which is the whole point', () => {
    // Not one of the three spellings clears 40 on its own. Together they do.
    expect(cleanTags(tripHop, 40).map((g) => g.name)).toEqual(['trip-hop']);
    expect(cleanTags(tripHop, 47)).toEqual([]);
  });

  it('gives a single-spelling genre a spellings list of exactly itself', () => {
    const [fado] = cleanTags([{ name: 'fado', count: 9 }], 1);
    expect(fado).toEqual({ name: 'fado', stationCount: 9, spellings: ['fado'] });
  });

  it('is deterministic across calls', () => {
    expect(groupTags(tripHop)).toEqual(groupTags(tripHop));
  });
});
