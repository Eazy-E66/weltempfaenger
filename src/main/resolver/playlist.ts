/**
 * Playlist parsers. Pure string in, URL list out — no I/O, no network.
 *
 * These formats are old, under-specified and inconsistently produced, so the
 * parsers are deliberately forgiving about whitespace, casing and line endings,
 * and deliberately strict about ordering: the order entries come back in is the
 * order the resolver will try them, and that order is the station operator's
 * stated preference.
 */

import { stripBom } from './sniff';

export interface PlaylistEntry {
  url: string;
  /** `Title1=` in PLS, `#EXTINF:-1,Title` in extended M3U. Advisory only. */
  title?: string;
}

/**
 * SHOUTcast/Winamp PLS.
 *
 *   [playlist]
 *   NumberOfEntries=2
 *   File1=http://a/stream
 *   Title1=Main
 *   File2=http://b/stream
 *
 * Entries are returned ordered by their index, not by the order the `FileN=`
 * lines happen to appear — some generators emit them out of order.
 * `NumberOfEntries` is treated as advisory; a file with three `FileN=` lines
 * and `NumberOfEntries=1` still yields three, because the URLs are the truth.
 */
export function parsePls(raw: string): PlaylistEntry[] {
  const text = stripBom(raw);
  const files = new Map<number, string>();
  const titles = new Map<number, string>();

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim().toLowerCase();
    const value = trimmed.slice(eq + 1).trim();
    if (!value) continue;

    const fileMatch = /^file(\d+)$/.exec(key);
    if (fileMatch) {
      files.set(Number(fileMatch[1]), value);
      continue;
    }
    const titleMatch = /^title(\d+)$/.exec(key);
    if (titleMatch) titles.set(Number(titleMatch[1]), value);
  }

  return [...files.keys()]
    .sort((a, b) => a - b)
    .map((index) => {
      const title = titles.get(index);
      const entry: PlaylistEntry = { url: files.get(index)! };
      if (title) entry.title = title;
      return entry;
    });
}

/**
 * M3U / extended M3U.
 *
 * `#EXTINF:` lines carry a title for the entry that follows. Every other
 * comment line is ignored. Blank lines are ignored. Everything else is a URL
 * (possibly relative — the caller resolves it against the playlist's own URL).
 *
 * This function does NOT distinguish HLS; see `isHlsManifest` in ./sniff.
 * Feeding it an HLS manifest would produce a list of media-segment URLs, which
 * is exactly the silent-failure mode we are trying to avoid.
 */
export function parseM3u(raw: string): PlaylistEntry[] {
  const text = stripBom(raw);
  const entries: PlaylistEntry[] = [];
  let pendingTitle: string | undefined;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) {
      const ext = /^#EXTINF\s*:\s*(-?\d+(?:\.\d+)?)?\s*(?:,\s*(.*))?$/i.exec(trimmed);
      if (ext) {
        const title = (ext[2] ?? '').trim();
        pendingTitle = title || undefined;
      }
      continue;
    }
    const entry: PlaylistEntry = { url: trimmed };
    if (pendingTitle) entry.title = pendingTitle;
    entries.push(entry);
    pendingTitle = undefined;
  }
  return entries;
}

/**
 * Parse whichever of the two formats `kind` says this is, then resolve every
 * entry against `baseUrl` so relative paths work. Entries that cannot be made
 * into an absolute URL at all are dropped — there is nothing to try.
 */
export function parsePlaylist(kind: 'pls' | 'm3u', raw: string, baseUrl: string): PlaylistEntry[] {
  const entries = kind === 'pls' ? parsePls(raw) : parseM3u(raw);
  const out: PlaylistEntry[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    let absolute: string;
    try {
      absolute = new URL(entry.url, baseUrl).toString();
    } catch {
      continue;
    }
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    out.push(entry.title ? { url: absolute, title: entry.title } : { url: absolute });
  }
  return out;
}
