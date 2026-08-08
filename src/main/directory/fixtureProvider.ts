/**
 * A `DirectoryProvider` backed by a JSON file on disk.
 *
 * This is not a test double bolted on afterwards — it is how the whole app
 * stays runnable and demonstrable with the network unplugged, and how the band
 * layout and the tuning UI get a fixed station set to be reasoned about. Every
 * answer it gives is a pure function of the file, so a test that passes today
 * passes in five years on a plane.
 *
 * Behavioural note: unlike `RadioBrowserProvider`, popularity is passed through
 * exactly as stored rather than renormalised per result set. The fixture's
 * numbers *are* the directory-wide truth here, and "what you put in is what you
 * get out" is worth more than symmetry for a provider whose job is determinism.
 */

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type {
  DirectoryProvider,
  GenreTag,
  RegisterIndex,
  RegisterPlace,
  RegisterTongue,
  StationQuery,
  StationRef,
} from '../../shared/contracts';
import { DirectoryError } from './http';
import { cleanTags, type RawTag } from './tags';

export const DEFAULT_FIXTURE_DIR = path.resolve(process.cwd(), 'test', 'fixtures', 'directory');
export const STATIONS_FILE = 'stations.json';

export interface FixtureProviderOptions {
  /** Directory containing `stations.json`. Defaults to `<cwd>/test/fixtures/directory`. */
  dir?: string;
  /** Skip disk entirely and use this station list. */
  stations?: StationRef[];
}

export class FixtureProvider implements DirectoryProvider {
  readonly id = 'fixture';

  /** Station ids passed to `reportListening`, in order. Handy in tests. */
  readonly reported: string[] = [];

  private readonly dir: string;
  private readonly preloaded: StationRef[] | null;
  private cache: StationRef[] | null = null;

  constructor(options: FixtureProviderOptions = {}) {
    this.dir = options.dir ?? DEFAULT_FIXTURE_DIR;
    this.preloaded = options.stations ?? null;
  }

  /** Load (and cache) the station set. */
  async stations(): Promise<StationRef[]> {
    if (this.preloaded) return this.preloaded;
    if (this.cache) return this.cache;
    const file = path.join(this.dir, STATIONS_FILE);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (err) {
      throw new DirectoryError(
        'network',
        `Fixture directory unreadable at ${file}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new DirectoryError('malformed', `${file} is not valid JSON`);
    }
    if (!Array.isArray(parsed)) {
      throw new DirectoryError('malformed', `${file} must contain an array of stations`);
    }
    this.cache = parsed as StationRef[];
    return this.cache;
  }

  /**
   * Genres counted from the stations that are actually present, then put
   * through the same junk filter the live provider uses — so the fixture band
   * selector behaves like the real one rather than being hand-curated.
   */
  async listGenres(minStations: number): Promise<GenreTag[]> {
    const stations = await this.stations();
    const counts = new Map<string, number>();
    for (const station of stations) {
      for (const tag of station.tags ?? []) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    const raw: RawTag[] = [...counts.entries()].map(([name, count]) => ({ name, count }));
    return cleanTags(raw, minStations);
  }

  /**
   * The same index the live provider builds, counted off the fixture file.
   *
   * Deliberately not hand-written: a fixture whose index disagreed with its own
   * stations would let a register bug pass every offline test.
   */
  async listIndex(): Promise<RegisterIndex> {
    const stations = await this.stations();
    const subjects = await this.listGenres(1);

    const originCounts = new Map<string, { name: string; count: number }>();
    const tongueCounts = new Map<string, number>();
    for (const station of stations) {
      const code = station.countryCode?.trim().toUpperCase();
      if (code && code.length === 2) {
        const entry = originCounts.get(code) ?? { name: station.country ?? code, count: 0 };
        entry.count++;
        originCounts.set(code, entry);
      }
      for (const tongue of stationTongues(station)) {
        tongueCounts.set(tongue, (tongueCounts.get(tongue) ?? 0) + 1);
      }
    }

    const origins: RegisterPlace[] = [...originCounts.entries()]
      .map(([code, v]) => ({ code, name: v.name, stationCount: v.count }))
      .sort((a, b) => b.stationCount - a.stationCount || a.name.localeCompare(b.name));
    const tongues: RegisterTongue[] = [...tongueCounts.entries()]
      .map(([name, stationCount]) => ({ name, stationCount }))
      .sort((a, b) => b.stationCount - a.stationCount || a.name.localeCompare(b.name));

    return {
      source: this.id,
      // Fixed, not `Date.now()`: this provider's whole contract is that the
      // same file gives the same answer, and a timestamp would break that.
      pulledAt: 0,
      totals: {
        stations: stations.length,
        tags: subjects.length,
        countries: origins.length,
        languages: tongues.length,
      },
      subjects,
      origins,
      tongues,
    };
  }

  async search(query: StationQuery): Promise<StationRef[]> {
    const stations = await this.stations();
    const genre = query.genre?.trim().toLowerCase();
    const country = query.countryCode?.trim().toUpperCase();
    const language = query.language?.trim().toLowerCase();
    const text = query.text?.trim().toLowerCase();

    const matched = stations.filter((station) => {
      if (genre && !(station.tags ?? []).includes(genre)) return false;
      if (country && (station.countryCode ?? '').toUpperCase() !== country) return false;
      // Any of the station's tongues, exactly as the live directory's own
      // `language=` query matches: a station listed `english,german` is part of
      // the German population and has to come back from a German fetch.
      if (language && !stationTongues(station).includes(language)) return false;
      if (text) {
        const haystack = `${station.name} ${(station.tags ?? []).join(' ')}`.toLowerCase();
        if (!haystack.includes(text)) return false;
      }
      return true;
    });

    // Strongest first, with id as a total tiebreak so the order can never
    // depend on the file's own ordering or on sort stability.
    matched.sort((a, b) => b.popularity - a.popularity || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

    const offset = Math.max(0, Math.floor(query.offset ?? 0));
    const limit = Math.max(0, Math.floor(query.limit));
    return matched.slice(offset, offset + limit).map((s) => ({ ...s }));
  }

  async reportListening(stationId: string): Promise<void> {
    this.reported.push(stationId);
  }
}

/**
 * Every tongue on a fixture station's record, lowercased.
 *
 * The fixture file predates `StationRef.languages`, so the single field is still
 * honoured; a fixture that carries the list gets list semantics, which is what
 * keeps this provider's answers the same shape as the live one's.
 */
function stationTongues(station: StationRef): string[] {
  const list = station.languages;
  if (list && list.length > 0) return list.map((l) => l.trim().toLowerCase()).filter(Boolean);
  const one = station.language?.trim().toLowerCase();
  return one ? [one] : [];
}
