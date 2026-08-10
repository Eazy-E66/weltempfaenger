// @vitest-environment jsdom
/**
 * THE CELL THAT LIGHTS ON THE PRINTED PLATE.
 *
 * The strip across the top of the plate reads `-11 … GMT … +12`, and until now
 * the cell picked out was picked out by a literal: `tz.offset === 0` in
 * `printStrip`. It said the same thing about a station in Reykjavík and a
 * station in Auckland, because it was not about the station at all.
 *
 * What is under test here is the whole of what changed, and just as much what
 * did NOT:
 *
 *   · GMT is still printed, still cyan, still exactly where the case was
 *     printed with it. `printStrip` is not restructured.
 *   · The lamp is amber and it is behind ONE cell — two, and dimmer, for a
 *     zone that falls between two printed cells.
 *   · Nothing known means the strip goes DARK. Not parked on GMT. A cell lit on
 *     the meridian because nothing is known is the silent fallback that looks
 *     like a fact, and Law 4 calls that a defect.
 *   · `setPlayback` arrives about ten times a second and must not write ten
 *     times a second.
 *
 * Every offset here is asserted against a FIXED system time, so a run in July
 * cannot pass a January expectation — and Spain reading +1 rather than GMT is
 * the whole point of the machinery behind it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  INITIAL_PLAYBACK_STATE,
  type GenreTag,
  type PlaybackState,
  type RegisterIndex,
  type StationRef,
} from '../../src/shared/contracts';
import { createLid, type LidHandle } from '../../src/renderer/ui/components/lid';

class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', FakeResizeObserver);
vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => setTimeout(() => fn(0), 0) as unknown as number);
vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = function noop(): void {};

function tag(name: string, stationCount: number, spellings = [name]): GenreTag {
  return { name, stationCount, spellings };
}

function station(over: Partial<StationRef> & { id: string }): StationRef {
  return {
    name: over.id,
    url: `http://example.invalid/${over.id}`,
    tags: [],
    popularity: 0.5,
    clickCount: 1,
    ...over,
  };
}

const index: RegisterIndex = {
  source: 'fixture',
  pulledAt: 1,
  totals: { stations: 12000, tags: 2477, countries: 241, languages: 600 },
  subjects: [tag('pop', 5629)],
  origins: [
    { code: 'ES', name: 'Spain', stationCount: 900 },
    { code: 'FR', name: 'France', stationCount: 771 },
    { code: 'US', name: 'United States', stationCount: 5000 },
    { code: 'IN', name: 'India', stationCount: 400 },
  ],
  tongues: [{ name: 'spanish', stationCount: 700 }],
};

function playing(subject?: StationRef): PlaybackState {
  return { ...INITIAL_PLAYBACK_STATE, phase: 'playing', station: subject };
}

let lid: LidHandle | null = null;

function mount(): LidHandle {
  const made = createLid({
    onToggle: () => {},
    onSelect: () => {},
    onScope: () => {},
    onCut: () => {},
    onReprint: () => {},
  });
  document.body.append(made.lip, made.root);
  made.setIndex(index, null);
  lid = made;
  return made;
}

/** The printed plate itself — the subtree that must not change when nothing is known. */
function plate(): HTMLElement {
  return lid!.root.querySelector('.lid__print') as HTMLElement;
}

/** Which cells of the TOP strip are lit, as printed offsets. */
function litCells(): number[] {
  const cells = Array.from(plate().querySelectorAll<HTMLElement>('.print__strip--t .print__tz'));
  return cells
    .map((cell, i) => (cell.classList.contains('is-lit') ? i - 11 : null))
    .filter((n): n is number => n !== null);
}

function cellAt(offset: number): HTMLElement {
  return plate().querySelectorAll<HTMLElement>('.print__strip--t .print__tz')[offset + 11]!;
}

beforeEach(() => {
  // Only `Date` is faked: the lid's own timers stay on the real clock, and
  // nothing here waits on a travel.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2024-01-15T12:00:00Z'));
});

afterEach(() => {
  lid?.destroy();
  lid?.root.remove();
  lid?.lip.remove();
  lid = null;
  vi.useRealTimers();
});

