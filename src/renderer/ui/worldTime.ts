/**
 * WHAT TIME IT IS WHERE THE STATION TRANSMITS FROM.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS AND WHY IT IS NOT A CIRCLE OF THE ATLAS PROHIBITION
 *
 * The only offset arithmetic that existed in this repo before it was
 * `Math.round(lon / 15)` on the register's density dot. That expression is
 * wrong for the countries with the most stations in the directory:
 *
 *   · Spain sits at 3.7°W and reads GMT. Madrid keeps Central European time.
 *   · India's +5:30 cannot be expressed by it at all, nor Iran's +3:30, nor
 *     Nepal's +5:45, nor Chatham's +12:45.
 *   · It knows nothing of daylight saving, so every European station is an
 *     hour out for half the year and every North American one for eight
 *     months of it.
 *
 * Putting that number inside a LIT BOX on the plate would be a Law 2 defect
 * with a spotlight on it, so the number is computed rather than guessed.
 *
 * `register.ts:329-336` forbids an authored atlas of country COORDINATES, and
 * that prohibition stands: the directory already publishes coordinates, so an
 * authored table there would substitute a stale guess for a live measurement.
 * The directory publishes **no timezone at all**, in any field — there is
 * nothing here to substitute. And the table below is only the half that does
 * not move: "Spain keeps Madrid's clock" is a political fact that changes
 * roughly never. The half that DOES move — daylight saving, Mexico's 2022
 * abolition, Kazakhstan's 2024 unification — is read at runtime out of the
 * platform's own tz database, so it arrives with a Chromium update rather than
 * with one of ours. `worldTime.test.ts` pins every entry against `Intl` so the
 * stable half cannot rot silently either.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT WILL NOT DO
 *
 * A country code, a longitude and a latitude are the whole of the evidence.
 * That is enough for a representative clock and it is NOT enough for a postal
 * one, so:
 *
 *   · A code with no entry returns `null`. It never returns a plausible
 *     neighbour. Antarctica (`AQ`) is deliberately unlisted for exactly this
 *     reason — it has ten zones and no representative clock, and picking one
 *     would be a guess wearing a fact's clothes.
 *   · The countries in `SPLIT` are resolved by the station's own position,
 *     which is honest to about a state line and no closer. The known misses
 *     are named at `SPLIT` itself.
 *
 * ---------------------------------------------------------------------------
 * SAYING WHICH KIND OF ANSWER IT IS
 *
 * `resolveZone()` returns the zone AND whether it was reached by guessing.
 * That distinction is the whole of Law 2 here, and it is worth only as much as
 * it is rare: a mark that appears on a third of the directory says nothing at
 * all. So the rule is to be RIGHT first and to hedge only what cannot be
 * known. An answer is EXACT when
 *
 *   · the country has one zone — `SE` → `Europe/Stockholm` needs no position,
 *     and 47,689 of the 62,038 stations in the directory publish none; or
 *   · the fix is inside an `EXCEPTION` box, which is a named political
 *     rectangle rather than a guess about where a line runs; or
 *   · the fix is further than `MARGIN_KM` from every boundary that would
 *     change the answer — far enough that no plausible error in an authored
 *     meridian could put it on the other side.
 *
 * And it is APPROXIMATE when the country has more than one zone and either no
 * usable position arrived with it — the most populous zone then stands in for
 * the rest — or the fix sits close enough to a boundary that which side it is
 * on is a guess. Those are the ones the plate dims and marks; everything else
 * it may print as measured. `isSplit()` remains for callers that only need the
 * question, not the answer.
 *
 * ---------------------------------------------------------------------------
 * HOW OFTEN THE HEDGE IS ACTUALLY ON SCREEN — MEASURED ON ROWS, NOT ON THE FEED
 *
 * "Rare" has to be counted where the listener is, and a directory-wide
 * percentage is not that: the register opens on LISTENERS, which is the most
 * clicked stations in the world, and those are not a uniform sample of the
 * feed. Hovered with the real handlers over 62 consecutive rows in each view,
 * on the live directory:
 *
 *   | view              | origin placed | dashed = country average | `≈` clock |
 *   |-------------------|---------------|--------------------------|-----------|
 *   | LISTENERS         | 95%           | 82%                      | 27%       |
 *   | A–Z               | 98%           | 66%                      | 11%       |
 *
 * The `≈` is rare enough to mean something — a quarter of the busiest rows,
 * a ninth alphabetically. The DASHED RING is not rare at all, and it is not
 * supposed to be: most stations in this feed publish a country and no position,
 * so most marks honestly are country averages. The two marks answer different
 * questions and only the clock's needed hedging down.
 *
 * A published fix that the register believes is never hedged: 0% of them, which
 * is the number this whole file exists to protect.
 */

/** The printed strip runs -11 … GMT … +12. Nothing outside it has a cell. */
export const STRIP_MIN_HOUR = -11;
export const STRIP_MAX_HOUR = 12;

/**
 * ISO-3166-1 alpha-2 → one representative IANA zone.
 *
 * Every current ISO-3166-1 code the platform files a zone under, which is all
 * 249 of them but `AQ` (see above) and `BV`/`HM`, which are uninhabited and
 * which ICU itself lists no zone for. Multi-zone countries carry their most
 * populous zone here and are ALSO listed in `SPLIT`, so a lookup with a
 * position is refined and a lookup without one still answers.
 *
 * `XK` is the one entry the platform cannot confirm: Kosovo has no ISO-3166-1
 * assignment, CLDR files no zone under the user-assigned code the directory
 * uses for its 18 Kosovan stations, and the alternative is 18 stations dark
 * forever. Kosovo keeps Belgrade's clock — the same CET/CEST as every one of
 * its neighbours — so `Europe/Belgrade` is the honest answer and the test pins
 * it against `RS` instead of against a table that does not list it.
 *
 * Names are the modern IANA spellings. Node 20 answers several of them with
 * their pre-2022 aliases — `Asia/Calcutta` for `Asia/Kolkata`, `Europe/Kiev`
 * for `Europe/Kyiv`, `America/Godthab` for `America/Nuuk` — which is why the
 * test canonicalises BOTH sides before comparing.
 */
