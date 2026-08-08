/**
 * A mock state feeder for standalone development.
 *
 * This is NOT part of the faceplate. It stands in for the audio engine so the
 * panel can be built, driven through every phase and screenshotted without an
 * audio stack — and so `npm run dev` shows a working radio rather than a dead
 * one. The integrator replaces it wholesale; the faceplate cannot tell the
 * difference, because it only ever sees PlaybackState / Band / Settings.
 */

import type {
  Band,
  GenreTag,
  PlaybackPhase,
  PlaybackState,
  Preset,
  Settings,
  StationRef,
} from '../../../shared/contracts';
import { DEFAULT_SETTINGS, INITIAL_PLAYBACK_STATE } from '../../../shared/contracts';

/**
 * Genres for the harness. Spellings are derived rather than typed out: the
 * fold is a property of the real directory, and a mock that hand-wrote a
 * spelling list would be asserting something the directory never said.
 */
export const GENRES: GenreTag[] = ([
  ['ambient', 412],
  ['blues', 968],
  ['classical', 2311],
  ['country', 1877],
  ['dance', 3402],
  ['drum and bass', 284],
  ['dub', 176],
  ['electronic', 2854],
  ['folk', 743],
  ['funk', 512],
  ['hip hop', 2109],
  ['house', 1644],
  ['indie', 1201],
  ['jazz', 1893],
  ['latin', 2477],
  ['lounge', 638],
  ['metal', 1382],
  ['news', 4120],
  ['oldies', 2966],
  ['pop', 5841],
  ['progressive', 402],
  ['punk', 388],
  ['reggae', 891],
  ['rock', 6233],
  ['schlager', 559],
  ['soul', 806],
  ['talk', 2088],
  ['techno', 1155],
  ['trance', 977],
  ['world', 1490],
] as Array<[string, number]>).map(([name, stationCount]) => ({
  name,
  stationCount,
  spellings: [name],
}));

export const COUNTRIES: Array<{ code: string; name: string }> = [
  { code: 'AR', name: 'Argentina' },
  { code: 'AU', name: 'Australia' },
  { code: 'AT', name: 'Austria' },
  { code: 'BR', name: 'Brazil' },
  { code: 'CA', name: 'Canada' },
  { code: 'CL', name: 'Chile' },
  { code: 'CZ', name: 'Czechia' },
  { code: 'DK', name: 'Denmark' },
  { code: 'FI', name: 'Finland' },
  { code: 'FR', name: 'France' },
  { code: 'DE', name: 'Germany' },
  { code: 'GR', name: 'Greece' },
  { code: 'IN', name: 'India' },
  { code: 'IE', name: 'Ireland' },
  { code: 'IT', name: 'Italy' },
  { code: 'JP', name: 'Japan' },
  { code: 'MX', name: 'Mexico' },
  { code: 'NL', name: 'Netherlands' },
  { code: 'NZ', name: 'New Zealand' },
  { code: 'NO', name: 'Norway' },
  { code: 'PL', name: 'Poland' },
  { code: 'PT', name: 'Portugal' },
  { code: 'RU', name: 'Russia' },
  { code: 'ZA', name: 'South Africa' },
  { code: 'ES', name: 'Spain' },
  { code: 'SE', name: 'Sweden' },
  { code: 'CH', name: 'Switzerland' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'US', name: 'United States' },
];

const NAME_PARTS_A = [
  'Radio', 'Antenne', 'Rádio', 'Radiodiffusion', 'Sender', 'KEXP', 'WFMU', 'Studio', 'Nordwelle',
  'Deep', 'Blue', 'Nova', 'Éter', 'Kanal', 'Onda', 'Frequenz', 'Vintage', 'Cosmic', 'Nachtfahrt',
];
const NAME_PARTS_B = [
  'Italo4you', 'Paradise', 'Caroline', 'Luxembourg', 'Nacht', 'Swiss', 'Bremen', 'Praha',
  'Continental', 'Atlantico', 'Nordsee', 'Vaticana', 'Habana', 'Lisboa', 'Tirana', 'Yerevan',
  'Reykjavík', 'Bamako', 'Nairobi', 'Osaka', 'Valparaíso', 'Montevideo', 'Kaliningrad',
];

