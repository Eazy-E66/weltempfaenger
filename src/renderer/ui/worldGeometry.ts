/**
 * The GMT world map printed on the lid.
 *
 * Coastlines are stored as flat [lon, lat, lon, lat, …] rings in plain degrees
 * and projected equirectangularly, which is what the real lid uses — and the
 * reason it is worth keeping: a station's `geo` drops onto the map with two
 * multiplications and no projection library, and the timezone strip along the
 * top and bottom edges lines up with the meridians exactly.
 *
 * The outlines are deliberately coarse. This is line-art screen-printed on a
 * plastic lid, not a cartographic product; every vertex here is one a pad
 * printer could actually hold.
 */

export interface Ring {
  name: string;
  /** [lon, lat, …] */
  pts: number[];
  closed: boolean;
}

export const COASTLINES: Ring[] = [
  {
    name: 'north-america',
    closed: true,
    pts: [
      -168, 65, -165, 60, -158, 57, -152, 58, -148, 60, -140, 60, -135, 57, -130, 54, -125, 49,
      -124, 43, -121, 37, -117, 33, -114, 29, -110, 24, -106, 23, -105, 19, -101, 16, -95, 16,
      -92, 15, -88, 16, -84, 10, -79, 9, -83, 15, -87, 21, -90, 21, -94, 18, -97, 22, -97, 26,
      -94, 29, -89, 29, -85, 30, -82, 25, -80, 27, -81, 32, -76, 35, -74, 40, -70, 42, -67, 45,
      -64, 46, -60, 47, -56, 52, -64, 57, -78, 53, -80, 51, -83, 55, -88, 57, -94, 59, -95, 68,
      -105, 68, -115, 70, -125, 70, -131, 70, -141, 70, -156, 71, -166, 68,
    ],
  },
  {
    name: 'greenland',
    closed: true,
    pts: [
      -45, 60, -52, 64, -53, 68, -58, 70, -55, 74, -60, 76, -65, 78, -60, 81, -45, 83, -30, 83,
      -20, 80, -22, 75, -28, 70, -38, 66, -42, 62,
    ],
  },
  {
    name: 'south-america',
    closed: true,
    pts: [
      -81, 0, -79, -5, -76, -14, -71, -18, -70, -23, -71, -30, -73, -37, -75, -45, -74, -52,
      -68, -55, -65, -55, -63, -49, -62, -41, -57, -38, -56, -34, -48, -28, -40, -22, -39, -13,
      -35, -8, -44, -2, -50, 0, -52, 5, -60, 8, -66, 11, -72, 12, -77, 8, -79, 9, -81, 4,
    ],
  },
  {
    name: 'africa',
    closed: true,
    pts: [
      -17, 15, -16, 20, -12, 28, -9, 32, -5, 36, 3, 37, 10, 37, 11, 33, 20, 32, 25, 32, 32, 31,
      35, 28, 38, 22, 39, 15, 43, 12, 51, 12, 48, 5, 42, -1, 40, -8, 40, -15, 35, -20, 33, -26,
      28, -32, 20, -35, 18, -34, 15, -27, 12, -18, 13, -12, 9, -1, 9, 4, 4, 6, -4, 5, -8, 4,
      -13, 9,
    ],
  },
  {
    name: 'eurasia',
    closed: true,
    pts: [
      -9, 37, -9, 43, -2, 43, -1, 46, -4, 48, 0, 49, 4, 52, 8, 54, 10, 57, 13, 55, 19, 54,
      21, 56, 24, 57, 28, 60, 23, 65, 21, 70, 28, 71, 33, 70, 40, 66, 50, 69, 60, 70, 70, 72,
      80, 74, 90, 76, 100, 77, 110, 74, 120, 73, 130, 71, 140, 72, 150, 70, 160, 70, 170, 69,
      180, 66, 170, 60, 163, 58, 155, 57, 162, 54, 156, 51, 148, 45, 142, 48, 137, 54, 140, 51,
      131, 43, 127, 38, 122, 40, 119, 39, 121, 32, 118, 25, 110, 21, 106, 20, 108, 11, 104, 9,
      100, 13, 98, 8, 95, 16, 90, 22, 85, 20, 80, 15, 77, 8, 73, 15, 70, 22, 66, 25, 61, 25,
      57, 25, 56, 27, 51, 30, 48, 30, 44, 29, 43, 13, 40, 20, 35, 28, 34, 31, 36, 36, 30, 36,
      26, 40, 23, 40, 20, 42, 16, 41, 18, 40, 16, 38, 15, 38, 12, 45, 13, 45, 10, 44, 7, 44,
      3, 42, -3, 37, -6, 36,
    ],
  },
  {
    name: 'britain',
    closed: true,
    pts: [-5, 50, -3, 54, -5, 58, -2, 58, 0, 54, 1, 51],
  },
  { name: 'ireland', closed: true, pts: [-10, 52, -6, 55, -6, 52] },
  { name: 'iceland', closed: true, pts: [-24, 65, -22, 66, -14, 66, -14, 64, -21, 63] },
  {
    name: 'japan',
    closed: true,
    pts: [130, 31, 132, 34, 136, 35, 139, 35, 141, 39, 141, 45, 145, 44, 140, 41, 138, 37, 135, 34, 131, 33],
  },
  {
    name: 'australia',
    closed: true,
    pts: [
      114, -22, 113, -26, 115, -34, 118, -35, 123, -34, 129, -32, 134, -33, 138, -35, 141, -38,
      146, -39, 150, -37, 153, -31, 153, -25, 146, -19, 142, -11, 136, -12, 130, -11, 128, -15,
      122, -17, 117, -21,
    ],
  },
  { name: 'tasmania', closed: true, pts: [145, -41, 148, -41, 148, -43, 145, -43] },
  {
    name: 'new-zealand',
    closed: false,
    pts: [173, -35, 178, -38, 177, -40, 174, -41, 171, -44, 167, -46, 170, -44, 172, -41],
  },
  { name: 'madagascar', closed: true, pts: [49, -12, 50, -16, 47, -25, 45, -25, 43, -21, 44, -16] },
  { name: 'sri-lanka', closed: true, pts: [80, 9, 82, 8, 81, 6, 80, 7] },
  { name: 'cuba', closed: true, pts: [-85, 22, -80, 23, -75, 20, -80, 21] },
  { name: 'sumatra', closed: true, pts: [95, 5, 98, 2, 103, -2, 106, -6, 103, -5, 100, 0, 96, 4] },
  { name: 'java', closed: true, pts: [105, -6, 111, -7, 114, -8, 114, -7, 111, -6, 106, -5] },
  { name: 'borneo', closed: true, pts: [109, 2, 117, 4, 119, -1, 116, -4, 110, -3] },
  {
    name: 'new-guinea',
    closed: true,
    pts: [131, -1, 141, -3, 147, -6, 150, -10, 143, -9, 137, -8, 132, -5],
  },
  { name: 'philippines', closed: true, pts: [121, 18, 124, 13, 126, 8, 122, 6, 120, 12] },
  {
    name: 'antarctica',
    closed: false,
    pts: [
      -180, -71, -160, -74, -140, -73, -120, -73, -100, -73, -80, -70, -62, -64, -58, -63,
      -45, -70, -30, -71, -10, -70, 5, -69, 20, -69, 35, -67, 50, -66, 65, -66, 80, -66,
      95, -66, 110, -66, 125, -66, 140, -66, 155, -70, 165, -77, 180, -78,
    ],
  },
];

