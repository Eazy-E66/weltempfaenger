import { describe, expect, it } from 'vitest';

import {
  BAND_ORIGIN,
  COUNTRY_ZONE,
  EXCEPTION,
  MARGIN_KM,
  SPLIT,
  STRIP_MAX_HOUR,
  STRIP_MIN_HOUR,
  isSplit,
  localClock,
  offsetLabel,
  offsetMinutes,
  resolveZone,
  stripLamp,
  zoneFor,
} from '../../src/renderer/ui/worldTime';

/**
 * WHAT TIME IT IS WHERE THE STATION TRANSMITS FROM.
 *
 * The expression this replaces is `Math.round(lon / 15)`, which the register
 * used for the density dot's clock. Everything below is a case that expression
 * gets wrong, plus the pin that stops the authored half of the answer rotting.
 *
 * Every offset here is asserted off a FIXED `Date`, never off `new Date()`, so
 * a run in July cannot pass a January expectation.
 */

const JAN = new Date('2024-01-15T12:00:00Z');
const JUL = new Date('2024-07-15T12:00:00Z');

describe('the offset comes from ICU, not from the table', () => {
  it('reads Spain as +1 in January and +2 in July', () => {
    // `Math.round(lon / 15)` reads Madrid at 3.7°W as GMT, all year. It is not:
    // Spain keeps Central European time, and it keeps summer time as well.
    expect(offsetMinutes('Europe/Madrid', JAN)).toBe(60);
    expect(offsetMinutes('Europe/Madrid', JUL)).toBe(120);
  });

  it('reads the half-hour offsets the longitude arithmetic cannot express', () => {
    expect(offsetMinutes('Asia/Kolkata', JAN)).toBe(330);
    expect(offsetMinutes('Asia/Kolkata', JUL)).toBe(330);
    expect(offsetMinutes('Asia/Tehran', JAN)).toBe(210);
    expect(offsetMinutes('Asia/Kathmandu', JAN)).toBe(345);
  });

  it('reads GMT itself as zero, which ICU prints without a sign', () => {
    expect(offsetMinutes('Etc/GMT', JAN)).toBe(0);
    expect(offsetMinutes('Atlantic/Reykjavik', JUL)).toBe(0);
    // London is GMT in winter and BST in summer — the same zone, two answers.
    expect(offsetMinutes('Europe/London', JAN)).toBe(0);
    expect(offsetMinutes('Europe/London', JUL)).toBe(60);
  });

  it('carries a negative offset with its sign', () => {
    expect(offsetMinutes('America/St_Johns', JAN)).toBe(-210);
    expect(offsetMinutes('Pacific/Marquesas', JAN)).toBe(-570);
  });
});

describe('a longitude picks the band inside a split country', () => {
  it('walks the United States west to east, with daylight saving on top', () => {
    const la = zoneFor('US', -118.24);
    expect(la).toBe('America/Los_Angeles');
    expect(offsetMinutes(la!, JAN)).toBe(-480);
    expect(offsetMinutes(la!, JUL)).toBe(-420);

    const ny = zoneFor('US', -74.0);
    expect(ny).toBe('America/New_York');
    expect(offsetMinutes(ny!, JAN)).toBe(-300);
    expect(offsetMinutes(ny!, JUL)).toBe(-240);

    expect(zoneFor('US', -87.63)).toBe('America/Chicago');
    expect(zoneFor('US', -104.99)).toBe('America/Denver');
    expect(zoneFor('US', -149.9)).toBe('America/Anchorage');
    expect(zoneFor('US', -157.86)).toBe('Pacific/Honolulu');
  });

  it('puts Beijing on +8, which is the whole of China', () => {
    const cn = zoneFor('CN', 116.4);
    expect(cn).toBe('Asia/Shanghai');
    expect(offsetMinutes(cn!, JAN)).toBe(480);
    // China is one legal clock from Kashgar to the Pacific — 74°E reads +8 too,
    // where the longitude arithmetic would say +5.
    expect(zoneFor('CN', 75.99)).toBe('Asia/Shanghai');
  });

  it('sends the Canaries and the Azores to their own islands', () => {
    expect(zoneFor('ES', -3.7)).toBe('Europe/Madrid');
    expect(zoneFor('ES', -15.43)).toBe('Atlantic/Canary');
    expect(offsetMinutes(zoneFor('ES', -15.43)!, JAN)).toBe(0);
    expect(zoneFor('PT', -9.14)).toBe('Europe/Lisbon');
    expect(zoneFor('PT', -25.67)).toBe('Atlantic/Azores');
    // Madeira at 16.9°W keeps Lisbon's clock, so the boundary is out at 20°W.
    expect(zoneFor('PT', -16.92)).toBe('Europe/Lisbon');
  });

  it('resolves the other split countries at their capitals', () => {
    expect(zoneFor('RU', 37.62)).toBe('Europe/Moscow');
    expect(zoneFor('RU', 131.89)).toBe('Asia/Vladivostok');
    expect(zoneFor('CA', -79.38)).toBe('America/Toronto');
    expect(zoneFor('CA', -123.12)).toBe('America/Vancouver');
    expect(zoneFor('AU', 115.86)).toBe('Australia/Perth');
    expect(zoneFor('AU', 151.21)).toBe('Australia/Sydney');
    expect(zoneFor('BR', -46.63)).toBe('America/Sao_Paulo');
    expect(zoneFor('MX', -99.13)).toBe('America/Mexico_City');
    expect(zoneFor('ID', 106.85)).toBe('Asia/Jakarta');
    expect(zoneFor('CL', -109.35)).toBe('Pacific/Easter');
    expect(zoneFor('EC', -90.3)).toBe('Pacific/Galapagos');
    expect(zoneFor('MN', 91.64)).toBe('Asia/Hovd');
  });

  it('still answers a split country asked without a longitude', () => {
    // The centroid may not have been learned yet. The most populous zone is a
    // representative answer, and `isSplit` is how the caller marks it as one.
    expect(zoneFor('US')).toBe('America/New_York');
    expect(zoneFor('RU')).toBe('Europe/Moscow');
    expect(isSplit('US')).toBe(true);
    expect(isSplit('FR')).toBe(false);
    expect(isSplit(undefined)).toBe(false);
  });

  it('is case-insensitive about the country code, as the directory is not', () => {
    expect(zoneFor('fr')).toBe('Europe/Paris');
    expect(zoneFor('es', -15.43)).toBe('Atlantic/Canary');
  });
});

describe('what it will not guess', () => {
  it('answers null rather than a plausible neighbour', () => {
    expect(zoneFor(undefined)).toBeNull();
    expect(zoneFor('')).toBeNull();
    expect(zoneFor('ZZ')).toBeNull();
    expect(zoneFor('ZZ', 12)).toBeNull();
    // Antarctica is deliberately unlisted: ten zones, no representative clock.
    expect(zoneFor('AQ')).toBeNull();
  });

  it('returns null for an unknown zone instead of throwing', () => {
    // `Intl.DateTimeFormat` throws `RangeError` here. A pointer moving down the
    // ledger may not be the thing that finds that out.
    expect(() => offsetMinutes('Not/AZone', JAN)).not.toThrow();
    expect(offsetMinutes('Not/AZone', JAN)).toBeNull();
    expect(localClock('Not/AZone', JAN)).toBeNull();
    // …and the cached null is the same answer on the second ask.
    expect(offsetMinutes('Not/AZone', JUL)).toBeNull();
  });

  it('returns null for an invalid instant rather than printing NaN', () => {
    expect(offsetMinutes('Europe/Madrid', new Date(NaN))).toBeNull();
    expect(localClock('Europe/Madrid', new Date(NaN))).toBeNull();
  });
});

