import { describe, expect, it } from 'vitest';
import { cleanTags, foldForMatch, normaliseTag } from '../../src/main/directory/tags';

describe('deciding whether a tag can be a band', () => {
  it('keeps ordinary genre names', () => {
    for (const tag of ['jazz', 'classical', 'drum and bass', '80s', 'k-pop', 'hip hop']) {
      expect(normaliseTag(tag)).toBe(tag);
    }
  });

  it('lowercases and trims', () => {
    expect(normaliseTag('  JAZZ  ')).toBe('jazz');
  });

  it('collapses runs of whitespace', () => {
    expect(normaliseTag('drum   and\tbass')).toBe('drum and bass');
  });

  it('rejects a tag that is only digits', () => {
    expect(normaliseTag('128')).toBeNull();
    expect(normaliseTag('2024')).toBeNull();
  });

  it('rejects a single character', () => {
    expect(normaliseTag('a')).toBeNull();
  });

  it('rejects an absurdly long tag', () => {
    expect(normaliseTag('the best radio station in the whole wide world')).toBeNull();
  });

  it('rejects a sentence even when it is short enough', () => {
    expect(normaliseTag('chill out and relax')).toBeNull();
  });

  it('rejects anything containing a URL or an address', () => {
    for (const tag of ['http://spam.invalid', 'www.spam.invalid', 'spam@example.invalid', 'radio.com']) {
      expect(normaliseTag(tag)).toBeNull();
    }
  });

  it('rejects punctuation-only tags', () => {
    for (const tag of ['-', '...', '***']) {
      expect(normaliseTag(tag)).toBeNull();
    }
  });

  it('rejects mashed-keyboard repetition', () => {
    expect(normaliseTag('aaaaaaaa')).toBeNull();
    expect(normaliseTag('!!!!!!!!')).toBeNull();
  });

  it('rejects control characters', () => {
    expect(normaliseTag('jazz\u0007')).toBeNull();
    expect(normaliseTag('ja\u0000zz')).toBeNull();
  });

  it('rejects tags that say nothing, like "radio" or "music"', () => {
    for (const tag of ['radio', 'music', 'various', 'undefined', 'live', 'stream']) {
      expect(normaliseTag(tag)).toBeNull();
    }
  });

  it('rejects protocol and codec words that leaked out of a config field', () => {
    // "https" is not hypothetical: the live directory has 50+ stations tagged
    // with it, and it passes every structural check because it is a real word.
    for (const tag of ['https', 'http', 'mp3', 'aac', 'shoutcast', 'icecast', 'bitrate']) {
      expect(normaliseTag(tag)).toBeNull();
    }
  });

  it('still keeps genres that merely contain a blocked word', () => {
    expect(normaliseTag('live jazz')).toBe('live jazz');
    expect(normaliseTag('pop music')).toBe('pop music');
  });

  it('rejects an empty string', () => {
    expect(normaliseTag('')).toBeNull();
    expect(normaliseTag('   ')).toBeNull();
  });
});

describe('building the band list from raw directory tags', () => {
  const raw = [
    { name: 'jazz', count: 1402 },
    { name: 'Jazz', count: 61 },
    { name: ' JAZZ ', count: 12 },
    { name: 'ambient', count: 311 },
    { name: 'trance', count: 6 },
    { name: '128', count: 640 },
    { name: 'radio', count: 2267 },
    { name: 'http://spam.invalid', count: 47 },
  ];

  it('merges tags that differ only in casing or whitespace', () => {
    const genres = cleanTags(raw, 1);
    const jazz = genres.filter((g) => g.name === 'jazz');
    expect(jazz).toHaveLength(1);
    expect(jazz[0]!.stationCount).toBe(1402 + 61 + 12);
  });

  it('drops the junk', () => {
    const names = cleanTags(raw, 1).map((g) => g.name);
    expect(names).not.toContain('128');
    expect(names).not.toContain('radio');
    expect(names).not.toContain('http://spam.invalid');
  });

  it('honours the minimum station count', () => {
    expect(cleanTags(raw, 100).map((g) => g.name)).toEqual(['jazz', 'ambient']);
  });

  it('sorts by station count, biggest band first', () => {
    const counts = cleanTags(raw, 1).map((g) => g.stationCount);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });

  it('breaks ties by name so the list never reshuffles', () => {
    const tied = cleanTags(
      [
        { name: 'zydeco', count: 10 },
        { name: 'ambient', count: 10 },
        { name: 'mambo', count: 10 },
      ],
      1,
    );
    expect(tied.map((g) => g.name)).toEqual(['ambient', 'mambo', 'zydeco']);
  });

  it('drops tags claiming zero stations', () => {
    expect(cleanTags([{ name: 'jazz', count: 0 }], 1)).toEqual([]);
  });

  it('treats a minimum of zero as a minimum of one', () => {
    // `spellings` is the additive field folding introduced. A genre the
    // directory holds under one spelling still carries a list, of itself, so
    // callers never have to special-case its absence.
    expect(cleanTags([{ name: 'jazz', count: 1 }], 0)).toEqual([
      { name: 'jazz', stationCount: 1, spellings: ['jazz'] },
    ]);
  });

  it('returns nothing for an empty directory rather than inventing genres', () => {
    expect(cleanTags([], 1)).toEqual([]);
  });
});