const GEO: [number, number, string, string][] = [
  [52.5, 13.4, 'DE', 'Germany'], [48.9, 2.35, 'FR', 'France'], [51.5, -0.13, 'GB', 'United Kingdom'],
  [41.9, 12.5, 'IT', 'Italy'], [40.4, -3.7, 'ES', 'Spain'], [38.7, -9.14, 'PT', 'Portugal'],
  [59.3, 18.1, 'SE', 'Sweden'], [60.2, 24.9, 'FI', 'Finland'], [55.7, 12.6, 'DK', 'Denmark'],
  [52.4, 4.9, 'NL', 'Netherlands'], [50.1, 14.4, 'CZ', 'Czechia'], [52.2, 21.0, 'PL', 'Poland'],
  [55.8, 37.6, 'RU', 'Russia'], [37.98, 23.7, 'GR', 'Greece'], [47.4, 8.5, 'CH', 'Switzerland'],
  [40.7, -74.0, 'US', 'United States'], [37.8, -122.4, 'US', 'United States'],
  [34.05, -118.2, 'US', 'United States'], [41.9, -87.6, 'US', 'United States'],
  [49.3, -123.1, 'CA', 'Canada'], [45.5, -73.6, 'CA', 'Canada'], [19.4, -99.1, 'MX', 'Mexico'],
  [-23.5, -46.6, 'BR', 'Brazil'], [-34.6, -58.4, 'AR', 'Argentina'], [-33.5, -70.7, 'CL', 'Chile'],
  [-26.2, 28.0, 'ZA', 'South Africa'], [-1.3, 36.8, 'KE', 'Kenya'], [30.0, 31.2, 'EG', 'Egypt'],
  [35.7, 139.7, 'JP', 'Japan'], [28.6, 77.2, 'IN', 'India'], [1.35, 103.8, 'SG', 'Singapore'],
  [-33.9, 151.2, 'AU', 'Australia'], [-36.8, 174.8, 'NZ', 'New Zealand'],
  [64.1, -21.9, 'IS', 'Iceland'], [21.3, -157.9, 'US', 'United States'],
  [61.2, -149.9, 'US', 'United States'], [22.3, 114.2, 'HK', 'Hong Kong'],
  [14.6, 121.0, 'PH', 'Philippines'], [-6.2, 106.8, 'ID', 'Indonesia'], [35.7, 51.4, 'IR', 'Iran'],
];

const CODECS: [string, string][] = [
  ['audio/mpeg', 'MP3'],
  ['audio/aacp', 'AAC+'],
  ['audio/aac', 'AAC'],
  ['audio/ogg', 'OGG'],
];