describe('the clock on the wall', () => {
  it('is 24-hour, zero-padded, and in the zone asked for', () => {
    expect(localClock('Etc/GMT', new Date('2024-01-15T09:07:00Z'))).toBe('09:07');
    expect(localClock('Europe/Madrid', new Date('2024-01-15T09:07:00Z'))).toBe('10:07');
    expect(localClock('Asia/Kolkata', new Date('2024-01-15T09:07:00Z'))).toBe('14:37');
    // Midnight is 00, never 24 — `hourCycle: 'h23'` and not `h24`.
    expect(localClock('Etc/GMT', new Date('2024-01-15T00:30:00Z'))).toBe('00:30');
  });
});

describe('how an offset is written on this receiver', () => {
  it('uses the vocabulary the strip is printed with', () => {
    expect(offsetLabel(0)).toBe('GMT');
    expect(offsetLabel(60)).toBe('GMT+1');
    expect(offsetLabel(-300)).toBe('GMT-5');
    expect(offsetLabel(330)).toBe('GMT+5:30');
    expect(offsetLabel(-210)).toBe('GMT-3:30');
    expect(offsetLabel(345)).toBe('GMT+5:45');
    expect(offsetLabel(NaN)).toBe('GMT');
  });
});

describe('which printed cell lights', () => {
  it('lights exactly one for a whole-hour zone', () => {
    expect(stripLamp(0)).toEqual({ kind: 'exact', cells: [0] });
    expect(stripLamp(60)).toEqual({ kind: 'exact', cells: [1] });
    expect(stripLamp(-480)).toEqual({ kind: 'exact', cells: [-8] });
    expect(stripLamp(STRIP_MIN_HOUR * 60)).toEqual({ kind: 'exact', cells: [-11] });
    expect(stripLamp(STRIP_MAX_HOUR * 60)).toEqual({ kind: 'exact', cells: [12] });
  });

  it('lights the two cells a fractional zone lies between', () => {
    expect(stripLamp(330)).toEqual({ kind: 'between', cells: [5, 6] });
    expect(stripLamp(345)).toEqual({ kind: 'between', cells: [5, 6] });
    expect(stripLamp(210)).toEqual({ kind: 'between', cells: [3, 4] });
    expect(stripLamp(-210)).toEqual({ kind: 'between', cells: [-4, -3] });
  });

  it('lights nothing at all when the case has no cell for the reading', () => {
    // New Zealand on summer time is +13, and the strip stops at +12. Lighting
    // +12 would claim an offset the station does not keep.
    expect(stripLamp(780).kind).toBe('off-strip');
    expect(stripLamp(-720).kind).toBe('off-strip');
    // Chatham at +12:45 has one neighbour on the strip and one off it, which is
    // not a legible "between these two" either.
    expect(stripLamp(765).kind).toBe('off-strip');
    expect(stripLamp(NaN).kind).toBe('off-strip');
    expect(stripLamp(780).cells).toHaveLength(0);
  });

  it('agrees with what the plate is actually printed with', () => {
    for (let h = STRIP_MIN_HOUR; h <= STRIP_MAX_HOUR; h++) {
      const lamp = stripLamp(h * 60);
      expect(lamp.kind, `offset ${h}`).toBe('exact');
      expect(lamp.cells[0], `offset ${h}`).toBe(h);
    }
  });
});

describe('a country that crosses the antimeridian still runs west to east', () => {
  it('reads Chukotka as +12 and not as Kaliningrad', () => {
    // `ART City Radio` transmits from 65.69N 175.29W. Walked west→east off a
    // ladder that stopped at 180, its longitude sorted below Kaliningrad's own
    // and the plate lit +2 at full brightness with no approximation mark:
    // 17:13 LOCAL where the truth was 03:13. Ten hours, inside a lit box.
    const z = zoneFor('RU', -175.29, 65.69);
    expect(z).toBe('Asia/Anadyr');
    expect(offsetMinutes(z!, JAN)).toBe(720);
    expect(offsetMinutes(z!, JUL)).toBe(720);
    // The ten hours, stated: this is what the same station used to read.
    expect(offsetMinutes('Europe/Kaliningrad', JAN)).toBe(120);
  });

  it('reads the western Aleutians as -10 and not as New York', () => {
    // Attu is at 172.9E — American soil on the far side of the date line.
    const z = zoneFor('US', 172.9, 52.9);
    expect(z).toBe('America/Adak');
    expect(offsetMinutes(z!, JAN)).toBe(-600);
    expect(offsetMinutes(z!, JUL)).toBe(-540);
    // The thirteen hours, stated: this is what it used to read.
    expect(offsetMinutes('America/New_York', JAN)).toBe(-300);
    // Adak itself, on the near side of the line, is the same clock.
    expect(zoneFor('US', -176.63, 51.88)).toBe('America/Adak');
    // …and Unalaska, east of 169.5W, is an hour ahead of it.
    expect(zoneFor('US', -166.53, 53.87)).toBe('America/Anchorage');
  });

  it('walks Chukotka and Kamchatka in the right order', () => {
    expect(zoneFor('RU', 177.51, 64.73)).toBe('Asia/Anadyr');
    expect(zoneFor('RU', -173.23, 64.42)).toBe('Asia/Anadyr');
    expect(zoneFor('RU', 158.65, 53.02)).toBe('Asia/Kamchatka');
    expect(zoneFor('RU', 142.74, 46.96)).toBe('Asia/Sakhalin');
  });

  it('spreads Kiribati over its three clocks and two hemispheres', () => {
    expect(zoneFor('KI', 172.98, 1.33)).toBe('Pacific/Tarawa');
    expect(offsetMinutes(zoneFor('KI', 172.98, 1.33)!, JAN)).toBe(720);
    expect(zoneFor('KI', -171.68, -2.81)).toBe('Pacific/Kanton');
    expect(offsetMinutes(zoneFor('KI', -171.68, -2.81)!, JAN)).toBe(780);
    expect(zoneFor('KI', -157.4, 1.87)).toBe('Pacific/Kiritimati');
    expect(offsetMinutes(zoneFor('KI', -157.4, 1.87)!, JAN)).toBe(840);
  });

  it('moves only the meridians the country is actually on', () => {
    // The origin sits in the empty ocean behind each of them, so a station that
    // files a nonsense longitude keeps the answer it had rather than being
    // teleported across the Pacific by the wrap.
    expect(zoneFor('RU', -123.39)).toBe('Europe/Kaliningrad');
    expect(zoneFor('RU', -27.26)).toBe('Europe/Kaliningrad');
    expect(zoneFor('US', 1.44)).toBe('America/New_York');
    expect(zoneFor('KI', 0)).toBe('Pacific/Tarawa');
  });
});