export const COUNTRY_ZONE: Readonly<Record<string, string>> = {
  AD: 'Europe/Andorra', AE: 'Asia/Dubai', AF: 'Asia/Kabul',
  AG: 'America/Antigua', AI: 'America/Anguilla', AL: 'Europe/Tirane',
  AM: 'Asia/Yerevan', AO: 'Africa/Luanda', AR: 'America/Argentina/Buenos_Aires',
  AS: 'Pacific/Pago_Pago', AT: 'Europe/Vienna', AU: 'Australia/Sydney',
  AW: 'America/Aruba', AX: 'Europe/Mariehamn', AZ: 'Asia/Baku',
  BA: 'Europe/Sarajevo', BB: 'America/Barbados', BD: 'Asia/Dhaka',
  BE: 'Europe/Brussels', BF: 'Africa/Ouagadougou', BG: 'Europe/Sofia',
  BH: 'Asia/Bahrain', BI: 'Africa/Bujumbura', BJ: 'Africa/Porto-Novo',
  BL: 'America/St_Barthelemy', BM: 'Atlantic/Bermuda', BN: 'Asia/Brunei',
  BO: 'America/La_Paz', BQ: 'America/Kralendijk', BR: 'America/Sao_Paulo',
  BS: 'America/Nassau', BT: 'Asia/Thimphu', BW: 'Africa/Gaborone',
  BY: 'Europe/Minsk', BZ: 'America/Belize', CA: 'America/Toronto',
  CC: 'Indian/Cocos', CD: 'Africa/Kinshasa', CF: 'Africa/Bangui',
  CG: 'Africa/Brazzaville', CH: 'Europe/Zurich', CI: 'Africa/Abidjan',
  CK: 'Pacific/Rarotonga', CL: 'America/Santiago', CM: 'Africa/Douala',
  CN: 'Asia/Shanghai', CO: 'America/Bogota', CR: 'America/Costa_Rica',
  CU: 'America/Havana', CV: 'Atlantic/Cape_Verde', CW: 'America/Curacao',
  CX: 'Indian/Christmas', CY: 'Asia/Nicosia', CZ: 'Europe/Prague',
  DE: 'Europe/Berlin', DJ: 'Africa/Djibouti', DK: 'Europe/Copenhagen',
  DM: 'America/Dominica', DO: 'America/Santo_Domingo', DZ: 'Africa/Algiers',
  EC: 'America/Guayaquil', EE: 'Europe/Tallinn', EG: 'Africa/Cairo',
  EH: 'Africa/El_Aaiun', ER: 'Africa/Asmara', ES: 'Europe/Madrid',
  ET: 'Africa/Addis_Ababa', FI: 'Europe/Helsinki', FJ: 'Pacific/Fiji',
  FK: 'Atlantic/Stanley', FM: 'Pacific/Pohnpei', FO: 'Atlantic/Faroe',
  FR: 'Europe/Paris', GA: 'Africa/Libreville', GB: 'Europe/London',
  GD: 'America/Grenada', GE: 'Asia/Tbilisi', GF: 'America/Cayenne',
  GG: 'Europe/Guernsey', GH: 'Africa/Accra', GI: 'Europe/Gibraltar',
  GL: 'America/Nuuk', GM: 'Africa/Banjul', GN: 'Africa/Conakry',
  GP: 'America/Guadeloupe', GQ: 'Africa/Malabo', GR: 'Europe/Athens',
  GS: 'Atlantic/South_Georgia', GT: 'America/Guatemala', GU: 'Pacific/Guam',
  GW: 'Africa/Bissau', GY: 'America/Guyana', HK: 'Asia/Hong_Kong',
  HN: 'America/Tegucigalpa', HR: 'Europe/Zagreb', HT: 'America/Port-au-Prince',
  HU: 'Europe/Budapest', ID: 'Asia/Jakarta', IE: 'Europe/Dublin',
  IL: 'Asia/Jerusalem', IM: 'Europe/Isle_of_Man', IN: 'Asia/Kolkata',
  IO: 'Indian/Chagos', IQ: 'Asia/Baghdad', IR: 'Asia/Tehran',
  IS: 'Atlantic/Reykjavik', IT: 'Europe/Rome', JE: 'Europe/Jersey',
  JM: 'America/Jamaica', JO: 'Asia/Amman', JP: 'Asia/Tokyo',
  KE: 'Africa/Nairobi', KG: 'Asia/Bishkek', KH: 'Asia/Phnom_Penh',
  KI: 'Pacific/Tarawa', KM: 'Indian/Comoro', KN: 'America/St_Kitts',
  KP: 'Asia/Pyongyang', KR: 'Asia/Seoul', KW: 'Asia/Kuwait',
  KY: 'America/Cayman', KZ: 'Asia/Almaty', LA: 'Asia/Vientiane',
  LB: 'Asia/Beirut', LC: 'America/St_Lucia', LI: 'Europe/Vaduz',
  LK: 'Asia/Colombo', LR: 'Africa/Monrovia', LS: 'Africa/Maseru',
  LT: 'Europe/Vilnius', LU: 'Europe/Luxembourg', LV: 'Europe/Riga',
  LY: 'Africa/Tripoli', MA: 'Africa/Casablanca', MC: 'Europe/Monaco',
  MD: 'Europe/Chisinau', ME: 'Europe/Podgorica', MF: 'America/Marigot',
  MG: 'Indian/Antananarivo', MH: 'Pacific/Majuro', MK: 'Europe/Skopje',
  ML: 'Africa/Bamako', MM: 'Asia/Yangon', MN: 'Asia/Ulaanbaatar',
  MO: 'Asia/Macau', MP: 'Pacific/Saipan', MQ: 'America/Martinique',
  MR: 'Africa/Nouakchott', MS: 'America/Montserrat', MT: 'Europe/Malta',
  MU: 'Indian/Mauritius', MV: 'Indian/Maldives', MW: 'Africa/Blantyre',
  MX: 'America/Mexico_City', MY: 'Asia/Kuala_Lumpur', MZ: 'Africa/Maputo',
  NA: 'Africa/Windhoek', NC: 'Pacific/Noumea', NE: 'Africa/Niamey',
  NF: 'Pacific/Norfolk', NG: 'Africa/Lagos', NI: 'America/Managua',
  NL: 'Europe/Amsterdam', NO: 'Europe/Oslo', NP: 'Asia/Kathmandu',
  NR: 'Pacific/Nauru', NU: 'Pacific/Niue', NZ: 'Pacific/Auckland',
  OM: 'Asia/Muscat', PA: 'America/Panama', PE: 'America/Lima',
  PF: 'Pacific/Tahiti', PG: 'Pacific/Port_Moresby', PH: 'Asia/Manila',
  PK: 'Asia/Karachi', PL: 'Europe/Warsaw', PM: 'America/Miquelon',
  PN: 'Pacific/Pitcairn', PR: 'America/Puerto_Rico', PS: 'Asia/Gaza',
  PT: 'Europe/Lisbon', PW: 'Pacific/Palau', PY: 'America/Asuncion',
  QA: 'Asia/Qatar', RE: 'Indian/Reunion', RO: 'Europe/Bucharest',
  RS: 'Europe/Belgrade', RU: 'Europe/Moscow', RW: 'Africa/Kigali',
  SA: 'Asia/Riyadh', SB: 'Pacific/Guadalcanal', SC: 'Indian/Mahe',
  SD: 'Africa/Khartoum', SE: 'Europe/Stockholm', SG: 'Asia/Singapore',
  SH: 'Atlantic/St_Helena', SI: 'Europe/Ljubljana', SJ: 'Arctic/Longyearbyen',
  SK: 'Europe/Bratislava', SL: 'Africa/Freetown', SM: 'Europe/San_Marino',
  SN: 'Africa/Dakar', SO: 'Africa/Mogadishu', SR: 'America/Paramaribo',
  SS: 'Africa/Juba', ST: 'Africa/Sao_Tome', SV: 'America/El_Salvador',
  SX: 'America/Lower_Princes', SY: 'Asia/Damascus', SZ: 'Africa/Mbabane',
  TC: 'America/Grand_Turk', TD: 'Africa/Ndjamena', TF: 'Indian/Kerguelen',
  TG: 'Africa/Lome', TH: 'Asia/Bangkok', TJ: 'Asia/Dushanbe',
  TK: 'Pacific/Fakaofo', TL: 'Asia/Dili', TM: 'Asia/Ashgabat',
  TN: 'Africa/Tunis', TO: 'Pacific/Tongatapu', TR: 'Europe/Istanbul',
  TT: 'America/Port_of_Spain', TV: 'Pacific/Funafuti', TW: 'Asia/Taipei',
  TZ: 'Africa/Dar_es_Salaam', UA: 'Europe/Kyiv', UG: 'Africa/Kampala',
  UM: 'Pacific/Midway', US: 'America/New_York', UY: 'America/Montevideo',
  UZ: 'Asia/Tashkent', VA: 'Europe/Vatican', VC: 'America/St_Vincent',
  VE: 'America/Caracas', VG: 'America/Tortola', VI: 'America/St_Thomas',
  VN: 'Asia/Ho_Chi_Minh', VU: 'Pacific/Efate', WF: 'Pacific/Wallis',
  WS: 'Pacific/Apia', XK: 'Europe/Belgrade', YE: 'Asia/Aden',
  YT: 'Indian/Mayotte', ZA: 'Africa/Johannesburg', ZM: 'Africa/Lusaka',
  ZW: 'Africa/Harare',
};

