/**
 * ICY metadata, against blocks captured off real mounts.
 *
 * The now-playing line is the single most prominent text on the panel, and on a
 * large slice of the US directory what arrives in `StreamTitle` is a scheduling
 * record rather than a song. Printed verbatim that is `amgArtistId`, `TAID`,
 * `TPID`, `cartcutId` across the widest text on the faceplate — reproduced
 * independently by two critics on the default first station.
 *
 * The fixtures in test/fixtures/icy are the real shapes; nothing here is
 * invented to make the parser look good.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  IcyDemuxer,
  encodeIcyStream,
  parseStreamTitle,
  parseTitleValue,
} from '../../src/main/proxy/icy';

interface Case {
  name: string;
  block: string;
  expect: { title: string; artist?: string; track?: string } | null;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(path.join(here, '..', 'fixtures', 'icy', 'stream-titles.json'), 'utf8'),
) as { cases: Case[] };

/** Everything a station's own database leaks into the field, and never should. */
const DATABASE_JUNK =
  /amgArtistId|amgTrackId|TAID|TPID|cartcutId|song_spot|MediaBaseId|itunesTrackId|spotInstanceId|amgArtworkURL/i;

describe('captured StreamTitle shapes', () => {
  for (const testCase of fixture.cases) {
    it(`parses: ${testCase.name}`, () => {
      const parsed = parseStreamTitle(testCase.block);
      if (testCase.expect === null) {
        expect(parsed).toBeNull();
        return;
      }
      expect(parsed).not.toBeNull();
      expect(parsed!.title).toBe(testCase.expect.title);
      expect(parsed!.artist).toBe(testCase.expect.artist);
      expect(parsed!.track).toBe(testCase.expect.track);
    });
  }

  it('never lets a database record reach the display line', () => {
    for (const testCase of fixture.cases) {
      const parsed = parseStreamTitle(testCase.block);
      if (!parsed) continue;
      expect(parsed.title).not.toMatch(DATABASE_JUNK);
      expect(parsed.artist ?? '').not.toMatch(DATABASE_JUNK);
      expect(parsed.track ?? '').not.toMatch(DATABASE_JUNK);
    }
  });

  it('produces at least one field for every block that carries programme text', () => {
    const carrying = fixture.cases.filter((c) => c.expect !== null);
    expect(carrying.length).toBeGreaterThan(6);
    for (const testCase of carrying) {
      expect(parseStreamTitle(testCase.block)!.title.length).toBeGreaterThan(0);
    }
  });
});

describe('the keyed form', () => {
  it('prefers an explicit artist field over guessing from a dash', () => {
    const parsed = parseTitleValue('title="A - B",artist="Nine Inch Nails"');
    expect(parsed).toEqual({ title: 'Nine Inch Nails - A - B', artist: 'Nine Inch Nails', track: 'A - B' });
  });

  it('reads fields in either order', () => {
    const a = parseTitleValue('artist="Portishead",title="Roads"');
    const b = parseTitleValue('title="Roads",artist="Portishead"');
    expect(a).toEqual(b);
    expect(a!.title).toBe('Portishead - Roads');
  });

  it('ignores an empty title field rather than reporting a blank line', () => {
    expect(parseTitleValue('title="",artist="",song_spot="F"')).toBeNull();
  });

  it('is case-insensitive about the key names', () => {
    expect(parseTitleValue('Title="Teardrop",Artist="Massive Attack"')!.title).toBe(
      'Massive Attack - Teardrop',
    );
  });
});

describe('the plain form, which must keep working exactly as before', () => {
  it('splits on the first " - "', () => {
    expect(parseTitleValue('Boards of Canada - Roygbiv')).toEqual({
      title: 'Boards of Canada - Roygbiv',
      artist: 'Boards of Canada',
      track: 'Roygbiv',
    });
  });

  it('leaves a title with no separator whole', () => {
    expect(parseTitleValue('Top of the Hour News')).toEqual({ title: 'Top of the Hour News' });
  });

  it('does not split on a hyphen without spaces', () => {
    expect(parseTitleValue('Jean-Michel Jarre')).toEqual({ title: 'Jean-Michel Jarre' });
  });

  it('keeps quotes that belong to the title', () => {
    expect(parseTitleValue('Prince - Nothing Compares 2 "U"')!.title).toBe(
      'Prince - Nothing Compares 2 "U"',
    );
  });

  it('strips a trailing record but not a leading one', () => {
    expect(parseTitleValue('Yes - Roundabout length="00:08:29"')!.title).toBe('Yes - Roundabout');
  });
});

describe('StreamTitle extraction from the block', () => {
  it('terminates on the field separator, not on the first apostrophe', () => {
    const parsed = parseStreamTitle("StreamTitle='Rockin' Chair';StreamUrl='';");
    expect(parsed!.title).toBe("Rockin' Chair");
  });

  it('survives a block whose last field omits the trailing semicolon', () => {
    expect(parseStreamTitle("StreamTitle='Kraftwerk - Autobahn'")!.title).toBe(
      'Kraftwerk - Autobahn',
    );
  });

  it('returns null when there is no StreamTitle at all', () => {
    expect(parseStreamTitle("StreamUrl='http://x.invalid';")).toBeNull();
  });
});

describe('through the demuxer, as it actually arrives', () => {
  it('recovers a clean now-playing line from a real interleaved body', () => {
    const audio = Buffer.alloc(8192, 0x55);
    const block =
      'StreamTitle=\'title="Sober",artist="Tool",url="song_spot="M" MediaBaseId="0" TAID="0"\';';
    const body = encodeIcyStream(audio, 4096, (i) => (i === 0 ? block : null));

    const demuxer = new IcyDemuxer(4096);
    const out = demuxer.push(body);
    const titles = out.blocks.map((b) => parseStreamTitle(b)).filter((t) => t !== null);

    expect(titles).toHaveLength(1);
    expect(titles[0]!.title).toBe('Tool - Sober');
    expect(titles[0]!.title).not.toMatch(DATABASE_JUNK);
    // The undecorated block still exists — it is moved to diagnostics, not lost.
    expect(out.blocks[0]).toMatch(DATABASE_JUNK);
  });
});