describe('a latitude where a meridian cannot answer', () => {
  it('separates western Alaska from Hawaii, which share the meridians', () => {
    // Both sit between 154W and 167W and nothing else about them agrees.
    for (const [lat, lon] of [
      [64.5, -165.41],  // Nome
      [60.79, -161.76], // Bethel
      [66.9, -162.6],   // Kotzebue
      [53.87, -166.53], // Unalaska
      [71.29, -156.79], // Utqiagvik
      [57.79, -152.41], // Kodiak
    ] as const) {
      const z = zoneFor('US', lon, lat);
      expect(z, `${lat},${lon}`).toBe('America/Anchorage');
      expect(offsetMinutes(z!, JAN), `${lat},${lon} JAN`).toBe(-540);
      // An hour out in winter and TWO hours out in summer, which is what the
      // -152 meridian on its own was costing all six of them.
      expect(offsetMinutes(z!, JUL), `${lat},${lon} JUL`).toBe(-480);
    }
    for (const [lat, lon] of [
      [21.31, -157.86], // Honolulu
      [19.71, -155.08], // Hilo
      [21.97, -159.37], // Kauai
      [20.89, -156.5],  // Maui
    ] as const) {
      const z = zoneFor('US', lon, lat);
      expect(z, `${lat},${lon}`).toBe('Pacific/Honolulu');
      expect(offsetMinutes(z!, JAN), `${lat},${lon}`).toBe(-600);
      expect(offsetMinutes(z!, JUL), `${lat},${lon}`).toBe(-600);
    }
  });

  it('separates Arizona from Utah on the 37th parallel, which is the state line', () => {
    expect(zoneFor('US', -112.07, 33.45)).toBe('America/Phoenix'); // Phoenix
    expect(zoneFor('US', -110.97, 32.22)).toBe('America/Phoenix'); // Tucson
    expect(zoneFor('US', -111.65, 35.2)).toBe('America/Phoenix');  // Flagstaff
    // Arizona keeps -7 all year; its neighbours do not.
    expect(offsetMinutes('America/Phoenix', JAN)).toBe(-420);
    expect(offsetMinutes('America/Phoenix', JUL)).toBe(-420);
    expect(zoneFor('US', -111.89, 40.76)).toBe('America/Denver');  // Salt Lake City
    expect(zoneFor('US', -113.58, 37.1)).toBe('America/Denver');   // St George, UT
  });

  it('separates the Idaho of Boise from the Nevada of Elko on the 42nd', () => {
    expect(zoneFor('US', -116.2, 43.62)).toBe('America/Denver');       // Boise
    expect(zoneFor('US', -115.76, 40.83)).toBe('America/Los_Angeles'); // Elko
    expect(zoneFor('US', -115.14, 36.17)).toBe('America/Los_Angeles'); // Las Vegas
    // …and the Idaho panhandle, which turns Pacific again above the Salmon.
    expect(zoneFor('US', -116.78, 47.68)).toBe('America/Los_Angeles'); // Coeur d Alene
    expect(zoneFor('US', -117.43, 47.66)).toBe('America/Los_Angeles'); // Spokane
    expect(zoneFor('US', -113.99, 46.87)).toBe('America/Denver');      // Missoula
  });

  it('reads west Texas as Central and El Paso as Mountain', () => {
    for (const [lat, lon, name] of [
      [35.22, -101.83, 'Amarillo'],
      [33.58, -101.86, 'Lubbock'],
      [31.99, -102.08, 'Midland'],
      [30.31, -104.02, 'Marfa'],
    ] as const) {
      const z = zoneFor('US', lon, lat);
      expect(z, name).toBe('America/Chicago');
      expect(offsetMinutes(z!, JAN), name).toBe(-360);
      expect(offsetMinutes(z!, JUL), name).toBe(-300);
    }
    // El Paso genuinely is Mountain, so this could never be a shifted meridian.
    const ep = zoneFor('US', -106.49, 31.76);
    expect(ep).toBe('America/Denver');
    expect(offsetMinutes(ep!, JAN)).toBe(-420);
    // Nor could it be a parallel: New Mexico is Mountain all the way up, and
    // Colorado and the Nebraska panhandle are Mountain above the 37th.
    expect(zoneFor('US', -103.13, 32.7)).toBe('America/Denver');  // Hobbs, NM
    expect(zoneFor('US', -104.52, 33.39)).toBe('America/Denver');  // Roswell, NM
    expect(zoneFor('US', -102.62, 38.09)).toBe('America/Denver');  // Lamar, CO
    expect(zoneFor('US', -102.98, 41.14)).toBe('America/Denver');  // Sidney, NE
    expect(zoneFor('US', -100.02, 37.75)).toBe('America/Chicago'); // Dodge City, KS
  });

  it('reads Bowling Green as Central and Louisville as Eastern', () => {
    const bg = zoneFor('US', -86.44, 36.99);
    expect(bg).toBe('America/Chicago');
    expect(offsetMinutes(bg!, JAN)).toBe(-360);
    expect(offsetMinutes(bg!, JUL)).toBe(-300);
    expect(zoneFor('US', -85.86, 37.69)).toBe('America/Chicago');  // Elizabethtown, KY
    expect(zoneFor('US', -85.5, 36.16)).toBe('America/Chicago');   // Cookeville, TN
    expect(zoneFor('US', -86.3, 32.37)).toBe('America/Chicago');   // Montgomery, AL
    expect(zoneFor('US', -85.66, 30.16)).toBe('America/Chicago');  // Panama City, FL
    expect(zoneFor('US', -85.76, 38.25)).toBe('America/New_York'); // Louisville, KY
    expect(zoneFor('US', -86.15, 39.77)).toBe('America/New_York'); // Indianapolis, IN
    expect(zoneFor('US', -85.62, 42.28)).toBe('America/New_York'); // Kalamazoo, MI
    expect(zoneFor('US', -85.31, 35.05)).toBe('America/New_York'); // Chattanooga, TN
    expect(zoneFor('US', -84.28, 30.44)).toBe('America/New_York'); // Tallahassee, FL
  });

  it('reads New Brunswick as Atlantic even where it reaches west of Quebec', () => {
    const ed = zoneFor('CA', -68.33, 47.37); // Edmundston, NB
    expect(ed).toBe('America/Halifax');
    expect(offsetMinutes(ed!, JAN)).toBe(-240);
    expect(offsetMinutes(ed!, JUL)).toBe(-180);
    expect(zoneFor('CA', -66.67, 48.0)).toBe('America/Halifax');  // Campbellton, NB
    expect(zoneFor('CA', -64.79, 46.09)).toBe('America/Halifax');  // Moncton, NB
    // Quebec directly above it keeps Eastern, and so does its north shore.
    expect(zoneFor('CA', -68.52, 48.45)).toBe('America/Toronto');  // Rimouski, QC
    expect(zoneFor('CA', -69.54, 47.84)).toBe('America/Toronto');  // Riviere-du-Loup
    expect(zoneFor('CA', -64.48, 48.83)).toBe('America/Toronto');  // Gaspe, QC
    expect(zoneFor('CA', -63.61, 50.24)).toBe('America/Toronto');  // Havre-St-Pierre
    // Labrador, above the Quebec shore, is Atlantic again.
    expect(zoneFor('CA', -66.91, 52.94)).toBe('America/Halifax');  // Labrador City
    expect(zoneFor('CA', -60.42, 53.3)).toBe('America/Halifax');   // Goose Bay
    expect(zoneFor('CA', -68.52, 63.75)).toBe('America/Toronto');  // Iqaluit, NU
  });

  it('reads the Alberta Peace country as Mountain and the Okanagan as Pacific', () => {
    expect(zoneFor('CA', -118.8, 55.17)).toBe('America/Edmonton');   // Grande Prairie
    expect(zoneFor('CA', -117.2, 55.74)).toBe('America/Edmonton');   // Falher, AB
    expect(zoneFor('CA', -115.68, 54.14)).toBe('America/Edmonton');  // Whitecourt, AB
    expect(zoneFor('CA', -119.49, 49.89)).toBe('America/Vancouver'); // Kelowna, BC
    expect(zoneFor('CA', -123.12, 49.28)).toBe('America/Vancouver'); // Vancouver
  });

  it('reads the Volga republics in the order they actually keep', () => {
    const volgograd = zoneFor('RU', 44.51, 48.71);
    expect(offsetMinutes(volgograd!, JAN)).toBe(180);
    const kirov = zoneFor('RU', 49.67, 58.6);
    expect(offsetMinutes(kirov!, JAN)).toBe(180);
    const izhevsk = zoneFor('RU', 53.21, 56.85);
    expect(offsetMinutes(izhevsk!, JAN)).toBe(240);
    expect(izhevsk).toBe('Europe/Samara');
    // …and the ones stacked either side of them.
    expect(offsetMinutes(zoneFor('RU', 49.11, 55.79)!, JAN)).toBe(180); // Kazan
    expect(offsetMinutes(zoneFor('RU', 52.4, 55.74)!, JAN)).toBe(180);  // Nab Chelny
    expect(offsetMinutes(zoneFor('RU', 50.84, 61.67)!, JAN)).toBe(180); // Syktyvkar
    expect(offsetMinutes(zoneFor('RU', 50.15, 53.2)!, JAN)).toBe(240);  // Samara
    expect(offsetMinutes(zoneFor('RU', 48.4, 54.32)!, JAN)).toBe(240);  // Ulyanovsk
    expect(offsetMinutes(zoneFor('RU', 46.03, 51.53)!, JAN)).toBe(240); // Saratov
    expect(offsetMinutes(zoneFor('RU', 56.25, 58.01)!, JAN)).toBe(300); // Perm
    expect(offsetMinutes(zoneFor('RU', 55.97, 54.74)!, JAN)).toBe(300); // Ufa
  });

  it('keeps Queensland and the Northern Territory off summer time', () => {
    const brisbane = zoneFor('AU', 153.03, -27.47);
    expect(brisbane).toBe('Australia/Brisbane');
    expect(offsetMinutes(brisbane!, JAN)).toBe(600);
    expect(offsetMinutes(brisbane!, JUL)).toBe(600);
    expect(zoneFor('AU', 145.77, -16.92)).toBe('Australia/Brisbane'); // Cairns
    const darwin = zoneFor('AU', 130.84, -12.46);
    expect(darwin).toBe('Australia/Darwin');
    expect(offsetMinutes(darwin!, JAN)).toBe(570);
    expect(offsetMinutes(darwin!, JUL)).toBe(570);
    expect(zoneFor('AU', 133.88, -23.7)).toBe('Australia/Darwin');   // Alice Springs
    // The neighbours that DO move, which is the whole of the difference.
    expect(zoneFor('AU', 153.29, -28.8)).toBe('Australia/Sydney');   // Lismore, NSW
    expect(zoneFor('AU', 151.21, -33.87)).toBe('Australia/Sydney');
    expect(zoneFor('AU', 138.6, -34.93)).toBe('Australia/Adelaide');
    expect(zoneFor('AU', 115.86, -31.95)).toBe('Australia/Perth');
  });

  it('finds Magallanes below Santiago rather than beside it', () => {
    const pa = zoneFor('CL', -70.92, -53.16);
    expect(pa).toBe('America/Punta_Arenas');
    // Punta Arenas keeps -3 all year where Santiago moves, which is exactly
    // what a longitude 0.3 degrees away could never have told anyone.
    expect(offsetMinutes(pa!, JAN)).toBe(-180);
    expect(offsetMinutes(pa!, JUL)).toBe(-180);
    const sc = zoneFor('CL', -70.65, -33.45);
    expect(sc).toBe('America/Santiago');
    expect(offsetMinutes(sc!, JAN)).toBe(-180);
    expect(offsetMinutes(sc!, JUL)).toBe(-240);
  });
});

