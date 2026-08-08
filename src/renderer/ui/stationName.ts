/**
 * Station names, made fit to print on a dial.
 *
 * Radio Browser's `name` field is free text and a great many operators use it
 * as a second tag box, because search matches on it. The live directory serves
 * names like:
 *
 *   0R - EURO DANCE || Eurodance, 90s Dance, Pop, Dance, Club, Party, Trance…
 *
 * The station is "0R - EURO DANCE". Everything after the `||` is search bait,
 * and printing it on the drum turns a dial into a keyword dump.
 *
 * **This is display policy only.** `StationRef.name` is identity: it is what
 * presets store, what search matches, and what the directory hands back next
 * time. Mutating it would make a stored preset stop matching its own station.
 * So nothing here writes back — callers pass a name in and print what comes out.
 */

/**
 * Separators operators use to bolt a keyword list onto a name. `||` is by far
 * the most common; the rest are the same trick with different punctuation. A
 * single `|` is included but treated with suspicion — see `looksLikeKeywordList`.
 */
const STUFFING_SEPARATORS = ['||', ' // ', ' | ', '|'];

/** How many printed characters a dial or a readout can carry. */
export const NAME_DISPLAY_LIMIT = 42;

/**
 * Whitespace as it actually arrives: tabs, non-breaking spaces, the Unicode
 * space family, zero-width characters and the BOM. `\s` alone misses the last
 * two, and a name that ends in a zero-width space defeats `trim()`.
 */
const WHITESPACE_RUN = /[\s   -‍  　﻿]+/g;

/** Punctuation left dangling once a keyword list has been cut off the end. */
const TRAILING_JUNK = /[\s\-–—_·•|\/,;:]+$/u;

/**
 * A trailing keyword list, as opposed to a genuine part of the name.
 *
 * "Radio Nova | Paris" is a name; "Radio Nova | pop, dance, hits, 90s, party"
 * is a name plus stuffing. The tell is commas: three or more comma-separated
 * fragments after the separator is a list, not a subtitle.
 */
function looksLikeKeywordList(tail: string): boolean {
  return tail.split(',').filter((part) => part.trim().length > 0).length >= 3;
}

/**
 * Collapse whitespace, drop the tag stuffing, and truncate on a word boundary.
 * Returns the input unchanged when there is nothing to clean, so a well-formed
 * name is never mangled.
 */
export function displayStationName(raw: string, limit = NAME_DISPLAY_LIMIT): string {
  let name = raw.replace(WHITESPACE_RUN, ' ').trim();
  if (!name) return '';

  for (const sep of STUFFING_SEPARATORS) {
    const at = name.indexOf(sep);
    if (at <= 0) continue;
    const head = name.slice(0, at).trim();
    const tail = name.slice(at + sep.length).trim();
    if (!head) continue;
    // A doubled separator is unambiguous stuffing. A single pipe only counts
    // when the tail actually reads as a keyword list.
    if (sep.includes('||') || sep.includes('//') || looksLikeKeywordList(tail)) {
      name = head;
      break;
    }
  }

  // Some names carry the list with no separator at all, just a comma run at the
  // end: "Rock Antenne, rock, classic rock, hard rock, metal".
  const commas = name.split(',');
  if (commas.length >= 4 && commas[0]!.trim().length >= 3) {
    name = commas[0]!.trim();
  }

  name = name.replace(TRAILING_JUNK, '').trim();
  if (name.length <= limit) return name;

  // Truncate on a word boundary when there is one worth using, so a name is
  // never cut mid-word for the sake of two characters.
  const cut = name.slice(0, limit - 1);
  const space = cut.lastIndexOf(' ');
  const head = space >= limit * 0.6 ? cut.slice(0, space) : cut;
  return `${head.replace(TRAILING_JUNK, '')}…`;
}

/* ---------------------------------------------------------------------------
   Station names as DIAL PRINT.

   `displayStationName()` above solves the *data* problem — the keyword payload
   operators bolt onto the name field. That is settled and it runs first.

   This is the TYPOGRAPHIC question that comes after it: what may be printed on
   a physical drum, next to a frequency scale, at 7–10 px.

   A printed dial's names are city names and call signs — HILVERSUM, DROITWICH,
   BEROMÜNSTER, LUXEMBOURG. Three to fourteen characters, one word or two, all
   caps, no punctuation, no parentheses, no bitrate. A draughtsman laying out a
   dial did four things, in this order, and so does this:

     1. drop everything a printer would not set — bracketed suffixes, trailing
        technical annotations, decorative separators;
     2. drop the generic prefix. Dials print NEDERLAND, not RADIO NEDERLAND;
        the whole dial is radio stations, so RADIO carries no information and
        costs five characters of a fourteen-character budget;
     3. shorten to whole words. A printed dial has no ellipsis glyph, because
        ink does not run out mid-word;
     4. if it still does not fit, DO NOT PRINT IT. The blip stands alone and the
        readout carries the full name. A dial with an unreadable smear of text
        where a name should be is worse than a dial with a bare graduation.

   Display policy only, exactly like its sibling above: nothing here writes back
   to `StationRef.name`, so a stored preset never stops matching its station.
   ------------------------------------------------------------------------- */

/** Bracketed and parenthesised suffixes: "(128k)", "[HD]". */
const BRACKETED = /\s*[([{][^)\]}]*[)\]}]\s*/gu;
/** Technical annotations operators append: bitrates, codecs, "HD", "STEREO". */
const TECHNICAL =
  /\s*[-–—·|]?\s*\b(\d{2,3}\s?k(?:bps)?|aac\+?|mp3|ogg|opus|flac|hd\d?|hi-?fi|stereo|live|stream(?:ing)?|online|official|24\s?\/\s?7)\b\.?/giu;
/** Generic leading words. A dial of radio stations need not say RADIO. */
const GENERIC_PREFIX = /^(radio|rádio|radyo|rundfunk|the|la|le|el|il)[\s.\-–—:]+/iu;
/** Generic trailing words. */
const GENERIC_SUFFIX = /[\s.\-–—:]+(radio|rádio|fm|am|net|web|internet)$/iu;

/**
 * @param raw   a name that has ALREADY been through `displayStationName()`.
 * @param limit printed characters the drum can carry at this width.
 * @returns the string to print, or '' meaning "print nothing, just the blip".
 */
export function dialStationName(raw: string, limit = 14): string {
  let n = String(raw ?? '').replace(WHITESPACE_RUN, ' ').trim();
  if (!n) return '';

  n = n.replace(BRACKETED, ' ').replace(TECHNICAL, ' ').replace(WHITESPACE_RUN, ' ').trim();

  const stripped = n.replace(GENERIC_PREFIX, '').replace(GENERIC_SUFFIX, '').trim();
  if (stripped.length >= 3) n = stripped;

  n = n.replace(TRAILING_JUNK, '').trim().toUpperCase();
  if (!n) return '';
  // A printer does not drop a word to save two characters — he tightens the
  // tracking a hair and sets the line. Same tolerance the truncator above uses.
  if (n.length <= limit + 3) return n;

  // Whole words only. Never an ellipsis: printed dials do not have one.
  let out = '';
  for (const word of n.split(' ')) {
    const next = out ? `${out} ${word}` : word;
    if (next.length > limit) break;
    out = next;
  }
  // A single word longer than the budget cannot be shortened honestly, so it
  // is not printed. The blip and the readout still carry the station.
  if (out.length < 3) return '';
  return out.replace(TRAILING_JUNK, '');
}
