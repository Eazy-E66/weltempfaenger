/**
 * Display policy for station names.
 *
 * Every "before" string in this file is verbatim from the live Radio Browser
 * directory or a direct structural sibling of one.
 */

import { describe, expect, it } from 'vitest';
import { dialStationName, displayStationName, NAME_DISPLAY_LIMIT } from '../../src/renderer/ui/stationName';

describe('printing a station name on the dial', () => {
  it('leaves an ordinary name completely alone', () => {
    for (const name of [
      'SomaFM Groove Salad (128k MP3)',
      'SWR2',
      'NRJ Paris',
      'Radio Nova',
      'FIP',
      'Antenne Bayern - 80er Kulthits',
    ]) {
      expect(displayStationName(name)).toBe(name);
    }
  });

  it('strips the keyword payload after a double pipe', () => {
    expect(
      displayStationName(
        '0R - EURO DANCE || Eurodance, 90s Dance, Pop, Dance, Club, Party, Trance, House',
      ),
    ).toBe('0R - EURO DANCE');
    expect(displayStationName('0R - 80s ROCK || Classic Rock, Hard Rock, Metal, 80s')).toBe(
      '0R - 80s ROCK',
    );
  });

  it('strips a keyword payload after a single pipe only when it reads as a list', () => {
    expect(displayStationName('Radio Nova | pop, dance, hits, 90s, party')).toBe('Radio Nova');
    // A single pipe with a real subtitle behind it is part of the name.
    expect(displayStationName('SWR2 | 48k aac')).toBe('SWR2 | 48k aac');
    expect(displayStationName('Radio Nova | Paris')).toBe('Radio Nova | Paris');
  });

  it('strips a trailing comma run with no separator at all', () => {
    expect(displayStationName('Rock Antenne, rock, classic rock, hard rock, metal')).toBe(
      'Rock Antenne',
    );
    // Two commas is a subtitle, not a keyword dump.
    expect(displayStationName('Radio City, Liverpool')).toBe('Radio City, Liverpool');
  });

  it('collapses whitespace, including the kinds trim() misses', () => {
    expect(displayStationName('  Radio\t\tNova   FM  ')).toBe('Radio Nova FM');
    expect(displayStationName('Radio Nova​')).toBe('Radio Nova');
    expect(displayStationName('﻿Radio Nova')).toBe('Radio Nova');
  });

  it('truncates on a word boundary and marks the cut', () => {
    const long = 'The Very Long Community Broadcasting Service Of Somewhere Or Other';
    const shown = displayStationName(long);
    expect(shown.length).toBeLessThanOrEqual(NAME_DISPLAY_LIMIT);
    expect(shown.endsWith('…')).toBe(true);
    expect(long.startsWith(shown.slice(0, -1))).toBe(true);
    // Cut between words, not through one.
    expect(shown.slice(0, -1).trimEnd()).toBe(shown.slice(0, -1));
  });

  it('does not truncate a name that already fits', () => {
    const exact = 'x'.repeat(NAME_DISPLAY_LIMIT);
    expect(displayStationName(exact)).toBe(exact);
    expect(displayStationName('x'.repeat(NAME_DISPLAY_LIMIT + 1)).endsWith('…')).toBe(true);
  });

  it('honours an explicit limit, as the dial drum uses', () => {
    expect(displayStationName('Nordwelle Kaliningrad Kulturprogramm', 18)).toHaveLength(18);
  });

  it('never leaves dangling punctuation where the cut fell', () => {
    expect(displayStationName('Radio Nova -')).toBe('Radio Nova');
    expect(displayStationName('Radio Nova ·')).toBe('Radio Nova');
    expect(displayStationName('Radio Nova ||')).toBe('Radio Nova');
  });

  it('survives a name that is nothing but stuffing', () => {
    expect(displayStationName('|| pop, rock, dance')).toBe('|| pop, rock, dance');
    expect(displayStationName('   ')).toBe('');
    expect(displayStationName('')).toBe('');
  });

  it('keeps non-Latin names intact', () => {
    expect(displayStationName('Радио Рекорд')).toBe('Радио Рекорд');
    expect(displayStationName('ラジオ日本')).toBe('ラジオ日本');
    expect(displayStationName('Rádio Comercial')).toBe('Rádio Comercial');
  });
});

/* ---------------------------------------------------------------------------
   The second, stricter pass: what may be SET IN INK on a drum, at 7-10 px,
   beside a frequency scale. `displayStationName` has already settled the data
   question by the time any of this runs.
   ------------------------------------------------------------------------- */

describe('setting a station name as dial print', () => {
  const dial = (raw: string, limit = 14) => dialStationName(displayStationName(raw), limit);

  it('sets the names a printed dial actually carries', () => {
    // HILVERSUM, DROITWICH, BEROMÜNSTER: caps, no punctuation, no annotation.
    expect(dial('Radio Nederland Wereldomroep')).toBe('NEDERLAND');
    expect(dial('Radio Classique')).toBe('CLASSIQUE');
  });

  it('drops what a printer would not set', () => {
    expect(dial('BBC Radio 3 (128k)')).toBe('BBC RADIO 3');
    expect(dial('NDR Kultur 320kbps')).toBe('NDR KULTUR');
    expect(dial('Radio Swiss Jazz [HD]')).toBe('SWISS JAZZ');
  });

  it('drops a trailing band suffix, which a dial has no room to repeat', () => {
    // A printed dial sets the call sign. "FM" on a shortwave drum is noise, and
    // the readout still carries the operator's full name either way.
    expect(dial('Jazz FM')).toBe('JAZZ');
    expect(dial('Nova Radio')).toBe('NOVA');
  });

  it('drops the generic prefix, because the whole dial is radio stations', () => {
    expect(dial('Radio Caprice - Contemporary Classical')).toBe('CAPRICE');
    // ...but not when doing so would leave nothing worth printing.
    expect(dial('Radio 1')).toBe('RADIO 1');
  });

  it('shortens to whole words and never sets an ellipsis', () => {
    const out = dial('Venice Classic Radio Italia', 14);
    expect(out).toBe('VENICE CLASSIC');
    expect(out).not.toContain('…');
    expect(out).not.toContain('...');
  });

  it('tolerates three characters rather than dropping a word to save two', () => {
    // 16 characters against a 14 budget: a printer tightens and sets the line.
    expect(dial('0R - EURO DANCE', 14)).toBe('0R - EURO DANCE');
  });

  it('prints NOTHING rather than a smear when a single word will not fit', () => {
    expect(dial('Concertzender Klassiek', 11)).toBe('');
    expect(dial('Beromuenstersender', 11)).toBe('');
  });

  it('gives the blip the space back when there is no name at all', () => {
    expect(dial('')).toBe('');
    expect(dial('   ')).toBe('');
    expect(dial('||')).toBe('');
  });

  it('never writes back — identity is untouched', () => {
    const raw = 'Radio Classique';
    dial(raw);
    expect(raw).toBe('Radio Classique');
    expect(displayStationName(raw)).toBe('Radio Classique');
  });
});