/**
 * One rung of a band's latitude ladder: everything strictly south of `southOf`
 * is `zone`. The last rung is `Infinity`, so a fix always lands on one.
 */
export interface LatCut {
  /** Northern edge of the rung, in degrees. The last rung is `Infinity`. */
  southOf: number;
  zone: string;
}

/** One band of a split country: everything strictly west of `westOf` is `zone`. */
export interface SplitBand {
  /** Eastern edge of the band, in degrees. The last band is `Infinity`. */
  westOf: number;
  /**
   * The band's zone — the answer for the whole band, and the answer when the
   * fix carries a longitude but no latitude.
   */
  zone: string;
  /**
   * A south→north ladder inside the band, read only when a latitude is given.
   * Some pairs of zones share a stretch of meridian and are separated by a
   * parallel instead — Hawaii and western Alaska, Arizona and Utah, Queensland
   * and New South Wales — and in several of those the parallel IS the line:
   * Arizona/Utah is the 37th, the Northern Territory/South Australia the 26th.
   * A rung is only here where longitude alone genuinely cannot answer.
   */
  cuts?: readonly LatCut[];
}

/**
 * The meridian a country's band ladder starts from, for the three that cross
 * ±180°.
 *
 * A longitude is read modulo 360 into `[origin, origin + 360)` before the
 * bands are walked, so a country with territory on both sides of the
 * antimeridian still has ONE ladder that runs west to east. Without this,
 * Chukotka at 175°W sorted below Kaliningrad and read +2 instead of +12, and
 * Attu at 172.9°E fell off the eastern end of the United States and read New
 * York — a ten- and a thirteen-hour error inside a lit box.
 *
 * Everything else keeps the default origin of -180, i.e. no change at all: a
 * longitude already in `[-180, 180]` is its own normal form there.
 *
 * Each origin is placed in the empty ocean on the far side of the country, so
 * that ONLY the meridians the country really occupies are moved. A station
 * that files a nonsense longitude keeps whatever wrong answer it had before;
 * it does not acquire a new one from the wrap.
 */
export const BAND_ORIGIN: Readonly<Record<string, number>> = {
  /** Attu at 172.9°E reads -187.1, west of Adak, which is where it belongs. */
  US: -190,
  /** Chukotka at 175°W reads 185, east of Kamchatka, which is where it belongs. */
  RU: -169,
  /** The Line Islands at 157°W read 203, east of the Gilberts and the Phoenix group. */
  KI: -30,
};

/**
 * The countries a single clock genuinely misdescribes, resolved west→east by
 * the station's own longitude and, where a meridian cannot do it, south→north
 * by its latitude.
 *
 * A meridian is not a state line and this table does not pretend it is. Each
 * boundary is placed where it costs the fewest stations, and the misses it
 * still has are named rather than hidden — a fix within `MARGIN_KM` of any of
 * these boundaries is reported as approximate, which is how the plate knows
 * not to print it as measured:
 *
 *   · **US** — Yuma reads Pacific: Arizona and Nevada interleave along the
 *     Colorado River, which is not a meridian, and this one is placed to keep
 *     Las Vegas right because it carries far more stations. Wallace, Idaho
 *     reads Mountain: the meridian east of it is placed on Montana's western
 *     edge, for the same reason in reverse. Dothan, Alabama reads Eastern:
 *     Alabama and Georgia meet on a diagonal, and the meridian is placed to
 *     keep Georgia right. Arizona itself is no longer here — it is a box.
 *   · **CA** — the Baie-des-Chaleurs shore of the Gaspé reads Atlantic rather
 *     than Eastern; below the 48.1st parallel that longitude is New Brunswick
 *     everywhere else. Blanc-Sablon reads Newfoundland, Flin Flon reads
 *     Saskatchewan, and the two corners of British Columbia that keep Mountain
 *     time — the Peace River and the East Kootenay — read Pacific.
 *   · **AU** — Broken Hill keeps South Australia's clock and reads as Sydney;
 *     it is 400 km inside New South Wales and no boundary of any kind reaches
 *     it. Queensland, the Northern Territory and Lord Howe have left this
 *     table for `EXCEPTION`.
 *   · **RU** — the western tips of Bashkortostan and Orenburg read an hour
 *     behind. The Khanty-Mansi and Yamalo-Nenets oil towns east of 68°
 *     read +6 where they keep +5, which is the price of one meridian doing for
 *     both Omsk and Tyumen.
 *   · **CD** — the +1/+2 boundary follows the Kasai and the Congo, which run
 *     diagonally; the two bands and one parallel below are the closest a
 *     rectangle gets.
 *   · **BR** — western Pará keeps -3 and reads -4. Its boundary is the Tapajós
 *     at 58°W and the staircase below stops at 54°W, which is where the
 *     stations stop: there is not one in the directory north of the 9th
 *     parallel and west of 50°W.
 *   · **MX** — Nayarit and southern Sinaloa keep -7 and read -6; the Sierra
 *     Madre puts them east of the meridian that separates the two. Ojinaga and
 *     Matamoros keep American daylight saving and read as though they had
 *     given it up with the rest of the country.
 *
 * `ES` and `PT` are here only for their Atlantic islands: the Canaries are an
 * hour behind Madrid and the Azores an hour behind Lisbon, and both are far
 * enough out to sea that one meridian settles them exactly.
 */