describe('the split countries that had no bands at all', () => {
  it('splits the Congo down the Kasai and the Congo', () => {
    expect(zoneFor('CD', 15.31, -4.32)).toBe('Africa/Kinshasa');    // Kinshasa
    expect(zoneFor('CD', 18.82, -5.04)).toBe('Africa/Kinshasa');    // Kikwit
    expect(zoneFor('CD', 22.47, 2.19)).toBe('Africa/Kinshasa');     // Bumba
    expect(zoneFor('CD', 20.8, -6.42)).toBe('Africa/Lubumbashi');   // Tshikapa
    expect(zoneFor('CD', 25.19, 0.52)).toBe('Africa/Lubumbashi');   // Kisangani
    expect(zoneFor('CD', 27.48, -11.66)).toBe('Africa/Lubumbashi'); // Lubumbashi
    expect(zoneFor('CD', 28.87, -2.5)).toBe('Africa/Lubumbashi');   // Bukavu
    expect(offsetMinutes('Africa/Kinshasa', JAN)).toBe(60);
    expect(offsetMinutes('Africa/Lubumbashi', JAN)).toBe(120);
  });

  it('stacks French Polynesia by latitude east of 141W', () => {
    expect(zoneFor('PF', -149.57, -17.54)).toBe('Pacific/Tahiti');     // Papeete
    expect(zoneFor('PF', -145.62, -16.05)).toBe('Pacific/Tahiti');     // Fakarava
    expect(zoneFor('PF', -140.1, -8.92)).toBe('Pacific/Marquesas');    // Nuku Hiva
    expect(zoneFor('PF', -140.95, -18.07)).toBe('Pacific/Tahiti');     // Hao, Tuamotu
    expect(zoneFor('PF', -134.97, -23.12)).toBe('Pacific/Gambier');    // Rikitea
    expect(offsetMinutes('Pacific/Tahiti', JAN)).toBe(-600);
    expect(offsetMinutes('Pacific/Marquesas', JAN)).toBe(-570);
    expect(offsetMinutes('Pacific/Gambier', JAN)).toBe(-540);
  });

  it('walks Greenland from Thule to Danmarkshavn', () => {
    expect(zoneFor('GL', -69.23, 77.48)).toBe('America/Thule');
    expect(zoneFor('GL', -51.72, 64.18)).toBe('America/Nuuk');
    expect(zoneFor('GL', -51.1, 69.22)).toBe('America/Nuuk');
    expect(zoneFor('GL', -21.97, 70.48)).toBe('America/Scoresbysund');
    expect(zoneFor('GL', -18.66, 76.77)).toBe('America/Danmarkshavn');
    expect(offsetMinutes('America/Thule', JAN)).toBe(-240);
    expect(offsetMinutes('America/Nuuk', JAN)).toBe(-120);
    expect(offsetMinutes('America/Danmarkshavn', JAN)).toBe(0);
  });

  it('puts Bougainville an hour ahead of Port Moresby', () => {
    expect(zoneFor('PG', 147.18, -9.44)).toBe('Pacific/Port_Moresby');
    expect(zoneFor('PG', 152.18, -4.2)).toBe('Pacific/Port_Moresby'); // Rabaul
    expect(zoneFor('PG', 154.67, -5.42)).toBe('Pacific/Bougainville'); // Buka
    expect(offsetMinutes('Pacific/Port_Moresby', JAN)).toBe(600);
    expect(offsetMinutes('Pacific/Bougainville', JAN)).toBe(660);
  });

  it('walks Micronesia from Yap to Kosrae', () => {
    expect(zoneFor('FM', 138.13, 9.51)).toBe('Pacific/Chuuk'); // Yap
    expect(zoneFor('FM', 151.85, 7.45)).toBe('Pacific/Chuuk');
    expect(zoneFor('FM', 158.16, 6.92)).toBe('Pacific/Pohnpei');
    expect(zoneFor('FM', 162.98, 5.32)).toBe('Pacific/Kosrae');
    expect(offsetMinutes('Pacific/Chuuk', JAN)).toBe(600);
    expect(offsetMinutes('Pacific/Kosrae', JAN)).toBe(660);
  });

  it('lights Kosovo, which was dark', () => {
    // 18 stations in the directory file XK. There is no ISO-3166-1 assignment
    // for Kosovo and no CLDR zone list under the code, and the answer to that
    // was 18 unlit strips. Kosovo keeps Belgrade's clock.
    const z = zoneFor('XK');
    expect(z).toBe('Europe/Belgrade');
    expect(offsetMinutes(z!, JAN)).toBe(60);
    expect(offsetMinutes(z!, JUL)).toBe(120);
    expect(zoneFor('xk', 21.16, 42.66)).toBe('Europe/Belgrade');
    // It is one zone for the whole territory, so it is not a guess.
    expect(resolveZone('XK')).toEqual({ zone: 'Europe/Belgrade', approximate: false });
    // …and the codes that stay unlisted stay unlisted.
    expect(zoneFor('AQ')).toBeNull();
    expect(zoneFor('BV')).toBeNull();
    expect(zoneFor('HM')).toBeNull();
  });
});