describe('tags that are not genres at all', () => {
  it('rejects generic words in whatever language they were typed', () => {
    // The English members of this family were already blocked. Leaving the
    // Spanish ones in while filtering the English ones is not neutrality.
    for (const tag of [
      'entretenimiento',
      'entertainment',
      'estación',
      'estacion',
      'emisora',
      'música',
      'musik',
      'musique',
      'sender',
      'radyo',
      'en vivo',
      'programas en vivo',
    ]) {
      expect(normaliseTag(tag)).toBeNull();
    }
  });

  it('rejects continents and supra-national regions', () => {
    for (const tag of [
      'norteamérica',
      'américa',
      'latinoamérica',
      'latin america',
      'north america',
      'europa',
      'asia',
      'africa',
      'caribe',
      'sureste',
    ]) {
      expect(normaliseTag(tag)).toBeNull();
    }
  });

  it('rejects broadcaster, network and contributor names', () => {
    // 'moi merino' is one contributor's name applied across 1798 stations in
    // the live directory. It is a well-formed two-word phrase and passes every
    // structural check, so only evidence can catch it.
    for (const tag of ['moi merino', 'radiorama', 'grupo acir', 'iheart radio', 'npr', 'exa fm']) {
      expect(normaliseTag(tag)).toBeNull();
    }
  });

  it('rejects a country the directory itself names, via the supplied vocabulary', () => {
    const vocab = { places: new Set(['mexico', 'germany', 'veracruz']) };
    expect(normaliseTag('méxico', vocab)).toBeNull();
    expect(normaliseTag('Mexico', vocab)).toBeNull();
    expect(normaliseTag('veracruz', vocab)).toBeNull();
    // Without the vocabulary the same tag survives: the policy is the
    // directory's own geography, not a hardcoded atlas.
    expect(normaliseTag('veracruz')).toBe('veracruz');
  });

  it('does not discriminate against non-English genre names', () => {
    for (const tag of [
      'música en español',
      'música pop',
      'música mexicana',
      'música regional',
      'noticias',
      'schlager',
      'grupera',
      'norteño',
      'banda',
      'cumbia',
      'reggaeton',
      'clásicos',
      'balada romántica',
      'поп-музыка',
    ]) {
      expect(normaliseTag(tag)).toBe(tag);
    }
  });

  it('keeps genres that merely contain a blocked place or word', () => {
    // Exact-match discipline is what makes the place filter safe.
    expect(normaliseTag('latin')).toBe('latin');
    expect(normaliseTag('latino')).toBe('latino');
    expect(normaliseTag('latin pop')).toBe('latin pop');
    expect(normaliseTag('african')).toBe('african');
    expect(normaliseTag('mexican music', { places: new Set(['mexico']) })).toBe('mexican music');
    expect(normaliseTag('regional mexicana', { places: new Set(['mexico']) })).toBe(
      'regional mexicana',
    );
  });

  it('folds diacritics for matching but never for display', () => {
    expect(foldForMatch('MÉXICO')).toBe('mexico');
    expect(foldForMatch('  Música   Pop ')).toBe('musica pop');
    // The surviving tag keeps its own accents.
    expect(normaliseTag('Música Pop')).toBe('música pop');
  });

  it('cleans a real slice of the live tag list', () => {
    // Counts and spellings are verbatim from api.radio-browser.info.
    const live = [
      { name: 'pop', count: 5936 },
      { name: 'music', count: 5009 },
      { name: 'rock', count: 3088 },
      { name: 'news', count: 2857 },
      { name: 'radio', count: 2267 },
      { name: 'entretenimiento', count: 2156 },
      { name: 'estación', count: 2136 },
      { name: 'méxico', count: 1988 },
      { name: 'norteamérica', count: 1904 },
      { name: 'fm', count: 1808 },
      { name: 'moi merino', count: 1798 },
      { name: 'música', count: 1719 },
      { name: 'latinoamérica', count: 1717 },
      { name: 'classical', count: 1587 },
      { name: 'américa', count: 1464 },
      { name: 'música en español', count: 1029 },
    ];
    const names = cleanTags(live, 50, { places: new Set(['mexico']) }).map((g) => g.name);
    expect(names).toEqual([
      'pop',
      'rock',
      'news',
      'classical',
      'música en español',
    ]);
  });
});