export const SPLIT: Readonly<Record<string, readonly SplitBand[]>> = {
  US: [
    // The Aleutians west of 169.5°W keep Hawaii-Aleutian time, an hour behind
    // Anchorage. Attu is over the antimeridian at 172.9°E; see `BAND_ORIGIN`.
    { westOf: -169.5, zone: 'America/Adak' },
    // Hawaii and western Alaska share these meridians and nothing else. Hilo
    // is at 19.7°N and Nome at 64.5°N; ~30° of empty ocean lies between them.
    {
      westOf: -152, zone: 'Pacific/Honolulu', cuts: [
        { southOf: 30, zone: 'Pacific/Honolulu' },
        { southOf: Infinity, zone: 'America/Anchorage' },
      ],
    },
    { westOf: -129, zone: 'America/Anchorage' },
    { westOf: -117, zone: 'America/Los_Angeles' },
    // Boise is Mountain at 116.2°W and Elko, a degree east of it, is Pacific;
    // no meridian tells them apart and the 42nd parallel is the Idaho/Nevada
    // line. North of the Salmon River the panhandle turns Pacific again, and
    // 45.3° is about where it does.
    {
      westOf: -116.05, zone: 'America/Denver', cuts: [
        { southOf: 42, zone: 'America/Los_Angeles' },
        { southOf: 45.3, zone: 'America/Denver' },
        { southOf: Infinity, zone: 'America/Los_Angeles' },
      ],
    },
    {
      westOf: -114.5, zone: 'America/Los_Angeles', cuts: [
        { southOf: 42, zone: 'America/Los_Angeles' },
        { southOf: Infinity, zone: 'America/Denver' },
      ],
    },
    // Arizona is inside this band and is not a band: it is a political
    // exception with a rectangle around it, in `EXCEPTION` below. What is left
    // here is Utah, western Colorado, and the corner of Arizona that keeps
    // daylight saving because it is the Navajo Nation.
    { westOf: -104.9, zone: 'America/Denver' },
    // El Paso and Hudspeth are the only counties in Texas that keep Mountain
    // time; Presidio, Culberson and Brewster, south of them, are Central. New
    // Mexico begins at 31.33°N and is Mountain all the way up.
    {
      westOf: -103, zone: 'America/Denver', cuts: [
        { southOf: 31.3, zone: 'America/Chicago' },
        { southOf: Infinity, zone: 'America/Denver' },
      ],
    },
    // The Texas and Oklahoma panhandles are Central; Colorado's eastern plains
    // and the Mountain corners of Kansas and Nebraska are not. The 37th
    // parallel is that state line too.
    {
      westOf: -101.5, zone: 'America/Chicago', cuts: [
        { southOf: 37, zone: 'America/Chicago' },
        { southOf: Infinity, zone: 'America/Denver' },
      ],
    },
    { westOf: -86.5, zone: 'America/Chicago' },
    // Between 86.5°W and 85.4°W the clock is Central below Louisville — western
    // Kentucky, middle Tennessee, eastern Alabama, the Florida panhandle — and
    // Eastern above it, in Indiana and Michigan.
    {
      westOf: -85.4, zone: 'America/New_York', cuts: [
        { southOf: 38, zone: 'America/Chicago' },
        { southOf: Infinity, zone: 'America/New_York' },
      ],
    },
    { westOf: Infinity, zone: 'America/New_York' },
  ],
  CA: [
    { westOf: -132, zone: 'America/Whitehorse' },
    { westOf: -120, zone: 'America/Vancouver' },
    // North of the 54th the Alberta border IS the 120th meridian, and Alberta's
    // Peace country reaches further west than anything in British Columbia that
    // keeps Pacific time. South of it the border turns into the Rockies and the
    // Okanagan has these meridians to itself.
    {
      westOf: -115, zone: 'America/Vancouver', cuts: [
        { southOf: 54, zone: 'America/Vancouver' },
        { southOf: Infinity, zone: 'America/Edmonton' },
      ],
    },
    { westOf: -110, zone: 'America/Edmonton' },
    { westOf: -101.5, zone: 'America/Regina' },
    { westOf: -89.5, zone: 'America/Winnipeg' },
    { westOf: -69.1, zone: 'America/Toronto' },
    // New Brunswick's north-west corner reaches 68.3°W at Edmundston, further
    // west than the Quebec towns directly above it. 47.5°N is very nearly the
    // provincial line along this meridian.
    {
      westOf: -68, zone: 'America/Toronto', cuts: [
        { southOf: 47.5, zone: 'America/Halifax' },
        { southOf: Infinity, zone: 'America/Toronto' },
      ],
    },
    // Quebec's north shore and the Gaspé are Eastern, and they lie between the
    // Maritimes below (Atlantic) and Labrador above it (Atlantic as well).
    {
      westOf: -59, zone: 'America/Halifax', cuts: [
        { southOf: 48.1, zone: 'America/Halifax' },
        { southOf: 51, zone: 'America/Toronto' },
        { southOf: Infinity, zone: 'America/Halifax' },
      ],
    },
    { westOf: Infinity, zone: 'America/St_Johns' },
  ],
  AU: [
    // Three bands and nothing more: the Northern Territory, Queensland and
    // Lord Howe are political exceptions with rectangles around them, in
    // `EXCEPTION` below, and what is left here is the clock each state moves to.
    { westOf: 129, zone: 'Australia/Perth' },
    { westOf: 141, zone: 'Australia/Adelaide' },
    { westOf: Infinity, zone: 'Australia/Sydney' },
  ],
  BR: [
    { westOf: -67.5, zone: 'America/Rio_Branco' },
    // Brazil's -3/-4 line is a diagonal, not a meridian: it is the Paraná river
    // at 54°W down in Mato Grosso do Sul and 50.5°W up in Mato Grosso, and
    // south of it EVERYTHING is -3 — Rio Grande do Sul reaches 57°W and keeps
    // São Paulo's clock the whole way. Two parallels follow the river down.
    {
      westOf: -54.2, zone: 'America/Manaus', cuts: [
        { southOf: -24.5, zone: 'America/Sao_Paulo' },
        { southOf: Infinity, zone: 'America/Manaus' },
      ],
    },
    {
      westOf: -52.5, zone: 'America/Manaus', cuts: [
        { southOf: -23, zone: 'America/Sao_Paulo' },
        { southOf: Infinity, zone: 'America/Manaus' },
      ],
    },
    {
      westOf: -51.5, zone: 'America/Manaus', cuts: [
        { southOf: -21.5, zone: 'America/Sao_Paulo' },
        { southOf: Infinity, zone: 'America/Manaus' },
      ],
    },
    {
      westOf: -50.5, zone: 'America/Manaus', cuts: [
        { southOf: -20, zone: 'America/Sao_Paulo' },
        { southOf: Infinity, zone: 'America/Manaus' },
      ],
    },
    { westOf: -33, zone: 'America/Sao_Paulo' },
    { westOf: Infinity, zone: 'America/Noronha' },
  ],
  MX: [
    { westOf: -112, zone: 'America/Tijuana' },
    // Sonora stops at 108.5°W. East of it the clocks stack rather than sitting
    // side by side: Sinaloa keeps -7 below the 27th parallel and Chihuahua -6
    // above it, and 106.3°W is where both of them give way to Durango.
    { westOf: -108.5, zone: 'America/Hermosillo' },
    {
      westOf: -106.3, zone: 'America/Mazatlan', cuts: [
        { southOf: 27.2, zone: 'America/Mazatlan' },
        { southOf: Infinity, zone: 'America/Chihuahua' },
      ],
    },
    { westOf: -89.2, zone: 'America/Mexico_City' },
    // Quintana Roo is the only Mexican state on -5 and its border with Yucatán
    // runs diagonally: 89.2°W down at Chetumal, 87.6°W up at Valladolid.
    {
      westOf: -87.6, zone: 'America/Mexico_City', cuts: [
        { southOf: 19.6, zone: 'America/Cancun' },
        { southOf: Infinity, zone: 'America/Mexico_City' },
      ],
    },
    { westOf: Infinity, zone: 'America/Cancun' },
  ],
  RU: [
    { westOf: 22, zone: 'Europe/Kaliningrad' },
    { westOf: 46, zone: 'Europe/Moscow' },
    // Along this stretch of the Volga the clocks interleave: Kazan, Cheboksary,
    // Kirov and Komi keep Moscow's, while Ulyanovsk, Samara, Saratov and
    // Astrakhan are an hour ahead of it. They are stacked, not side by side,
    // and the 55th parallel is the seam.
    {
      westOf: 51, zone: 'Europe/Samara', cuts: [
        { southOf: 55, zone: 'Europe/Samara' },
        { southOf: Infinity, zone: 'Europe/Moscow' },
      ],
    },
    // And here they interleave twice: Udmurtia (+4) is a slab with Tatarstan
    // (+3) below it and Kirov's north-east and southern Komi (+3) above.
    {
      westOf: 54.5, zone: 'Europe/Samara', cuts: [
        { southOf: 54.6, zone: 'Europe/Samara' },
        { southOf: 55.9, zone: 'Europe/Moscow' },
        { southOf: 58.6, zone: 'Europe/Samara' },
        { southOf: Infinity, zone: 'Europe/Moscow' },
      ],
    },
    { westOf: 68, zone: 'Asia/Yekaterinburg' },
    { westOf: 80, zone: 'Asia/Omsk' },
    { westOf: 93, zone: 'Asia/Novosibirsk' },
    { westOf: 109, zone: 'Asia/Irkutsk' },
    { westOf: 131, zone: 'Asia/Yakutsk' },
    { westOf: 142, zone: 'Asia/Vladivostok' },
    { westOf: 155, zone: 'Asia/Sakhalin' },
    // Kamchatka Krai stops at the Commander Islands, 168°E. Everything beyond
    // is Chukotka, which runs on over the antimeridian to 169°W.
    { westOf: 168.5, zone: 'Asia/Kamchatka' },
    { westOf: Infinity, zone: 'Asia/Anadyr' },
  ],
  ID: [
    { westOf: 115, zone: 'Asia/Jakarta' },
    { westOf: 135, zone: 'Asia/Makassar' },
    { westOf: Infinity, zone: 'Asia/Jayapura' },
  ],
  CL: [
    { westOf: -100, zone: 'Pacific/Easter' },
    // Punta Arenas sits at very nearly Santiago's own longitude, 1,400 km to
    // the south of it, and keeps -3 all year where Santiago moves.
    {
      westOf: Infinity, zone: 'America/Santiago', cuts: [
        { southOf: -48.5, zone: 'America/Punta_Arenas' },
        { southOf: Infinity, zone: 'America/Santiago' },
      ],
    },
  ],
  EC: [
    { westOf: -85, zone: 'Pacific/Galapagos' },
    { westOf: Infinity, zone: 'America/Guayaquil' },
  ],
  MN: [
    { westOf: 95, zone: 'Asia/Hovd' },
    { westOf: Infinity, zone: 'Asia/Ulaanbaatar' },
  ],
  ES: [
    { westOf: -12, zone: 'Atlantic/Canary' },
    { westOf: Infinity, zone: 'Europe/Madrid' },
  ],
  PT: [
    { westOf: -20, zone: 'Atlantic/Azores' },
    { westOf: Infinity, zone: 'Europe/Lisbon' },
  ],
  CD: [
    { westOf: 20.5, zone: 'Africa/Kinshasa' },
    // The seam runs down the Congo and then the Kasai: at the equator +1 holds
    // as far east as Bumba, and 600 km south of it +2 has already reached
    // Tshikapa. One parallel is the closest a band gets to a river.
    {
      westOf: 23.5, zone: 'Africa/Kinshasa', cuts: [
        { southOf: -1.5, zone: 'Africa/Lubumbashi' },
        { southOf: Infinity, zone: 'Africa/Kinshasa' },
      ],
    },
    { westOf: Infinity, zone: 'Africa/Lubumbashi' },
  ],
  PF: [
    { westOf: -141, zone: 'Pacific/Tahiti' },
    // East of 141°W the archipelago is three clocks stacked by latitude: the
    // Gambiers at -9, the Tuamotus on Tahiti's -10, the Marquesas at -9:30.
    {
      westOf: Infinity, zone: 'Pacific/Tahiti', cuts: [
        { southOf: -22, zone: 'Pacific/Gambier' },
        { southOf: -11, zone: 'Pacific/Tahiti' },
        { southOf: Infinity, zone: 'Pacific/Marquesas' },
      ],
    },
  ],
  GL: [
    { westOf: -60, zone: 'America/Thule' },
    { westOf: -25, zone: 'America/Nuuk' },
    { westOf: -20, zone: 'America/Scoresbysund' },
    { westOf: Infinity, zone: 'America/Danmarkshavn' },
  ],
  PG: [
    { westOf: 154, zone: 'Pacific/Port_Moresby' },
    { westOf: Infinity, zone: 'Pacific/Bougainville' },
  ],
  KI: [
    // Three groups, three clocks, spread over 4,000 km and the antimeridian:
    // the Gilberts at +12, the Phoenix group at +13, the Line Islands at +14.
    // See `BAND_ORIGIN` — these bands are read in Kiribati's own frame.
    { westOf: 180, zone: 'Pacific/Tarawa' },
    { westOf: 195, zone: 'Pacific/Kanton' },
    { westOf: Infinity, zone: 'Pacific/Kiritimati' },
  ],
  FM: [
    { westOf: 154, zone: 'Pacific/Chuuk' },
    { westOf: 161, zone: 'Pacific/Pohnpei' },
    { westOf: Infinity, zone: 'Pacific/Kosrae' },
  ],
};