describe('an answer that says which kind of answer it is', () => {
  it('marks a one-zone country exact even with nothing but a country code', () => {
    // 47,689 of the 62,038 stations in the directory publish a country code and
    // no position at all. For a country with one zone that is not a shortfall:
    // there is nothing a coordinate could add.
    expect(resolveZone('SE')).toEqual({ zone: 'Europe/Stockholm', approximate: false });
    expect(resolveZone('JP')).toEqual({ zone: 'Asia/Tokyo', approximate: false });
    expect(resolveZone('IN')).toEqual({ zone: 'Asia/Kolkata', approximate: false });
    // A position does not make it any more exact, and does not make it less.
    expect(resolveZone('FR', 2.35, 48.86)).toEqual({ zone: 'Europe/Paris', approximate: false });
    expect(resolveZone('fr')).toEqual({ zone: 'Europe/Paris', approximate: false });
  });

  it('marks a split country approximate when it has no usable position', () => {
    // Without one, the most populous zone stands in for the rest, and that
    // genuinely is a guess: a US station with no fix could be any of six.
    expect(resolveZone('US')).toEqual({ zone: 'America/New_York', approximate: true });
    expect(resolveZone('RU')).toEqual({ zone: 'Europe/Moscow', approximate: true });
    // A longitude with no latitude cannot be checked and is a guess too.
    expect(resolveZone('CA', -63.58)).toEqual({ zone: 'America/Halifax', approximate: true });
    expect(resolveZone('US', -118.24)).toEqual({
      zone: 'America/Los_Angeles', approximate: true,
    });
    // An unusable position falls back to the whole-country answer, still a guess.
    expect(resolveZone('US', NaN, NaN)).toEqual({
      zone: 'America/New_York', approximate: true,
    });
    expect(resolveZone('US', -118.24, NaN)).toEqual({
      zone: 'America/Los_Angeles', approximate: true,
    });
  });

  it('marks a fix in the middle of a band exact, because it is', () => {
    // A hedge is worth what it is rare. Madrid is 700 km from the only other
    // Spanish band and there is nothing whatever to be uncertain about.
    expect(resolveZone('US', -118.24, 34.05)).toEqual({
      zone: 'America/Los_Angeles', approximate: false,
    });
    expect(resolveZone('ES', -3.7, 40.42)).toEqual({
      zone: 'Europe/Madrid', approximate: false,
    });
    expect(resolveZone('ES', 2.17, 41.39)).toEqual({
      zone: 'Europe/Madrid', approximate: false,
    });
    expect(resolveZone('ES', -15.43, 28.1)).toEqual({
      zone: 'Atlantic/Canary', approximate: false,
    });
    expect(resolveZone('PT', -9.14, 38.72)?.approximate).toBe(false);
    expect(resolveZone('BR', -46.63, -23.55)?.approximate).toBe(false);
    expect(resolveZone('BR', -34.88, -8.05)?.approximate).toBe(false);
    expect(resolveZone('US', -74.0, 40.71)?.approximate).toBe(false);
    expect(resolveZone('RU', 37.62, 55.75)?.approximate).toBe(false);
    expect(resolveZone('CA', -79.38, 43.65)?.approximate).toBe(false);
    expect(resolveZone('AU', 115.86, -31.95)?.approximate).toBe(false);
    expect(resolveZone('MX', -99.13, 19.43)?.approximate).toBe(false);
    // …and the offsets are still exactly right, which is the point of not
    // hedging them.
    expect(offsetMinutes(zoneFor('ES', -3.7, 40.42)!, JAN)).toBe(60);
    expect(offsetMinutes(zoneFor('ES', -3.7, 40.42)!, JUL)).toBe(120);
    expect(offsetMinutes(zoneFor('ES', -15.43, 28.1)!, JAN)).toBe(0);
    expect(offsetMinutes(zoneFor('BR', -46.63, -23.55)!, JAN)).toBe(-180);
    expect(offsetMinutes(zoneFor('US', -74.0, 40.71)!, JUL)).toBe(-240);
  });

  it('marks a fix near a boundary approximate, in either direction', () => {
    // Chicago is 94 km from the meridian this table uses for the Central and
    // Eastern line, and 60 km from where that line actually runs.
    expect(resolveZone('US', -87.63, 41.88)?.approximate).toBe(true);
    // Both edges of a band count: west of the boundary and east of it.
    expect(resolveZone('US', -86.6, 36.2)?.approximate).toBe(true);
    expect(resolveZone('US', -86.4, 36.2)?.approximate).toBe(true);
    // A latitude ladder is a boundary too — Udmurtia is a slab 150 km thick.
    expect(resolveZone('RU', 53.21, 56.85)?.approximate).toBe(true);
    // Lloydminster sits ON the Alberta line and keeps Alberta's clock.
    expect(resolveZone('CA', -110.01, 53.28)?.approximate).toBe(true);
    // Lismore is 30 km south of the Queensland box.
    expect(resolveZone('AU', 153.29, -28.8)?.approximate).toBe(true);
    // Nashville and Indianapolis are 25 and 30 km from the same meridian, on
    // opposite sides of it, and Indiana really does have counties on both.
    expect(resolveZone('US', -86.78, 36.16)?.approximate).toBe(true);
    expect(resolveZone('US', -86.15, 39.77)?.approximate).toBe(true);
    // A fix in the eastern Aleutians, 65 km from where Adak's clock begins.
    expect(resolveZone('US', -168.5, 53.87)?.approximate).toBe(true);
    // …all of which are still the RIGHT answer. Hedged is not wrong.
    expect(zoneFor('US', -87.63, 41.88)).toBe('America/Chicago');
    expect(zoneFor('CA', -110.01, 53.28)).toBe('America/Edmonton');
    expect(zoneFor('AU', 153.29, -28.8)).toBe('Australia/Sydney');
    expect(zoneFor('US', -86.78, 36.16)).toBe('America/Chicago');
    expect(zoneFor('US', -86.15, 39.77)).toBe('America/New_York');
  });

  it('does not hedge a boundary that both sides agree about', () => {
    // Kodiak is 24 km west of the meridian that separates Alaska from Hawaii,
    // and it is NOT hedged: that meridian only decides anything below the 30th
    // parallel, where Hawaii is. A margin that fired on every nearby line
    // rather than on every nearby CHANGE would mark this one for nothing.
    expect(resolveZone('US', -152.41, 57.79)).toEqual({
      zone: 'America/Anchorage', approximate: false,
    });
    // Denver is 8 km from the meridian that carves west Texas out of the
    // Mountain band, and Mountain is what lies on both sides of it up here.
    expect(resolveZone('US', -104.99, 39.74)).toEqual({
      zone: 'America/Denver', approximate: false,
    });
  });

  it('measures the margin in kilometres and not in degrees', () => {
    // The same 1.5° from a band boundary is 72 km of ground at Nome and 156 km
    // at the latitude of Hawaii. A margin in degrees would hedge one of these
    // and wave the other through on nothing but the shape of the planet.
    expect(MARGIN_KM).toBe(150);
    expect(resolveZone('US', -168.0, 64.5)?.approximate).toBe(true);
    expect(resolveZone('US', -153.5, 20.0)?.approximate).toBe(false);
  });

  it('answers null for a code it does not know, exactly as zoneFor does', () => {
    expect(resolveZone(undefined)).toBeNull();
    expect(resolveZone('')).toBeNull();
    expect(resolveZone('ZZ')).toBeNull();
    expect(resolveZone('ZZ', 12, 34)).toBeNull();
    expect(resolveZone('AQ')).toBeNull();
  });

  it('cannot be answered by the prototype', () => {
    for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(resolveZone(key), key).toBeNull();
      expect(zoneFor(key), key).toBeNull();
      expect(zoneFor(key, 10, 10), key).toBeNull();
      expect(isSplit(key), key).toBe(false);
    }
  });

  it('agrees with zoneFor on every argument shape', () => {
    const probes: [string | undefined, number?, number?][] = [
      ['US', -118.24, 34.05], ['US', -157.86, 21.31], ['US', 172.9, 52.9], ['US'],
      ['RU', -175.29, 65.69], ['RU', 53.21, 56.85], ['RU'], ['CA', -68.33, 47.37],
      ['AU', 153.03, -27.47], ['CL', -70.92, -53.16], ['GL', -21.97, 70.48],
      ['FR'], ['FR', 2.35, 48.86], ['XK'], ['ZZ'], [undefined], [''], ['AQ'],
      ['constructor'], ['ES', -15.43], ['PT', -25.67, 37.74], ['KI', -157.4, 1.87],
      // every exception box, and a fix just outside each of them
      ['US', -112.07, 33.45], ['US', -112.07, 40.0], ['US', -113.0, 36.2],
      ['CA', -104.61, 50.44], ['CA', -104.61, 61.0], ['MX', -106.49, 31.74],
      ['MX', -106.49, 30.0], ['AU', 130.84, -12.46], ['AU', 130.84, -30.0],
      ['AU', 139.49, -20.72], ['AU', 153.03, -27.47], ['AU', 159.08, -31.55],
      ['AU', 159.08, -35.0], ['BR', -51.23, -30.03], ['BR', -54.65, -20.44],
    ];
    for (const [cc, lon, lat] of probes) {
      expect(resolveZone(cc, lon, lat)?.zone ?? null, `${cc} ${lon} ${lat}`)
        .toBe(zoneFor(cc, lon, lat));
    }
  });

  it('marks exactly the countries isSplit names', () => {
    for (const cc of Object.keys(COUNTRY_ZONE)) {
      const r = resolveZone(cc);
      expect(r, cc).not.toBeNull();
      expect(r!.approximate, cc).toBe(isSplit(cc));
    }
  });
});