describe('with nothing on the air', () => {
  it('lights no cell at all', () => {
    mount();
    expect(litCells()).toEqual([]);
  });

  it('still prints GMT, once, in the cyan it was printed in', () => {
    mount();
    const gmt = plate().querySelectorAll('.print__strip--t .print__tz--gmt');
    expect(gmt).toHaveLength(1);
    expect(gmt[0]!.textContent).toBe('GMT');
    // …and the printed cell is not the lit one just because it is the middle.
    expect(gmt[0]!.classList.contains('is-lit')).toBe(false);
  });

  it('is byte-identical to itself after a station with no origin at all', () => {
    const handle = mount();
    const before = plate().innerHTML;
    handle.setRows([station({ id: 'nowhere' })], { loading: false });
    handle.setPlayback(playing(station({ id: 'nowhere' })));
    // Law 4: the strip goes dark rather than parking on the meridian, and dark
    // is exactly what it already was.
    expect(litCells()).toEqual([]);
    expect(plate().innerHTML).toBe(before);
  });

  it('goes dark again when the station goes away', () => {
    const handle = mount();
    handle.setPlayback(playing(station({ id: 'es-1', countryCode: 'ES', geo: { lat: 40.4, lon: -3.7 } })));
    expect(litCells()).toEqual([1]);
    handle.setPlayback(null);
    expect(litCells()).toEqual([]);
  });
});

describe('a station the directory placed', () => {
  it('lights +1 for Madrid in January, which is where the ICU tz database says it is', () => {
    const handle = mount();
    handle.setPlayback(playing(station({ id: 'es-1', countryCode: 'ES', geo: { lat: 40.4, lon: -3.7 } })));
    // 3.7°W. The longitude arithmetic this replaced reads GMT here.
    expect(litCells()).toEqual([1]);
    // ONE strip on the plate now, not two — the plate prints no map and no
    // second strip at any window size. The lamp lights the strip there is.
    expect(plate().querySelectorAll('.print__strip')).toHaveLength(1);
    // A whole-hour zone: one cell, not a pair.
    expect(cellAt(1).classList.contains('is-lit--half')).toBe(false);
    // AND AT FULL BRIGHTNESS. Spain is a split country — the Canaries keep an
    // hour behind Madrid — but a Madrid fix is not ambiguous: the nearest other
    // Spanish zone is some 1 800 km away. Hedging it was over-hedging, and a
    // hedge that fires for a third of the directory carries no information.
    // The dim is for readings that could genuinely have gone another way.
    expect(cellAt(1).classList.contains('is-lit--dim')).toBe(false);
  });

  it('lights +2 for the same station in July, because daylight saving is real', () => {
    const handle = mount();
    vi.setSystemTime(new Date('2024-07-15T12:00:00Z'));
    handle.setPlayback(playing(station({ id: 'es-1', countryCode: 'ES', geo: { lat: 40.4, lon: -3.7 } })));
    expect(litCells()).toEqual([2]);
  });

  it('sends a Canary Islands fix to its own clock, an hour behind Madrid', () => {
    const handle = mount();
    handle.setPlayback(
      playing(station({ id: 'es-gc', countryCode: 'ES', geo: { lat: 28.1, lon: -15.4 } })),
    );
    // The station's own longitude picks the band, so one country reads two
    // clocks — which is the fact.
    expect(litCells()).toEqual([0]);
  });

  it('lights both bracketing cells for a zone that is half an hour off', () => {
    const handle = mount();
    handle.setPlayback(playing(station({ id: 'in-1', countryCode: 'IN', geo: { lat: 28.6, lon: 77.2 } })));
    // +5:30 is not at +5 and not at +6. It is between them, and it says so.
    expect(litCells()).toEqual([5, 6]);
    expect(cellAt(5).classList.contains('is-lit--half')).toBe(true);
    expect(cellAt(6).classList.contains('is-lit--half')).toBe(true);
    // ONE LAMP CENTRED ON THE LINE BETWEEN THEM, NOT TWO LAMPS.
    //
    // Lit equally and centred, the pair read "these two zones". Each half is
    // brightest at the SHARED edge and falls off away from it, so the light has
    // one centre and it is on the boundary — which is what +5:30 is. The side
    // flags are what the two gradients key off, and `is-lit--half-l` is also
    // what puts out the printed cyan rule across that one boundary: the pair
    // was being cut in two chromatically, by a saturated rule between two amber
    // grounds, not by any difference in brightness.
    expect(cellAt(5).classList.contains('is-lit--half-l')).toBe(true);
    expect(cellAt(5).classList.contains('is-lit--half-r')).toBe(false);
    expect(cellAt(6).classList.contains('is-lit--half-r')).toBe(true);
    expect(cellAt(6).classList.contains('is-lit--half-l')).toBe(false);
    // No other cell on the strip wears a side flag. Two, not four: there is
    // one strip on the plate now.
    const sided = plate().querySelectorAll('.is-lit--half-l, .is-lit--half-r');
    expect(sided).toHaveLength(2);
  });

  it('marks the end of the scale when the reading runs past it', () => {
    const handle = mount();
    // New Zealand on southern summer time is +13, and the case is printed
    // `-11 … +12`. Going dark here was a state collapse: it made "further east
    // than this strip goes" indistinguishable from "nothing known", and it put
    // New Zealand's 240 stations in the dark from September to April.
    //
    // The end cell lights, with the lamp OUTSIDE it — `is-lit--over` puts the
    // light source past the last printed box and lets it fall off inward, so
    // the picture says the reading is beyond the scale rather than at +12.
    handle.setPlayback(
      playing(station({ id: 'nz-1', countryCode: 'NZ', geo: { lat: -36.85, lon: 174.76 } })),
    );
    expect(litCells()).toEqual([12]);
    expect(cellAt(12).classList.contains('is-lit--over')).toBe(true);
    expect(cellAt(12).classList.contains('is-lit--under')).toBe(false);
    // …and it is not the picture an exact +12 reading gets.
    expect(cellAt(12).classList.contains('is-lit--half')).toBe(false);
  });

  it('lights nothing for a fix with no country code, rather than guessing one', () => {
    const handle = mount();
    handle.setPlayback(playing(station({ id: 'sea-1', geo: { lat: 0, lon: 0 } })));
    // The position is known and the map will mark it. The clock is not, and the
    // plate does not invent one from the longitude.
    expect(litCells()).toEqual([]);
  });
});