/** A rectangle of the map that keeps its own clock, whatever the bands say. */
export interface ZoneBox {
  /** Southern edge, inclusive; northern edge, exclusive. Degrees. */
  south: number;
  north: number;
  /** Western edge, inclusive; eastern edge, exclusive. Degrees. */
  west: number;
  east: number;
  zone: string;
}

/**
 * The places a band ladder cannot reach, because they are not near a meridian:
 * a state in the middle of a zone that refuses to move its clocks.
 *
 * A band is a guess about where a border runs. A box is not a guess at all —
 * "Arizona keeps -7 all year" is the same kind of authored political fact as
 * "Spain keeps Madrid's clock", it is exactly as stable, and it is right or
 * wrong rather than near or far. So a fix inside a box is an EXACT answer, and
 * a box is checked before the bands. What still comes from ICU at runtime is
 * everything that moves: these tables name a zone and never an offset.
 *
 * Boxes are tried in order and the first one containing the fix wins.
 *
 *   · **Arizona** keeps -7 all year while the Mountain band around it moves,
 *     so without this it read as Denver and was an hour out for the eight
 *     months of daylight saving. The rectangle stops short of the north-east
 *     corner on purpose: the Navajo Nation up there DOES observe daylight
 *     saving, so that corner is left to the Denver band, which is right about
 *     it. The Hopi Reservation inside the Navajo Nation does not observe it and
 *     is read wrong by both — a third rectangle inside the second inside the
 *     first is further than a rectangle can honestly go, and Flagstaff and
 *     Phoenix carry the stations.
 *   · **Saskatchewan** keeps -6 all year between two provinces that do not.
 *     The box is drawn a little inside the provincial line at each end, so
 *     Lloydminster — which sits ON the Alberta border and keeps Alberta's
 *     clock — falls outside it and is marked approximate rather than wrong.
 *   · **The Northern Territory** is a rectangle in fact as well as on this
 *     page: 129°E, 138°E and the 26th parallel are its actual borders.
 *   · **Queensland** takes two, because its southern border steps south at
 *     141°E. The eastern one is cut at 28.5°S: the real border leaves the
 *     coast at 28.2°S and reaches the 29th parallel inland, so this costs
 *     Murwillumbah and keeps the whole Northern Rivers.
 *   · **Lord Howe Island** keeps +10:30, and moves by half an hour rather than
 *     a whole one. Nothing else in the world does that; a band could never say
 *     it and the island is 600 km out to sea, so a rectangle is exact.
 *   · **Ciudad Juárez** kept daylight saving when the rest of Mexico gave it up
 *     in 2022, because it runs on El Paso's clock across the river. Ojinaga and
 *     Matamoros did the same and are not here: they are small, and their
 *     rectangles would be mostly Texas.
 *
 * `Australia/Broken_Hill` and `Australia/Eucla` exist and are not boxed. Broken
 * Hill keeps South Australia's clock inside New South Wales, but its bounds are
 * a county's and not a rectangle's, and neither place has a station in the
 * directory to be right about.
 *
 * `CN` is deliberately absent. Xinjiang runs two clocks at once — Beijing's
 * +8 legally and Ürümqi's +6 socially — and which one a transmitter keeps is
 * not something a country code and a coordinate can answer. The legal clock is
 * the one this file can defend, and it is what `COUNTRY_ZONE` already says.
 */