describe('the states that refuse to move their clocks', () => {
  it('keeps Arizona on -7 in July, which is the eight-months-wrong case', () => {
    const phoenix = resolveZone('US', -112.07, 33.45);
    expect(phoenix).toEqual({ zone: 'America/Phoenix', approximate: false });
    // The whole point: Arizona does not move, and the Mountain band around it
    // does. Read as Denver this is -360 in July and an hour off the wall.
    expect(offsetMinutes(phoenix!.zone, JAN)).toBe(-420);
    expect(offsetMinutes(phoenix!.zone, JUL)).toBe(-420);
    expect(offsetMinutes('America/Denver', JUL)).toBe(-360);
    for (const [lat, lon] of [[32.22, -110.97], [35.2, -111.65], [34.54, -112.48]] as const) {
      const r = resolveZone('US', lon, lat);
      expect(r!.zone, `${lat},${lon}`).toBe('America/Phoenix');
      expect(r!.approximate, `${lat},${lon}`).toBe(false);
    }
  });

  it('leaves the Navajo Nation outside the Arizona box, because it does move', () => {
    // Window Rock and Kayenta observe daylight saving; the box stops short of
    // them and the Denver band, which is right about them, takes over.
    const windowRock = resolveZone('US', -109.06, 35.68);
    expect(windowRock!.zone).toBe('America/Denver');
    expect(offsetMinutes(windowRock!.zone, JUL)).toBe(-360);
    // The Hopi Reservation inside it does NOT move, so the answer up here is
    // marked approximate rather than printed as measured.
    expect(windowRock!.approximate).toBe(true);
    // Just north of the box is Utah, which is Mountain and moves.
    expect(zoneFor('US', -111.89, 40.76)).toBe('America/Denver');
    expect(zoneFor('US', -113.61, 37.08)).toBe('America/Denver');
  });

  it('keeps Saskatchewan on -6 all year between two provinces that move', () => {
    const regina = resolveZone('CA', -104.61, 50.44);
    expect(regina).toEqual({ zone: 'America/Regina', approximate: false });
    expect(offsetMinutes(regina!.zone, JAN)).toBe(-360);
    expect(offsetMinutes(regina!.zone, JUL)).toBe(-360);
    // Including the corners the margin alone would have hedged.
    expect(resolveZone('CA', -109.16, 51.48)).toEqual({ zone: 'America/Regina', approximate: false });
    expect(resolveZone('CA', -102.98, 49.13)).toEqual({ zone: 'America/Regina', approximate: false });
    expect(resolveZone('CA', -106.66, 52.13)?.approximate).toBe(false);
    // Outside it: Lloydminster keeps Alberta's clock and Manitoba keeps its own.
    expect(zoneFor('CA', -110.01, 53.28)).toBe('America/Edmonton');
    expect(zoneFor('CA', -97.14, 49.9)).toBe('America/Winnipeg');
  });

  it('keeps the Northern Territory and Queensland off summer time', () => {
    const darwin = resolveZone('AU', 130.84, -12.46);
    expect(darwin).toEqual({ zone: 'Australia/Darwin', approximate: false });
    expect(offsetMinutes(darwin!.zone, JAN)).toBe(570);
    expect(offsetMinutes(darwin!.zone, JUL)).toBe(570);
    expect(resolveZone('AU', 133.88, -23.7)).toEqual({ zone: 'Australia/Darwin', approximate: false });

    const brisbane = resolveZone('AU', 153.03, -27.47);
    expect(brisbane).toEqual({ zone: 'Australia/Brisbane', approximate: false });
    expect(offsetMinutes(brisbane!.zone, JAN)).toBe(600);
    expect(offsetMinutes(brisbane!.zone, JUL)).toBe(600);
    // Mount Isa is 1 500 km west of Brisbane and keeps its clock; it sits
    // BESIDE the Northern Territory, which no band could ever have said.
    expect(resolveZone('AU', 139.49, -20.72)).toEqual({
      zone: 'Australia/Brisbane', approximate: false,
    });
    expect(resolveZone('AU', 145.77, -16.92)?.zone).toBe('Australia/Brisbane');
    // Outside the boxes, the neighbours that do move.
    expect(zoneFor('AU', 138.6, -34.93)).toBe('Australia/Adelaide');
    expect(offsetMinutes('Australia/Adelaide', JAN)).toBe(630);
    expect(zoneFor('AU', 151.21, -33.87)).toBe('Australia/Sydney');
    expect(offsetMinutes('Australia/Sydney', JAN)).toBe(660);
  });

  it('gives Lord Howe Island its half hour', () => {
    const lh = resolveZone('AU', 159.08, -31.55);
    expect(lh).toEqual({ zone: 'Australia/Lord_Howe', approximate: false });
    // +11 in the southern summer and +10:30 in the winter: the only clock in
    // the world that moves by half an hour.
    expect(offsetMinutes(lh!.zone, JAN)).toBe(660);
    expect(offsetMinutes(lh!.zone, JUL)).toBe(630);
    // The sea around it is New South Wales.
    expect(zoneFor('AU', 159.08, -33.0)).toBe('Australia/Sydney');
  });

  it('gives Ciudad Juarez the daylight saving the rest of Mexico gave up', () => {
    const juarez = resolveZone('MX', -106.49, 31.74);
    expect(juarez).toEqual({ zone: 'America/Ciudad_Juarez', approximate: false });
    expect(offsetMinutes(juarez!.zone, JAN)).toBe(-420);
    expect(offsetMinutes(juarez!.zone, JUL)).toBe(-360);
    // Chihuahua, 350 km south of it, abandoned daylight saving in 2022.
    const chihuahua = resolveZone('MX', -106.08, 28.63);
    expect(offsetMinutes(chihuahua!.zone, JAN)).toBe(-360);
    expect(offsetMinutes(chihuahua!.zone, JUL)).toBe(-360);
  });

  it('checks a box before it checks a band', () => {
    // Every one of these sits inside a band whose own zone is something else.
    // The box is what makes them right, so the order is load-bearing.
    expect(zoneFor('US', -112.07, 33.45)).toBe('America/Phoenix');
    expect(zoneFor('AU', 139.49, -20.72)).toBe('Australia/Brisbane');
    expect(zoneFor('MX', -106.49, 31.74)).toBe('America/Ciudad_Juarez');
    // A box only answers a full fix. With a longitude alone the bands run.
    expect(zoneFor('US', -112.07)).toBe('America/Denver');
    expect(zoneFor('AU', 139.49)).toBe('Australia/Adelaide');
  });
});

