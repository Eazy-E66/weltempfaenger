/**
 * Tag hygiene for the band selector.
 *
 * Radio Browser's tag list is user-supplied and unmoderated. Alongside "jazz"
 * and "classical" it contains stream URLs, phone numbers, sentences, single
 * punctuation marks, and the occasional wall of emoji. The band selector is
 * populated from this list, so whatever survives here becomes a band the user
 * can tune to — the filtering is a product decision, not a cosmetic one.
 */

import type { GenreTag } from '../../shared/contracts';

/** Longer than this is a description or a spam payload, not a genre. */
const MAX_TAG_LENGTH = 28;
/** Single characters carry no meaning as a band name. */
const MIN_TAG_LENGTH = 2;

const URLISH = /(https?:|www\.|\.com|\.net|\.org|\.ru|@|\bt\.me\b)/i;
/** Any C0/C1 control character, or a private-use codepoint. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\ue000-\uf8ff]/;
/** Four or more of the same character running: "aaaa", "!!!!", "----". */
const REPEATED = /(.)\1{3,}/;
/** Nothing but punctuation and separators. */
const PUNCT_ONLY = /^[^\p{L}\p{N}]+$/u;
/** Must contain at least one letter somewhere — "80s" passes, "128" does not. */
const HAS_LETTER = /\p{L}/u;

/**
 * Diacritics folded away for *matching only* — never for display.
 *
 * Without this the lists below would be an English-only filter wearing a
 * multilingual coat: `musica` is blocked, `música` is not, and the live
 * directory serves the accented spelling to 1719 stations. Folding is the
 * general mechanism that makes one entry cover every way a word is typed. The
 * tag that survives keeps its own accents, because `música pop` is how it is
 * spelled and the band selector should say so.
 */
export function foldForMatch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * The grouping key: a tag reduced to *what it is*, with every trace of *how it
 * was typed* removed. Diacritics folded, lowercased, and every character that
 * is neither a letter nor a digit deleted.
 *
 * `foldForMatch` exists to compare a tag against a written-down word, so it
 * preserves word boundaries — `live jazz` must not collide with `livejazz`.
 * This is the opposite job: it exists to prove that `trip-hop`, `trip hop` and
 * `triphop` are one genre with 46 stations rather than three with 24, 14 and 8.
 * Punctuation is the only thing separating them, and punctuation in a
 * user-typed tag carries no meaning at all.
 *
 * Deleting non-alphanumerics also deletes emoji, so `news🇺🇸🇺🇸` keys to `news`
 * and folds into it. The de-noising is a consequence of the de-duplication,
 * not a second rule.
 *
 * `\p{L}`/`\p{N}` rather than `[a-z0-9]`: an ASCII-only key would flatten
 * `музыка` and `演歌` to the empty string and collide every non-Latin tag in the
 * directory into one enormous group.
 */