export const EXCEPTION: Readonly<Record<string, readonly ZoneBox[]>> = {
  US: [
    // Arizona below the Navajo Nation. The western edge is the meridian the
    // bands use rather than the Colorado River, which is the real border and is
    // not a meridian — the same trade that leaves Yuma reading Pacific.
    { south: 31.33, north: 35.5, west: -114.5, east: -109.045, zone: 'America/Phoenix' },
    // …and the strip west of the Navajo Nation, up to the Utah line. Here the
    // western edge IS a meridian: 114.05°W is where Nevada starts.
    { south: 35.5, north: 37, west: -114.05, east: -111.6, zone: 'America/Phoenix' },
  ],
  CA: [
    { south: 49, north: 60, west: -109.9, east: -101.9, zone: 'America/Regina' },
  ],
  MX: [
    // Ciudad Juárez keeps daylight saving because it is welded to El Paso.
    // The rest of Chihuahua abandoned it with the rest of Mexico in 2022.
    { south: 31.4, north: 31.9, west: -106.9, east: -106.1, zone: 'America/Ciudad_Juarez' },
  ],
  AU: [
    { south: -26, north: -10.9, west: 129, east: 138, zone: 'Australia/Darwin' },
    { south: -26, north: -9, west: 138, east: 141, zone: 'Australia/Brisbane' },
    { south: -28.5, north: -9, west: 141, east: 153.6, zone: 'Australia/Brisbane' },
    { south: -31.9, north: -31.4, west: 158.8, east: 159.3, zone: 'Australia/Lord_Howe' },
  ],
};