describe('the two big directories of fixes: Mexico and Brazil', () => {
  it('walks Mexico from Tijuana to Cancun', () => {
    const at = (lon: number, lat: number) => zoneFor('MX', lon, lat)!;
    expect(offsetMinutes(at(-117.02, 32.53), JAN)).toBe(-480); // Tijuana, which moves
    expect(offsetMinutes(at(-117.02, 32.53), JUL)).toBe(-420);
    expect(offsetMinutes(at(-110.97, 29.07), JAN)).toBe(-420); // Hermosillo
    expect(offsetMinutes(at(-107.39, 24.8), JAN)).toBe(-420);  // Culiacan
    expect(offsetMinutes(at(-106.41, 23.25), JAN)).toBe(-420); // Mazatlan
    expect(offsetMinutes(at(-106.08, 28.63), JAN)).toBe(-360); // Chihuahua
    expect(offsetMinutes(at(-99.13, 19.43), JAN)).toBe(-360);  // Mexico City
    expect(offsetMinutes(at(-89.62, 20.97), JAN)).toBe(-360);  // Merida, Yucatan
    expect(offsetMinutes(at(-88.3, 18.5), JAN)).toBe(-300);    // Chetumal, Quintana Roo
    expect(offsetMinutes(at(-86.85, 21.16), JAN)).toBe(-300);  // Cancun
    // Nothing in Mexico moves its clocks except the border cities.
    expect(offsetMinutes(at(-99.13, 19.43), JUL)).toBe(-360);
    expect(offsetMinutes(at(-110.97, 29.07), JUL)).toBe(-420);
  });

  it('keeps southern Brazil on -3 all the way west to the Argentine border', () => {
    // Rio Grande do Sul reaches 57°W and keeps São Paulo's clock the whole way;
    // resolved on a single meridian at 50.5°W, its 55 stations read -4.
    const at = (lon: number, lat: number) => zoneFor('BR', lon, lat)!;
    for (const [lat, lon, name] of [
      [-30.03, -51.23, 'Porto Alegre'],
      [-29.75, -57.09, 'Uruguaiana'],
      [-28.39, -53.9, 'Ijui'],
      [-27.1, -52.62, 'Chapeco'],
      [-24.96, -53.46, 'Cascavel'],
      [-25.52, -54.58, 'Foz do Iguacu'],
      [-23.43, -51.96, 'Maringa'],
      [-22.12, -51.39, 'Presidente Prudente'],
    ] as const) {
      expect(offsetMinutes(at(lon, lat), JAN), name).toBe(-180);
      expect(offsetMinutes(at(lon, lat), JUL), name).toBe(-180);
    }
    // …and Mato Grosso do Sul, on the other bank of the same river, is -4.
    for (const [lat, lon, name] of [
      [-20.44, -54.65, 'Campo Grande'],
      [-22.22, -54.81, 'Dourados'],
      [-20.75, -51.68, 'Tres Lagoas'],
      [-15.6, -56.1, 'Cuiaba'],
      [-3.12, -60.02, 'Manaus'],
    ] as const) {
      expect(offsetMinutes(at(lon, lat), JAN), name).toBe(-240);
    }
    expect(offsetMinutes(at(-67.81, -9.97), JAN)).toBe(-300); // Rio Branco
    expect(offsetMinutes(at(-34.88, -8.05), JAN)).toBe(-180); // Recife
  });
});

describe('the two-argument callers keep working', () => {
  it('answers a longitude-only lookup as it always did', () => {
    // The register learned a centroid before it learned latitudes, and every
    // call site that predates the parameter still passes two arguments.
    expect(zoneFor('US', -118.24)).toBe('America/Los_Angeles');
    expect(zoneFor('US', -74.0)).toBe('America/New_York');
    expect(zoneFor('ES', -15.43)).toBe('Atlantic/Canary');
    expect(zoneFor('RU', 37.62)).toBe('Europe/Moscow');
    expect(zoneFor('BR', -46.63)).toBe('America/Sao_Paulo');
    // A band with a latitude ladder answers with the band's own zone, which is
    // the clock most of the band keeps.
    expect(zoneFor('US', -157.86)).toBe('Pacific/Honolulu');
    expect(zoneFor('AU', 151.21)).toBe('Australia/Sydney');
    expect(zoneFor('CA', -63.58)).toBe('America/Halifax');
  });
});

// ---------------------------------------------------------------------------
// The anti-staleness pin
// ---------------------------------------------------------------------------

/**
 * Every authored zone, checked against the platform's own idea of which
 * country files it.
 *
 * Both sides are canonicalised before comparing, and that is not belt and
 * braces — it is required for the test to pass on correct data. Node 20 answers
 * `Asia/Calcutta` where the table says `Asia/Kolkata`, `Europe/Kiev` for
 * `Europe/Kyiv` and `America/Godthab` for `America/Nuuk`.
 *
 * The capability itself is feature-detected and the test SKIPS when it is
 * absent. `Intl.Locale.prototype.timeZones` is a getter in Node 20; the
 * specification moved it to a `getTimeZones()` method, so a future runtime may
 * carry one, the other, or — for a build without full ICU — neither. A missing
 * platform table is no evidence against this one.
 */
function zonesOf(cc: string): string[] | null {
  const anyLocale = Intl.Locale.prototype as unknown as {
    getTimeZones?: () => string[] | undefined;
    timeZones?: string[];
  };
  const hasMethod = typeof anyLocale.getTimeZones === 'function';
  const hasGetter = 'timeZones' in anyLocale;
  if (!hasMethod && !hasGetter) return null;
  let locale: Intl.Locale;
  try {
    locale = new Intl.Locale(`und-${cc}`);
  } catch {
    return null;
  }
  const held = locale as unknown as { getTimeZones?: () => string[] | undefined; timeZones?: string[] };
  const list = hasMethod ? held.getTimeZones?.() : held.timeZones;
  return Array.isArray(list) ? list : null;
}

function canonical(zone: string): string {
  return new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone;
}