describe('a station placed only by the country it is filed under', () => {
  it('lights the cell from the country code alone, with no position anywhere', () => {
    const handle = mount();
    const blind = station({ id: 'fr-blind', countryCode: 'FR' });
    handle.setPlayback(playing(blind));
    // THE CLOCK NEEDS A COUNTRY, NOT A POSITION. France keeps one clock, so a
    // bare `FR` is an EXACT answer and there is nothing to wait for. This used
    // to be dark until some other station taught the register where France is
    // — the clock had been coupled to the marker's fallback chain, and 47 689
    // of the directory's 62 038 stations carry a country and no position.
    expect(litCells()).toEqual([1]);
    expect(cellAt(1).classList.contains('is-lit--dim')).toBe(false);

    // Learning the country's position later changes the MAP and not the plate:
    // the clock was already right.
    handle.setRows(
      [station({ id: 'fr-fix', countryCode: 'FR', geo: { lat: 48.85, lon: 2.35 } }), blind],
      { loading: false },
    );
    expect(litCells()).toEqual([1]);
  });

  it('still lights nothing for a country the table has no zone for', () => {
    const handle = mount();
    // `AQ` is deliberately unlisted — Antarctica has ten zones and no
    // representative clock — so this is the designed dark state, not a gap.
    handle.setPlayback(playing(station({ id: 'aq-1', countryCode: 'AQ' })));
    expect(litCells()).toEqual([]);
  });

  it('under-drives the lamp when one clock misdescribes the country', () => {
    const handle = mount();
    const blind = station({ id: 'us-blind', countryCode: 'US' });
    handle.setPlayback(playing(blind));
    handle.setRows(
      [station({ id: 'us-fix', countryCode: 'US', geo: { lat: 40.7, lon: -74 } }), blind],
      { loading: false },
    );
    // A country average inside a country with six zones: a meridian placed it,
    // not the directory, and the lamp says so rather than claiming a fix.
    expect(litCells()).toEqual([-5]);
    expect(cellAt(-5).classList.contains('is-lit--dim')).toBe(true);
  });

  it('does not under-drive it for a country that keeps one clock', () => {
    const handle = mount();
    const blind = station({ id: 'fr-blind', countryCode: 'FR' });
    handle.setPlayback(playing(blind));
    handle.setRows(
      [station({ id: 'fr-fix', countryCode: 'FR', geo: { lat: 48.85, lon: 2.35 } }), blind],
      { loading: false },
    );
    expect(cellAt(1).classList.contains('is-lit--dim')).toBe(false);
  });
});