export function groupKey(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Tags that are well-formed words but say nothing about what a station plays.
 *
 * Four families:
 *   - placeholders a form left behind ("undefined", "n/a")
 *   - words that describe every station in the directory ("radio", "music") —
 *     in whatever language they were typed. `estación` (2136 stations) and
 *     `entretenimiento` (2156) are the Spanish members of exactly the family
 *     `radio` and `music` already cover, and leaving them in while filtering
 *     the English ones is not neutrality, it is an English-only filter.
 *   - technical vocabulary that leaked out of a config field. `https` is a real
 *     example with 50+ stations behind it in the live directory: it passes
 *     every structural check, because it *is* a plausible word, and it would
 *     otherwise appear in the band selector as a genre.
 *   - the same words in their "live/online" variants
 *
 * Entries are matched against the diacritic-folded tag, so unaccented spellings
 * here cover the accented ones. Only *exact* matches are removed: `música pop`,
 * `música en español` and `radio hablada` are genres and all survive.
 */
const BLOCKLIST = new Set([
  // placeholders
  'undefined',
  'null',
  'none',
  'n/a',
  'na',
  'various',
  'no tag',
  'notag',
  'misc',
  // true of everything — English
  'radio',
  'music',
  'musica',
  'fm',
  'am',
  'online',
  'online radio',
  'online only',
  'internet',
  'internet radio',
  'radio station',
  'radio online',
  'webradio',
  'web radio',
  'live',
  'stream',
  'streams',
  'streaming',
  '24/7',
  'entertainment',
  // true of everything — the same words in the other languages the directory
  // is actually written in. `musica` above already covers `música` by folding.
  'estacion', // es: "station"
  'estacao', // pt
  'emisora', // es: "broadcaster"
  'emissora', // pt
  'entretenimiento', // es: "entertainment"
  'entretenimento', // pt
  'divertissement', // fr
  'unterhaltung', // de
  'intrattenimento', // it
  'musik', // de
  'musique', // fr
  'muzyka', // pl
  'muzica', // ro
  'muzik', // tr
  'sender', // de: "transmitter"
  'rundfunk', // de: "broadcasting"
  'radyo', // tr
  'en vivo', // es: "live"
  'en directo', // es
  'ao vivo', // pt
  'dal vivo', // it
  'programas en vivo',
  // protocol, codec and server vocabulary
  'http',
  'https',
  'url',
  'mp3',
  'aac',
  'aacp',
  'ogg',
  'opus',
  'flac',
  'kbps',
  'bitrate',
  'codec',
  'shoutcast',
  'icecast',
  'hls',
  'mount',
  'server',
]);

/**
 * Continents and supra-national regions.
 *
 * Geography is not a genre — it is the PRESELECTOR's axis, and it already has a
 * control. `norteamérica` (1904 stations) and `américa` (1464) are two of the
 * eight largest tags in the live directory and neither tells you a single thing
 * about what comes out of the speaker.
 *
 * This is a closed set of about a dozen concepts, which is why it can be
 * written down; individual *countries* are not, and come from the directory's
 * own country list instead (see `TagVocabulary`).
 *
 * Only exact matches are removed, which is what keeps the genres safe: `latin`,
 * `latino`, `latin pop` and `world music` all survive `latinoamerica` being
 * blocked, and `african` / `afrobeat` survive `africa`.
 */
const REGIONS = new Set([
  'america',
  'americas',
  'north america',
  'norteamerica',
  'south america',
  'sudamerica',
  'sudamérica',
  'america del sur',
  'central america',
  'centroamerica',
  'latin america',
  'latinoamerica',
  'america latina',
  'europe',
  'europa',
  'asia',
  'africa',
  'oceania',
  'antarctica',
  'middle east',
  'oriente medio',
  'medio oriente',
  'balkan',
  'balkans',
  'caribbean',
  'caribe',
  'scandinavia',
  'nordic',
  'sureste',
  'suroeste',
  'noreste',
  'noroeste',
]);

/**
 * Broadcaster, network and contributor names.
 *
 * A genre is a property many independent broadcasters share; a brand belongs to
 * exactly one, and the directory has no field that distinguishes the two — so
 * they arrive as tags and rank alarmingly high. `moi merino` is 1798 stations
 * deep and is a person: one contributor's name, applied across a catalogue they
 * uploaded. It passes every structural check because it is a perfectly
 * well-formed two-word phrase.
 *
 * There is no structural signal for this family, only evidence, so this list is
 * exactly as long as what has been observed in the live directory's top few
 * hundred tags — and is expected to grow the same way, one measurement at a
 * time. It is not a guess at what might be junk.
 */
const BRANDS = new Set([
  'moi merino',
  'radiorama',
  'radiopolis',
  'grupo acir',
  'acir',
  'mvs',
  'mvs radio',
  'exa',
  'exa fm',
  'ponte exa',
  'la estacion exacta',
  'la estacion naranja',
  'iheart',
  'iheart radio',
  'iheartradio',
  'npr',
  'radio caprice',
]);

/**
 * Vocabulary the directory can supply about itself, so the filter does not have
 * to hardcode a world atlas that would rot.
 */
export interface TagVocabulary {
  /**
   * Country, state and region names the directory reports on its own
   * geography endpoints, already passed through `foldForMatch`. A tag that is
   * exactly one of these is a place, and places have their own control.
   */
  places?: ReadonlySet<string>;
}

/**
 * Normalise a raw tag to its canonical band name, or null if it is junk.
 * Exported so tests can pin the exact policy rather than infer it.
 *
 * Every rejection below is either structural (a URL, a sentence, a control
 * character) or a statement that the tag names something other than a genre —
 * a place, a brand, or a word true of every station. None of them is "this word
 * is not English": the exact-match discipline plus diacritic folding is what
 * keeps `música en español`, `música pop`, `noticias` and `schlager` on the
 * dial while `estación` and `norteamérica` come off it.
 */
export function normaliseTag(raw: string, vocab?: TagVocabulary): string | null {
  const tag = raw.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
  if (tag.length < MIN_TAG_LENGTH) return null;
  if (tag.length > MAX_TAG_LENGTH) return null;
  if (CONTROL.test(tag)) return null;
  if (URLISH.test(tag)) return null;
  if (PUNCT_ONLY.test(tag)) return null;
  if (!HAS_LETTER.test(tag)) return null; // numeric-only, e.g. "128", "2024"
  if (REPEATED.test(tag)) return null;
  // A tag with more than three words is a sentence someone typed into the
  // wrong box, not a genre.
  if (tag.split(' ').length > 3) return null;

  const folded = foldForMatch(tag);
  if (BLOCKLIST.has(tag) || BLOCKLIST.has(folded)) return null;
  if (REGIONS.has(folded)) return null;
  if (BRANDS.has(folded)) return null;
  if (vocab?.places?.has(folded)) return null;

  return tag;
}

export interface RawTag {
  name: string;
  count: number;
}

/**
 * Clean, merge, FOLD and rank a directory's raw tag list. No floor: every group
 * the directory has, however small, comes back.
 *
 * Two merges happen here, and they are not the same merge.
 *
 *   1. `Jazz`, `jazz ` and `JAZZ` are the same *string*, differently typed.
 *      `normaliseTag` already flattens those, and their counts are summed.
 *   2. `trip-hop` (24), `trip hop` (14) and `triphop` (8) are the same *genre*,
 *      differently spelled. They are three distinct strings and the directory
 *      keeps three distinct tags, so nothing above catches them. `groupKey`
 *      does: all three key to `triphop`, so they become one group of 46.
 *
 * The second merge is the one the client complained about — `trip hop` was
 * unreachable at any sensible floor because its 46 stations were split three
 * ways. 493 groups in the live directory have more than one spelling.
 *
 * The canonical `name` is the highest-count spelling, because that is the one
 * the directory's own users type most and the one most likely to read as a
 * genre. Every member spelling is kept in `spellings`, canonical first, so the
 * panel can say out loud what it folded and the provider can expand the group
 * back into the N tag queries the directory actually understands.
 *
 * Sort order is station count descending — the biggest bands first, which is
 * how a real band selector is laid out — with the name as a stable tiebreak so
 * the list never reshuffles between calls.
 */
export function groupTags(raw: RawTag[], vocab?: TagVocabulary): GenreTag[] {
  const merged = new Map<string, number>();
  for (const tag of raw) {
    const name = normaliseTag(tag.name ?? '', vocab);
    if (name === null) continue;
    const count = Number.isFinite(tag.count) && tag.count > 0 ? Math.floor(tag.count) : 0;
    if (count === 0) continue;
    merged.set(name, (merged.get(name) ?? 0) + count);
  }

  const groups = new Map<string, Array<{ name: string; count: number }>>();
  for (const [name, count] of merged) {
    const key = groupKey(name);
    // `normaliseTag` guarantees at least one letter survived, so an empty key
    // is impossible — but a group keyed on '' would swallow the directory, so
    // it is guarded rather than assumed.
    if (!key) continue;
    const members = groups.get(key);
    if (members) members.push({ name, count });
    else groups.set(key, [{ name, count }]);
  }

  return [...groups.values()]
    .map((members) => {
      members.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
      return {
        name: members[0]!.name,
        stationCount: members.reduce((sum, m) => sum + m.count, 0),
        spellings: members.map((m) => m.name),
      };
    })
    .sort((a, b) => b.stationCount - a.stationCount || a.name.localeCompare(b.name));
}

/**
 * `groupTags` with a minimum station count applied to the *folded* total.
 *
 * Folding first is the whole point: `trip-hop` clears a floor of 40 only
 * because its three spellings are counted together.
 */
export function cleanTags(
  raw: RawTag[],
  minStations: number,
  vocab?: TagVocabulary,
): GenreTag[] {
  const floor = Math.max(1, Math.floor(minStations));
  return groupTags(raw, vocab).filter((g) => g.stationCount >= floor);
}