export interface City {
  name: string;
  lon: number;
  lat: number;
  /** Label side, so labels do not run off the edges or collide. */
  side?: 'l' | 'r';
}

/** The named cities from the reference lid, plus enough others to fill it. */
export const CITIES: City[] = [
  { name: 'ANCHORAGE', lon: -150, lat: 61, side: 'r' },
  { name: 'VANCOUVER', lon: -123, lat: 49, side: 'l' },
  { name: 'SAN FRANCISCO', lon: -122, lat: 38, side: 'l' },
  { name: 'LOS ANGELES', lon: -118, lat: 34, side: 'l' },
  { name: 'MEXICO CITY', lon: -99, lat: 19, side: 'l' },
  { name: 'CHICAGO', lon: -88, lat: 42, side: 'r' },
  { name: 'NEW YORK', lon: -74, lat: 41, side: 'r' },
  { name: 'HONOLULU', lon: -158, lat: 21, side: 'r' },
  { name: 'BUENOS AIRES', lon: -58, lat: -35, side: 'r' },
  { name: 'SANTIAGO DE CHILE', lon: -71, lat: -33, side: 'l' },
  { name: 'RIO DE JANEIRO', lon: -43, lat: -23, side: 'r' },
  { name: 'REYKJAVIK', lon: -22, lat: 64, side: 'r' },
  { name: 'DAKAR', lon: -17, lat: 15, side: 'l' },
  { name: 'LISBON', lon: -9, lat: 39, side: 'l' },
  { name: 'LONDON', lon: 0, lat: 52, side: 'l' },
  { name: 'PARIS', lon: 2, lat: 49, side: 'r' },
  { name: 'BERLIN', lon: 13, lat: 53, side: 'r' },
  { name: 'ROME', lon: 12, lat: 42, side: 'r' },
  { name: 'JOHANNESBURG', lon: 28, lat: -26, side: 'r' },
  { name: 'CAIRO', lon: 31, lat: 30, side: 'r' },
  { name: 'NAIROBI', lon: 37, lat: -1, side: 'r' },
  { name: 'MOSCOW', lon: 38, lat: 56, side: 'r' },
  { name: 'TEHRAN', lon: 51, lat: 36, side: 'r' },
  { name: 'DELHI', lon: 77, lat: 29, side: 'l' },
  { name: 'SINGAPORE', lon: 104, lat: 1, side: 'l' },
  { name: 'JAKARTA', lon: 107, lat: -6, side: 'l' },
  { name: 'HONG KONG', lon: 114, lat: 22, side: 'r' },
  { name: 'PERTH', lon: 116, lat: -32, side: 'l' },
  { name: 'MANILA', lon: 121, lat: 15, side: 'r' },
  { name: 'PEKING', lon: 116, lat: 40, side: 'l' },
  { name: 'TOKYO', lon: 140, lat: 36, side: 'r' },
  { name: 'SYDNEY', lon: 151, lat: -34, side: 'r' },
  { name: 'AUCKLAND', lon: 175, lat: -37, side: 'l' },
];

/** Boxed numerals along the top and bottom edges: -11 … GMT … +12. */
export const TIMEZONES: { label: string; offset: number }[] = (() => {
  const out: { label: string; offset: number }[] = [];
  for (let n = -11; n <= 12; n++) {
    out.push({ label: n === 0 ? 'GMT' : n > 0 ? `+${n}` : String(n), offset: n });
  }
  return out;
})();

/** Printed reference matter, exactly as screen-printed on the real lid. */
export const METER_BANDS = ['120m', '90m', '75m', '60m', '49m', '41m', '31m', '25m', '19m', '16m', '13m', '11m'];

/** lon → 0..1 across the map. */
export function lonToX(lon: number): number {
  return (lon + 180) / 360;
}

/** lat → 0..1 down the map. The lid map is cropped to ±80°, as printed lids are. */
export function latToY(lat: number, latMax = 80): number {
  return (latMax - lat) / (latMax * 2);
}