describe('what ten calls a second are allowed to cost', () => {
  it('writes the plate at most once for thirty identical states', () => {
    const handle = mount();
    const subject = station({ id: 'es-1', countryCode: 'ES', geo: { lat: 40.4, lon: -3.7 } });
    const state = playing(subject);

    const seen: MutationRecord[] = [];
    const observer = new MutationObserver((records) => seen.push(...records));
    observer.observe(plate(), { attributes: true, subtree: true, attributeFilter: ['class'] });

    for (let i = 0; i < 30; i++) handle.setPlayback(state);
    seen.push(...observer.takeRecords());
    observer.disconnect();

    // One write pass, which touches one cell in each of the two strips —
    // counted as NODES, because a single pass sets several class flags on the
    // same cell and each is its own record. Thirty passes would touch sixty
    // nodes; the guard is a comparison before it is a write, so twenty-nine of
    // the thirty calls never reach the DOM at all.
    expect(new Set(seen.map((r) => r.target)).size).toBeLessThanOrEqual(2);
    // …and the one pass that did happen was the right one.
    expect(litCells()).toEqual([1]);
  });

  it('writes nothing at all once the reading has settled', () => {
    const handle = mount();
    const subject = station({ id: 'es-1', countryCode: 'ES', geo: { lat: 40.4, lon: -3.7 } });
    handle.setPlayback(playing(subject));
    expect(litCells()).toEqual([1]);

    const seen: MutationRecord[] = [];
    const observer = new MutationObserver((records) => seen.push(...records));
    observer.observe(plate(), { attributes: true, subtree: true, attributeFilter: ['class'] });
    // Ten a second for three seconds, with the phase moving under it the way a
    // real tick does — nothing the plate is about has changed.
    for (let i = 0; i < 30; i++) handle.setPlayback(playing(subject));
    seen.push(...observer.takeRecords());
    observer.disconnect();

    expect(seen).toEqual([]);
  });

  it('does still follow the subject when the subject really changes', () => {
    const handle = mount();
    handle.setPlayback(playing(station({ id: 'es-1', countryCode: 'ES', geo: { lat: 40.4, lon: -3.7 } })));
    expect(litCells()).toEqual([1]);
    handle.setPlayback(playing(station({ id: 'jp-1', countryCode: 'JP', geo: { lat: 35.7, lon: 139.7 } })));
    expect(litCells()).toEqual([9]);
  });
});

describe('what the lamp does not touch', () => {
  it('writes no custom property onto the lid root', () => {
    const handle = mount();
    handle.setPlayback(playing(station({ id: 'es-1', countryCode: 'ES', geo: { lat: 40.4, lon: -3.7 } })));
    // The ~4100-node inheritance documented at lid.css:152-173 cost 137-333 ms
    // of blocked main thread. Nothing about a lamp earns that back.
    const inline = handle.root.getAttribute('style') ?? '';
    expect(inline).not.toMatch(/--/);
  });

  it('leaves the structure of the printed strip alone', () => {
    const handle = mount();
    const before = plate().querySelectorAll('.print__strip--t .print__tz').length;
    handle.setPlayback(playing(station({ id: 'es-1', countryCode: 'ES', geo: { lat: 40.4, lon: -3.7 } })));
    const cells = plate().querySelectorAll('.print__strip--t .print__tz');
    expect(cells).toHaveLength(before);
    expect(cells).toHaveLength(24);
    // The printing is unchanged text; only a class was added.
    expect(Array.from(cells).map((c) => c.textContent).join(' ')).toContain('GMT');
    expect(plate().querySelectorAll('.print__tz--gmt')).toHaveLength(1);
  });

  it('prints no world map on the plate, at any depth', () => {
    const handle = mount();
    // THE PLATE HAS NO MAP. Not hidden by a media query, not sized to nothing —
    // not built. It used to gain one, plus a second timezone strip, once the
    // plate was 168 px deep. The shipped Windows build runs a 158 px plate, so
    // it was ten pixels under that line and the map was never drawn there in
    // the life of the build; drawn properly for the first time, it was not
    // wanted. `COASTLINES` stays in worldGeometry for the REGISTER's map, which
    // is a different surface and still has one.
    expect(plate().querySelector('.print__map')).toBeNull();
    expect(plate().querySelectorAll('svg')).toHaveLength(0);
    expect(plate().querySelectorAll('.print__strip')).toHaveLength(1);
    expect(plate().querySelectorAll('.print__tz')).toHaveLength(24);
    // The lamp still has its cell, and the printed GMT reference is still one
    // node reading GMT.
    handle.setPlayback(playing(station({ id: 'fr-1', countryCode: 'FR' })));
    expect(litCells()).toEqual([1]);
    expect(plate().querySelectorAll('.print__tz--gmt')).toHaveLength(1);
    expect(plate().querySelector('.print__tz--gmt')!.textContent).toBe('GMT');
  });
});