/**
 * How far a fix has to be from the nearest zone change before this file will
 * call its own answer exact, in kilometres.
 *
 * The bands are meridians and a real timezone border is a political line that
 * wanders around one. The number is the observed size of that wander for the
 * lines in this table: the American Central/Eastern border, authored here as
 * 86.5°W, is at 87.0°W in Indiana, 85.9°W in Kentucky, 85.4°W in Tennessee and
 * 85.0°W where Alabama meets Georgia — about 140 km of drift end to end. 150 km
 * is that, rounded up. A fix further than this from any boundary is one the
 * drift cannot reach, and is reported as measured.
 *
 * It is kilometres and not degrees on purpose: a degree of longitude is 111 km
 * at the equator and 49 km at Anchorage, so a margin in degrees would hedge
 * Jakarta and wave Nome through.
 *
 * What it catches: Chicago, 93 km from the authored meridian and about 60 km
 * from the real Indiana line. Nashville, 25 km. Indianapolis, 30 km — all three
 * genuinely sit near a border. What it does not catch: Madrid at 701 km from
 * the Canaries band, Toronto at 813 km, São Paulo at 394 km, Recife at 207 km.
 *
 * And it fires on a nearby CHANGE rather than on a nearby line: Kodiak is 24 km
 * from the meridian that separates Alaska from Hawaii and is not hedged,
 * because that meridian decides nothing at 57°N. See `farFromEveryOtherZone`.
 */
export const MARGIN_KM = 150;

/** One degree of latitude, and one of longitude at the equator, in kilometres. */
const KM_PER_DEGREE = 111;

/**
 * A lookup that cannot be answered by the prototype.
 *
 * `COUNTRY_ZONE['constructor']` is a function, not a zone, and a directory is
 * exactly the kind of place a string like that arrives from.
 */
function owned<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/** Is this country one whose clock a single zone genuinely misdescribes? */
export function isSplit(cc?: string): boolean {
  if (!cc) return false;
  return Object.prototype.hasOwnProperty.call(SPLIT, cc.toUpperCase());
}

/** The zone of the band a latitude lands in, or the band's own when there is none. */
function zoneOfBand(band: SplitBand, lat?: number): string {
  const cuts = band.cuts;
  if (!cuts || typeof lat !== 'number' || !Number.isFinite(lat)) return band.zone;
  for (const cut of cuts) {
    if (lat < cut.southOf) return cut.zone;
  }
  return band.zone;
}

/**
 * A longitude in the country's own frame, so that a ladder crossing ±180° stays
 * in one piece and stays ordered. See `BAND_ORIGIN`.
 */
function eastOfOrigin(key: string, lon: number): number {
  const origin = owned(BAND_ORIGIN, key) ?? -180;
  return origin + ((((lon - origin) % 360) + 360) % 360);
}

/** The exception box a fix falls in, if it falls in one. */
function boxAt(key: string, east: number, lat: number): ZoneBox | null {
  const boxes = owned(EXCEPTION, key);
  if (!boxes) return null;
  for (const box of boxes) {
    if (east >= box.west && east < box.east && lat >= box.south && lat < box.north) return box;
  }
  return null;
}

/** The band a longitude falls in. The last band is `Infinity`, so there is always one. */
function bandAt(bands: readonly SplitBand[], east: number): SplitBand | null {
  for (const band of bands) {
    if (east < band.westOf) return band;
  }
  return null;
}

/** Everything a position says about the zone: box first, then band. */
function zoneAtFix(key: string, bands: readonly SplitBand[], lon: number, lat: number): string | null {
  const east = eastOfOrigin(key, lon);
  const box = boxAt(key, east, lat);
  if (box) return box.zone;
  const band = bandAt(bands, east);
  return band ? zoneOfBand(band, lat) : null;
}

/**
 * Would this answer survive being wrong about where the border is?
 *
 * Four steps of `MARGIN_KM` — east, west, north, south — from the fix. If all
 * four land on the same zone, no plausible drift in the authored boundary can
 * change the answer and it is exact. If any of them lands somewhere else, the
 * fix is near a boundary and the answer is a guess about which side of it the
 * station sits.
 *
 * The step east and west is scaled by the latitude, so it is 150 km of ground
 * at Nome as well as at Jakarta, and it goes through the same longitude
 * normalisation as the lookup itself, so a probe off the end of the map comes
 * back on the other side rather than falling out of the ladder. The probe is
 * four cardinal steps and not a disc: a zone reachable only across a corner is
 * not caught.
 */
function farFromEveryOtherZone(
  key: string,
  bands: readonly SplitBand[],
  lon: number,
  lat: number,
  zone: string,
): boolean {
  const stepLat = MARGIN_KM / KM_PER_DEGREE;
  // cos(90°) is zero and the poles are not worth a division by it.
  const shrink = Math.max(Math.cos((lat * Math.PI) / 180), 0.05);
  const stepLon = MARGIN_KM / (KM_PER_DEGREE * shrink);
  const probes: readonly (readonly [number, number])[] = [
    [lon - stepLon, lat],
    [lon + stepLon, lat],
    [lon, Math.max(-90, lat - stepLat)],
    [lon, Math.min(90, lat + stepLat)],
  ];
  for (const [probeLon, probeLat] of probes) {
    if (zoneAtFix(key, bands, probeLon, probeLat) !== zone) return false;
  }
  return true;
}

/** A zone, and whether getting to it involved a guess. */
export interface ZoneResolution {
  /** The IANA zone. */
  zone: string;
  /**
   * True when the zone was reached by a longitude/latitude guess inside a
   * multi-zone country, i.e. when the clock is honest to about a state line
   * and no closer. False when the country has exactly one zone, in which case
   * a bare country code is an EXACT answer.
   */
  approximate: boolean;
}

/**
 * The zone a station transmits from and how exact that answer is, or `null`
 * when the directory has not said enough to know.
 *
 * `null` is a real answer here and the callers print it as one — an unlit strip
 * and a readout that says so. It is never a zone that happens to be nearby.
 */
