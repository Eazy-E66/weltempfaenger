import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { parseM3u, parsePlaylist, parsePls } from '../../src/main/resolver/playlist';
import { fixturePath } from '../helpers/fixtureServer';

const BASE = 'http://radio.test';

async function fixture(name: string): Promise<string> {
  const raw = await readFile(fixturePath('playlists', name), 'utf8');
  return raw.split('{{BASE}}').join(BASE);
}

describe('PLS parsing', () => {
  it('reads the single entry out of a minimal playlist', async () => {
    const entries = parsePls(await fixture('valid.pls'));
    expect(entries).toEqual([{ url: `${BASE}/audio/mp3`, title: 'Groove Salad (fixture)' }]);
  });

  it('orders entries by their index rather than the order the lines appear', async () => {
    const entries = parsePls(await fixture('multi.pls'));
    expect(entries.map((e) => e.url)).toEqual([
      `${BASE}/audio/mp3`,
      `${BASE}/audio/aac`,
      `${BASE}/audio/ogg`,
    ]);
  });

  it('accepts keys in any casing', async () => {
    const entries = parsePls(await fixture('multi.pls'));
    expect(entries[0]?.title).toBe('Primary MP3 mount');
  });

  it('returns nothing for a playlist that declares zero entries', async () => {
    expect(parsePls(await fixture('empty.pls'))).toEqual([]);
  });

  it('trusts the File lines over a wrong NumberOfEntries', () => {
    const entries = parsePls(
      ['[playlist]', 'NumberOfEntries=1', 'File1=http://a/1', 'File2=http://a/2'].join('\n'),
    );
    expect(entries.map((e) => e.url)).toEqual(['http://a/1', 'http://a/2']);
  });

  it('ignores comments, blank lines and a leading byte order mark', () => {
    const entries = parsePls('﻿[playlist]\n\n; a comment\nFile1=http://a/1\n');
    expect(entries.map((e) => e.url)).toEqual(['http://a/1']);
  });

  it('skips entries whose value is empty', () => {
    expect(parsePls('[playlist]\nFile1=\nFile2=http://a/2\n').map((e) => e.url)).toEqual([
      'http://a/2',
    ]);
  });
});

describe('M3U parsing', () => {
  it('keeps entry order and attaches EXTINF titles to the URL that follows', async () => {
    const entries = parseM3u(await fixture('extended.m3u'));
    expect(entries).toEqual([
      { url: `${BASE}/audio/mp3`, title: 'Fixture FM - Primary' },
      { url: `${BASE}/audio/ogg`, title: 'Fixture FM - Ogg backup' },
    ]);
  });

  it('reads a bare list of URLs with no directives at all', async () => {
    const entries = parseM3u(await fixture('plain.m3u'));
    expect(entries.map((e) => e.url)).toEqual([`${BASE}/audio/mp3`, `${BASE}/audio/aac`]);
  });

  it('returns nothing when every line is a comment', async () => {
    expect(parseM3u(await fixture('empty.m3u'))).toEqual([]);
  });

  it('does not carry a title across to a later entry', () => {
    const entries = parseM3u('#EXTM3U\n#EXTINF:-1,Only the first\nhttp://a/1\nhttp://a/2\n');
    expect(entries[0]?.title).toBe('Only the first');
    expect(entries[1]?.title).toBeUndefined();
  });

  it('tolerates CRLF line endings', () => {
    const entries = parseM3u('#EXTM3U\r\n#EXTINF:-1,Title\r\nhttp://a/1\r\n');
    expect(entries).toEqual([{ url: 'http://a/1', title: 'Title' }]);
  });
});

describe('resolving playlist entries against the playlist URL', () => {
  it('turns relative entries into absolute URLs', async () => {
    const raw = await readFile(fixturePath('playlists', 'relative.m3u'), 'utf8');
    const entries = parsePlaylist('m3u', raw, 'http://radio.test/pl/relative.m3u');
    expect(entries.map((e) => e.url)).toEqual(['http://radio.test/audio/mp3']);
  });

  it('drops duplicate entries so the same stream is not probed twice', () => {
    const entries = parsePlaylist('m3u', 'http://a/1\nhttp://a/1\nhttp://a/2\n', 'http://a/');
    expect(entries.map((e) => e.url)).toEqual(['http://a/1', 'http://a/2']);
  });

  it('drops entries that are not URLs at all', () => {
    const entries = parsePlaylist(
      'pls',
      '[playlist]\nFile1=http://[\nFile2=http://a b\nFile3=http://a/3\n',
      'http://a/',
    );
    expect(entries.map((e) => e.url)).toEqual(['http://a/3']);
  });

  it('preserves non-http schemes so the resolver can report them honestly', () => {
    const entries = parsePlaylist('pls', '[playlist]\nFile1=mms://a/1\n', 'http://a/');
    expect(entries.map((e) => e.url)).toEqual(['mms://a/1']);
  });
});