/** Deterministic PRNG — the same genre always lays out the same way. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

export function stationsFor(genre: string, count = 26): StationRef[] {
  const seed = [...genre].reduce((a, c) => a * 31 + c.charCodeAt(0), 7);
  const r = rng(seed);
  const out: StationRef[] = [];
  for (let i = 0; i < count; i++) {
    const g = GEO[Math.floor(r() * GEO.length)];
    const codec = CODECS[Math.floor(r() * CODECS.length)][1];
    const a = NAME_PARTS_A[Math.floor(r() * NAME_PARTS_A.length)];
    const b = NAME_PARTS_B[Math.floor(r() * NAME_PARTS_B.length)];
    out.push({
      id: `${genre}-${i}`,
      name: `${a} ${b}`,
      url: `https://example.invalid/${genre}/${i}`,
      tags: [genre, ['deep', 'classic', '24h', 'live', 'nonstop'][Math.floor(r() * 5)]],
      countryCode: g[2],
      country: g[3],
      language: undefined,
      claimedBitrate: [64, 96, 128, 192, 256, 320][Math.floor(r() * 6)],
      claimedCodec: codec,
      popularity: Math.round(r() * 1000) / 1000,
      geo: { lat: g[0] + (r() - 0.5) * 4, lon: g[1] + (r() - 0.5) * 6 },
    });
  }
  return out;
}

export function bandFor(genre: string): Band {
  const stations = stationsFor(genre);
  const seed = [...genre].reduce((a, c) => a * 17 + c.charCodeAt(0), 3);
  const r = rng(seed);
  // Real transmitters are not evenly spaced; jitter each slot within its share.
  const slots = stations
    .map((station, i) => {
      const share = 1 / stations.length;
      const jitter = (r() - 0.5) * share * 0.8;
      return {
        station,
        position: Math.min(0.985, Math.max(0.015, (i + 0.5) * share + jitter)),
        width: 0.004 + station.popularity * 0.011,
      };
    })
    .sort((a, b) => a.position - b.position);

  const kHz = seed % 2 === 0;
  return {
    genre,
    stationCount: GENRES.find((g) => g.name === genre)?.stationCount ?? stations.length,
    slots,
    scaleMin: kHz ? 150 : 88,
    scaleMax: kHz ? 1600 : 108,
    scaleUnit: kHz ? 'kHz' : 'MHz',
  };
}

const TITLES = [
  'Energy Voice - Discolights (MDR Extended Party Mix)',
  'Alice Coltrane - Journey in Satchidananda',
  'Kraftwerk - Radioaktivität',
  'Sun Ra & His Arkestra - Space Is the Place',
  'Nachrichten',
  'Broadcast - Come On Let’s Go',
  'Ryuichi Sakamoto - Merry Christmas Mr. Lawrence (Live at the Royal Festival Hall, London, 2018 Remaster)',
  'Os Mutantes - A Minha Menina',
];

export interface MockFeed {
  state: PlaybackState;
  band: Band;
  settings: Settings;
  presets: Preset[];
}

/**
 * Drives a PlaybackState the way a real engine would: phases advance on their
 * own timers, the signal level comes from a running "RMS", and nothing the UI
 * does changes any of it directly.
 */
export class MockEngine {
  state: PlaybackState = { ...INITIAL_PLAYBACK_STATE };
  settings: Settings = { ...DEFAULT_SETTINGS };
  /** The harness opens on the biggest mock genre; the app opens on a cut. */
  genre = GENRES[0]!.name;
  band: Band = bandFor(GENRES[0]!.name);
  presets: Preset[] = [];

  private timer = 0;
  private raf = 0;
  private t0 = 0;
  private titleIdx = 0;
  private onChange: () => void;
  /** When true, phases hold where they are put — the harness is driving. */
  pinned = false;

  constructor(onChange: () => void) {
    this.onChange = onChange;
    const stations = this.band.slots.map((s) => s.station);
    this.presets = [
      { slot: 'C', station: stations[3], savedAt: Date.now() - 8e6 },
      { slot: 'B', station: stations[11], savedAt: Date.now() - 4e6 },
    ];
    this.loop();
  }

  private emit(): void {
    this.onChange();
  }

  private clearTimer(): void {
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = 0;
  }