export function resolveZone(cc?: string, lon?: number, lat?: number): ZoneResolution | null {
  if (!cc) return null;
  const key = cc.toUpperCase();
  const whole = owned(COUNTRY_ZONE, key);
  if (whole === undefined) return null;

  const bands = owned(SPLIT, key);
  // One zone for the whole country: the country code IS the measurement, and
  // no position could make it any more exact.
  if (!bands) return { zone: whole, approximate: false };

  const hasLon = typeof lon === 'number' && Number.isFinite(lon);
  const hasLat = typeof lat === 'number' && Number.isFinite(lat);

  if (hasLon && hasLat) {
    const east = eastOfOrigin(key, lon as number);
    // A political rectangle is a fact, not a guess about where a line runs.
    const box = boxAt(key, east, lat as number);
    if (box) return { zone: box.zone, approximate: false };
    const band = bandAt(bands, east);
    if (band) {
      const zone = zoneOfBand(band, lat);
      return {
        zone,
        approximate: !farFromEveryOtherZone(key, bands, lon as number, lat as number, zone),
      };
    }
  }

  if (hasLon) {
    // A longitude with no latitude cannot be checked: the ladders that run
    // north-south are unreadable without one, and there is no converting a
    // degree of longitude into ground without knowing how far up the map it is.
    const band = bandAt(bands, eastOfOrigin(key, lon as number));
    if (band) return { zone: zoneOfBand(band, lat), approximate: true };
  }

  // A split country with no position: the most populous zone stands in for the
  // rest of them, which is a guess and says so.
  return { zone: whole, approximate: true };
}

/**
 * The zone a station transmits from, or `null` when the directory has not said
 * enough to know.
 *
 * Callers that put the reading on the glass want `resolveZone()` instead — the
 * zone alone cannot tell them whether to mark it approximate.
 */
export function zoneFor(cc?: string, lon?: number, lat?: number): string | null {
  return resolveZone(cc, lon, lat)?.zone ?? null;
}

/**
 * One formatter per zone, built on first use.
 *
 * `Intl.DateTimeFormat` construction is the expensive half of this — hundreds
 * of microseconds against a few for a format — and the register asks the same
 * dozen zones over and over as a pointer walks the ledger. `null` is cached
 * too, so an unknown zone costs one `RangeError` for the life of the session
 * rather than one per hover.
 */
const OFFSET_FMT = new Map<string, Intl.DateTimeFormat | null>();
const CLOCK_FMT = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(
  cache: Map<string, Intl.DateTimeFormat | null>,
  zone: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat | null {
  const held = cache.get(zone);
  if (held !== undefined) return held;
  let made: Intl.DateTimeFormat | null = null;
  try {
    made = new Intl.DateTimeFormat('en-US', { ...options, timeZone: zone });
  } catch {
    // An unknown or misspelled zone throws `RangeError`. That is a `null`
    // answer, not an exception the map hover has to survive.
    made = null;
  }
  cache.set(zone, made);
  return made;
}

/** `GMT`, `GMT+5:30`, `GMT-3` — the spelling ICU itself uses, and we parse. */
const GMT_OFFSET = /^GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?$/;

/**
 * Minutes east of GMT in `zone` at instant `at`, daylight saving included, or
 * `null` if the platform does not know the zone.
 *
 * The offset comes out of ICU's own tz database rather than out of any table
 * in this file, which is the whole point: the half of the answer that moves is
 * never authored here.
 */
export function offsetMinutes(zone: string, at: Date): number | null {
  const fmt = formatterFor(OFFSET_FMT, zone, { timeZoneName: 'shortOffset' });
  if (!fmt) return null;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = fmt.formatToParts(at);
  } catch {
    // An invalid `Date` throws too, and is just as much a `null`.
    return null;
  }
  const name = parts.find((p) => p.type === 'timeZoneName')?.value;
  if (!name) return null;
  const m = GMT_OFFSET.exec(name);
  if (!m) return null;
  // Bare `GMT` is zero — ICU prints no sign or digits at the meridian.
  if (!m[1]) return 0;
  const minutes = Number(m[2]) * 60 + Number(m[3] ?? 0);
  return m[1] === '-' ? -minutes : minutes;
}

/** `HH:MM` on the wall in `zone`, 24-hour, or `null` for an unknown zone. */
export function localClock(zone: string, at: Date): string | null {
  const fmt = formatterFor(CLOCK_FMT, zone, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  if (!fmt) return null;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = fmt.formatToParts(at);
  } catch {
    return null;
  }
  const hour = parts.find((p) => p.type === 'hour')?.value;
  const minute = parts.find((p) => p.type === 'minute')?.value;
  if (!hour || !minute) return null;
  return `${hour.padStart(2, '0')}:${minute}`;
}

/** How an offset is written on this receiver: `GMT`, `GMT+1`, `GMT+5:30`. */
export function offsetLabel(min: number): string {
  if (!Number.isFinite(min) || min === 0) return 'GMT';
  const sign = min < 0 ? '-' : '+';
  const abs = Math.abs(Math.round(min));
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return m === 0 ? `GMT${sign}${h}` : `GMT${sign}${h}:${String(m).padStart(2, '0')}`;
}

/**
 * Which cell of the printed strip a given offset belongs in.
 *
 * The strip has twenty-four cells at whole-hour offsets, -11 … GMT … +12, and
 * they are what the case is screen-printed with — they cannot be added to.
 * So there are exactly three honest answers:
 *
 *   · `exact`    — a whole-hour zone. One cell.
 *   · `between`  — a fractional zone (India +5:30, Iran +3:30, Nepal +5:45).
 *                  The two cells it lies between, which is what is true.
 *   · `off-strip`— the reading is real and the strip has no cell for it. New
 *                  Zealand on summer time is +13; Chatham is +12:45, whose
 *                  upper neighbour is also off the end. Lighting the nearest
 *                  printed cell would state an offset the station does not
 *                  keep, so nothing is lit and the caller says so elsewhere.
 *
 * `cells` are hour offsets, not indices — the strip's own numbering, which is
 * what `TIMEZONES[n].offset` carries.
 */
export type StripLamp =
  | { kind: 'exact'; cells: readonly [number] }
  | { kind: 'between'; cells: readonly [number, number] }
  | { kind: 'off-strip'; cells: readonly [] };

const OFF_STRIP: StripLamp = { kind: 'off-strip', cells: [] };

function onStrip(hour: number): boolean {
  return hour >= STRIP_MIN_HOUR && hour <= STRIP_MAX_HOUR;
}

export function stripLamp(offsetMin: number): StripLamp {
  if (!Number.isFinite(offsetMin)) return OFF_STRIP;
  const lo = Math.floor(offsetMin / 60);
  const hi = Math.ceil(offsetMin / 60);
  if (lo === hi) return onStrip(lo) ? { kind: 'exact', cells: [lo] } : OFF_STRIP;
  // Both neighbours have to be printed for "between these two" to be readable.
  if (!onStrip(lo) || !onStrip(hi)) return OFF_STRIP;
  return { kind: 'between', cells: [lo, hi] };
}