describe('the authored half cannot rot silently', () => {
  it('files every COUNTRY_ZONE entry under the country the platform does', () => {
    const probe = zonesOf('ES');
    if (!probe) {
      // No platform table to check against. Not a failure — see above.
      expect(Object.keys(COUNTRY_ZONE).length).toBeGreaterThan(200);
      return;
    }
    const wrong: string[] = [];
    for (const [cc, zone] of Object.entries(COUNTRY_ZONE)) {
      // `XK` is pinned by the test below instead: it is a user-assigned code,
      // not an ISO-3166-1 one, and CLDR files no zone under it to compare with.
      if (cc === 'XK') continue;
      const list = zonesOf(cc);
      if (!list) {
        wrong.push(`${cc}: the platform files no zone under this code at all`);
        continue;
      }
      if (!list.map(canonical).includes(canonical(zone))) {
        wrong.push(`${cc}: ${zone} is not one of ${list.join(', ')}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('pins Kosovo against Serbia, which is the only table there is', () => {
    // Node 20 answers `und-XK` with an EMPTY zone list rather than with no list
    // at all, so the loop above would read it as a rotted entry. What can be
    // checked is that the zone is one the platform knows, that it is the same
    // zone Serbia is filed under, and that it keeps the clock Kosovo keeps.
    expect(COUNTRY_ZONE.XK).toBe('Europe/Belgrade');
    expect(canonical(COUNTRY_ZONE.XK!)).toBe(canonical(COUNTRY_ZONE.RS!));
    expect(offsetMinutes(COUNTRY_ZONE.XK!, JAN)).toBe(60);
    expect(offsetMinutes(COUNTRY_ZONE.XK!, JUL)).toBe(120);
    // If a future platform DOES start filing zones under the code, this is
    // where the entry has to agree with it.
    const list = zonesOf('XK');
    if (list && list.length > 0) {
      expect(list.map(canonical)).toContain(canonical(COUNTRY_ZONE.XK!));
    }
  });

  it('files every SPLIT band and every latitude cut under the country it is of', () => {
    const probe = zonesOf('US');
    if (!probe) {
      expect(Object.keys(SPLIT).length).toBeGreaterThan(8);
      return;
    }
    const wrong: string[] = [];
    for (const [cc, bands] of Object.entries(SPLIT)) {
      const list = zonesOf(cc)?.map(canonical) ?? [];
      for (const band of bands) {
        if (!list.includes(canonical(band.zone))) {
          wrong.push(`${cc}: ${band.zone} is not a zone of ${cc}`);
        }
        for (const cut of band.cuts ?? []) {
          if (!list.includes(canonical(cut.zone))) {
            wrong.push(`${cc}: ${cut.zone} is not a zone of ${cc}`);
          }
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it('files every EXCEPTION box under the country it is a box in', () => {
    const probe = zonesOf('US');
    if (!probe) {
      expect(Object.keys(EXCEPTION).length).toBeGreaterThan(2);
      return;
    }
    const wrong: string[] = [];
    for (const [cc, boxes] of Object.entries(EXCEPTION)) {
      const list = zonesOf(cc)?.map(canonical) ?? [];
      for (const box of boxes) {
        if (!list.includes(canonical(box.zone))) {
          wrong.push(`${cc}: ${box.zone} is not a zone of ${cc}`);
        }
        if (offsetMinutes(box.zone, JAN) === null) {
          wrong.push(`${cc}: ${box.zone} has no offset the platform can compute`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it('gives every exception box corners, a country with bands, and no twin', () => {
    for (const [cc, boxes] of Object.entries(EXCEPTION)) {
      // A box is an exception to a ladder, so there has to be a ladder.
      expect(SPLIT[cc], cc).toBeTruthy();
      for (const box of boxes) {
        expect(box.north, `${cc} ${box.zone}`).toBeGreaterThan(box.south);
        expect(box.east, `${cc} ${box.zone}`).toBeGreaterThan(box.west);
        expect(Math.abs(box.south), `${cc} ${box.zone}`).toBeLessThanOrEqual(90);
        expect(Math.abs(box.north), `${cc} ${box.zone}`).toBeLessThanOrEqual(90);
        expect(Math.abs(box.west), `${cc} ${box.zone}`).toBeLessThanOrEqual(180);
        expect(Math.abs(box.east), `${cc} ${box.zone}`).toBeLessThanOrEqual(180);
      }
      // First match wins, so two boxes overlapping would hide one of them.
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i]!;
          const b = boxes[j]!;
          const overlaps = a.west < b.east && b.west < a.east
            && a.south < b.north && b.south < a.north;
          expect(overlaps, `${cc}: ${a.zone} overlaps ${b.zone}`).toBe(false);
        }
      }
    }
  });

  it('gives every zone it names an offset the platform can compute', () => {
    const dead: string[] = [];
    for (const zone of Object.values(COUNTRY_ZONE)) {
      if (offsetMinutes(zone, JAN) === null) dead.push(zone);
    }
    for (const bands of Object.values(SPLIT)) {
      for (const band of bands) {
        if (offsetMinutes(band.zone, JAN) === null) dead.push(band.zone);
        for (const cut of band.cuts ?? []) {
          if (offsetMinutes(cut.zone, JAN) === null) dead.push(cut.zone);
        }
      }
    }
    expect(dead).toEqual([]);
  });

  it('keeps the bands of every split country ordered west to east', () => {
    for (const [cc, bands] of Object.entries(SPLIT)) {
      for (let i = 1; i < bands.length; i++) {
        expect(bands[i]!.westOf, `${cc} band ${i}`).toBeGreaterThan(bands[i - 1]!.westOf);
      }
      // The last band has to catch everything, or a station east of the last
      // meridian would fall through to the whole-country zone silently.
      expect(bands[bands.length - 1]!.westOf, cc).toBe(Infinity);
      // …and every split country also has a whole-country answer.
      expect(COUNTRY_ZONE[cc], cc).toBeTruthy();
    }
  });

  it('keeps the latitude ladder of every band ordered south to north', () => {
    for (const [cc, bands] of Object.entries(SPLIT)) {
      for (const band of bands) {
        const cuts = band.cuts;
        if (!cuts) continue;
        const where = `${cc} band westOf ${band.westOf}`;
        expect(cuts.length, where).toBeGreaterThan(1);
        for (let i = 1; i < cuts.length; i++) {
          expect(cuts[i]!.southOf, `${where} cut ${i}`).toBeGreaterThan(cuts[i - 1]!.southOf);
        }
        // The last rung catches everything north of the others, the same way
        // the last band catches everything east of the others.
        expect(cuts[cuts.length - 1]!.southOf, where).toBe(Infinity);
        // The band's own zone is the answer when no latitude was given, so it
        // has to be one of the answers the ladder itself can produce.
        expect(cuts.map((c) => c.zone), where).toContain(band.zone);
      }
    }
  });

  it('gives every wrapped country a ladder that fits inside its own frame', () => {
    for (const cc of Object.keys(BAND_ORIGIN)) {
      // An origin without bands would be a meridian that moves nothing.
      expect(SPLIT[cc], cc).toBeTruthy();
    }
    for (const [cc, bands] of Object.entries(SPLIT)) {
      const origin = BAND_ORIGIN[cc] ?? -180;
      for (const band of bands) {
        if (!Number.isFinite(band.westOf)) continue;
        expect(band.westOf, `${cc} ${band.westOf}`).toBeGreaterThan(origin);
        expect(band.westOf, `${cc} ${band.westOf}`).toBeLessThan(origin + 360);
      }
    }
  });

  it('lands every longitude on this planet in some band of every split country', () => {
    // A gap in a ladder is a station that silently falls through to the
    // whole-country answer while still being reported as a positional fix.
    const reached = new Set<string>();
    for (const cc of Object.keys(SPLIT)) {
      for (let lon = -180; lon <= 180; lon += 0.5) {
        for (const lat of [-80, -26, 0, 37, 65]) {
          const zone = zoneFor(cc, lon, lat);
          expect(zone, `${cc} ${lon} ${lat}`).toBeTruthy();
          reached.add(zone!);
        }
      }
    }
    for (const zone of reached) {
      expect(offsetMinutes(zone, JAN), zone).not.toBeNull();
    }
  });
});