  setPhase(phase: PlaybackPhase, station?: StationRef): void {
    this.clearTimer();
    const s = station ?? this.state.station ?? this.band.slots[6].station;
    const base: PlaybackState = {
      ...this.state,
      phase,
      station: phase === 'idle' ? undefined : s,
    };

    switch (phase) {
      case 'idle':
        Object.assign(base, {
          station: undefined,
          stream: undefined,
          nowPlaying: undefined,
          error: undefined,
          measuredBitrateKbps: undefined,
          sampleRate: undefined,
          bufferedSeconds: 0,
          playingSeconds: 0,
          bytesReceived: 0,
          signalLevel: 0,
        });
        break;
      case 'resolving':
        Object.assign(base, {
          stream: undefined,
          nowPlaying: undefined,
          error: undefined,
          measuredBitrateKbps: undefined,
          sampleRate: undefined,
          bufferedSeconds: 0,
          playingSeconds: 0,
          bytesReceived: 0,
          signalLevel: 0,
        });
        break;
      case 'connecting':
        Object.assign(base, {
          stream: {
            url: s.url,
            contentType: CODECS.find((c) => c[1] === s.claimedCodec)?.[0] ?? 'audio/mpeg',
            icyBitrate: s.claimedBitrate,
            icyName: s.name,
            supportsIcyMetadata: true,
            origin: 'pls' as const,
          },
          bufferedSeconds: 0,
          signalLevel: 0,
          bytesReceived: 2048,
        });
        break;
      case 'buffering':
        Object.assign(base, { bufferedSeconds: 1.4, signalLevel: 0, bytesReceived: 48_000 });
        break;
      case 'playing':
        this.t0 = performance.now();
        Object.assign(base, {
          error: undefined,
          measuredBitrateKbps: 247,
          sampleRate: 44100,
          bufferedSeconds: 8.6,
          bytesReceived: 3_820_000,
          nowPlaying: { title: TITLES[this.titleIdx % TITLES.length], receivedAt: Date.now() },
        });
        break;
      case 'stalled':
        Object.assign(base, { signalLevel: 0, bufferedSeconds: 0.2 });
        break;
      case 'reconnecting':
        Object.assign(base, {
          signalLevel: 0,
          bufferedSeconds: 0,
          error: { kind: 'upstream-closed' as const, message: 'upstream closed the socket', attempts: 2 },
        });
        break;
      case 'error':
        Object.assign(base, {
          signalLevel: 0,
          bufferedSeconds: 0,
          error: { kind: 'http' as const, message: '502 from the relay after 4 tries', attempts: 4 },
        });
        break;
    }
    this.state = base;
    this.emit();
  }

  /** The full honest sequence a real tune-in goes through. */
  tuneTo(station: StationRef): void {
    if (this.pinned) {
      this.state = { ...this.state, station };
      this.emit();
      return;
    }
    this.titleIdx++;
    this.setPhase('resolving', station);
    this.timer = window.setTimeout(() => {
      this.setPhase('connecting', station);
      this.timer = window.setTimeout(() => {
        this.setPhase('buffering', station);
        this.timer = window.setTimeout(() => this.setPhase('playing', station), 900);
      }, 620);
    }, 480);
  }

  power(on: boolean): void {
    if (!on) {
      this.setPhase('idle');
      return;
    }
    const last = this.state.station ?? this.band.slots[6].station;
    this.tuneTo(last);
  }

  setGenre(genre: string): void {
    this.genre = genre;
    this.band = bandFor(genre);
    this.emit();
  }

  patchSettings(patch: Partial<Settings>): void {
    this.settings = { ...this.settings, ...patch };
    this.emit();
  }

  storePreset(slot: Preset['slot']): void {
    if (!this.state.station) return;
    this.presets = [
      ...this.presets.filter((p) => p.slot !== slot),
      { slot, station: this.state.station, savedAt: Date.now() },
    ];
    this.emit();
  }

  /** A running signal level, the way an AnalyserNode would produce one. */
  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);
    if (this.state.phase !== 'playing') return;
    const t = (performance.now() - this.t0) / 1000;
    const rms =
      0.52 +
      0.19 * Math.sin(t * 1.9) +
      0.11 * Math.sin(t * 5.3 + 1.1) +
      0.07 * Math.sin(t * 11.7 + 0.4) +
      0.05 * (Math.random() - 0.5);
    this.state = {
      ...this.state,
      signalLevel: Math.max(0, Math.min(1, rms)),
      playingSeconds: t,
      bytesReceived: 3_820_000 + Math.round(t * 31_000),
      bufferedSeconds: 8.6 + Math.sin(t * 0.7) * 1.2,
    };
    this.emit();
  };

  destroy(): void {
    this.clearTimer();
    cancelAnimationFrame(this.raf);
  }
}

export function searchStations(query: string, genre: string): StationRef[] {
  const pool = [...stationsFor(genre, 26), ...stationsFor('pop', 20), ...stationsFor('news', 14)];
  if (!query) return pool.slice(0, 30);
  const q = query.toLowerCase();
  return pool.filter((s) => s.name.toLowerCase().includes(q) || (s.country ?? '').toLowerCase().includes(q));
}
