/**
 * Dev harness.
 *
 * Wires the faceplate to the mock engine and exposes `window.__harness` so a
 * screenshot driver can march the panel through every playback phase without
 * clicking anything. A small control bar rides along the bottom for humans;
 * `?chrome=0` hides it so captures show only the receiver.
 */

import '../../styles/index.css';
/* The harness's own chrome. It lives here rather than in styles/index.css so
   that the production entry cannot reach it: index.css is loaded by ui/boot.ts,
   so an @import there put `.harness-bar` and `.harness-focus-demo` into every
   shipped stylesheet. Same rule as the mock feeder, same enforcement — see
   test/ui/no-mock-in-production.test.ts. */
import '../../styles/harness.css';
import type { PlaybackPhase, Preset } from '../../../shared/contracts';
import { mountFaceplate } from '../index';
import type { FaceplateHandle } from '../types';
import { COUNTRIES, GENRES, MockEngine, searchStations } from './mock';

const PHASES: PlaybackPhase[] = [
  'idle',
  'resolving',
  'connecting',
  'buffering',
  'playing',
  'stalled',
  'reconnecting',
  'error',
];

const params = new URLSearchParams(location.search);
const showChrome = params.get('chrome') !== '0';

const root = document.getElementById('app')!;
let handle: FaceplateHandle;
let lidOpen = false;

const engine = new MockEngine(() => paint());

function paint(): void {
  handle.render(engine.state, engine.band, engine.settings);
  handle.setPresets(engine.presets);
}

handle = mountFaceplate(root, {
  onPower(next) {
    engine.power(next);
  },
  onTune(position, phase) {
    if (phase !== 'commit') return;
    // A host maps dial position onto a station; this mock does the same.
    let best = engine.band.slots[0];
    let bestD = Infinity;
    for (const s of engine.band.slots) {
      const d = Math.abs(s.position - position);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    if (!best || bestD > best.width * 1.4) return;
    if (engine.state.station?.id === best.station.id) return;
    if (engine.state.phase === 'idle') return;
    engine.tuneTo(best.station);
  },
  onScope(scope) {
    // The harness has no directory: the first pulled term stands in for a genre.
    engine.setGenre(scope.terms[0] ?? GENRES[0]!.name);
    pushResults('');
  },
  onCut: () => pushResults(''),
  onReprint: () => pushResults(''),
  // The harness always has a band on the drum, so this is unreachable here. The
  // shipping host answers it on the annunciator.
  onDialLocked: () => {},
  onSelectMeterBand: () => pushResults(''),
  onSelectStation(id) {
    const found =
      engine.band.slots.find((s) => s.station.id === id)?.station ??
      lastResults.find((s) => s.id === id);
    if (found) engine.tuneTo(found);
  },
  onSetVolume: (v) => engine.patchSettings({ volume: v }),
  onSetBass: (v) => engine.patchSettings({ bassDb: v }),
  onSetTreble: (v) => engine.patchSettings({ trebleDb: v }),
  onSetNoiseFloor: (v) => engine.patchSettings({ noiseFloor: v }),
  onToggleAfc: (on) => engine.patchSettings({ afcEnabled: on }),
  onSetBufferDepth: (d) => engine.patchSettings({ bufferDepth: d }),
  onToggleDialLamp: (on) => engine.patchSettings({ dialLampOn: on }),
  onRecallPreset(slot) {
    const p = engine.presets.find((x) => x.slot === slot);
    if (p) engine.tuneTo(p.station);
  },
  onStorePreset(slot: Preset['slot']) {
    engine.storePreset(slot);
  },
  onReconnect() {
    if (engine.state.station) engine.tuneTo(engine.state.station);
  },
  onLidToggle(open) {
    lidOpen = open;
    handle.setLidOpen(open);
  },
});

let lastResults = searchStations('', engine.genre);

function pushResults(query: string): void {
  handle.setBrowseResults({ query, stations: [], loading: true });
  window.setTimeout(() => {
    lastResults = searchStations(query, engine.genre);
    handle.setBrowseResults({ query, stations: lastResults, loading: false });
  }, 220);
}

handle.setIndex(
  {
    source: 'harness',
    pulledAt: 0,
    totals: { stations: 0, tags: GENRES.length, countries: COUNTRIES.length, languages: 0 },
    subjects: GENRES,
    origins: COUNTRIES.map((c) => ({ code: c.code, name: c.name, stationCount: 0 })),
    tongues: [],
  },
  null,
);
handle.setBrowseResults({ query: '', stations: lastResults, loading: false });
paint();

// ---------------------------------------------------------------------------
// Screenshot / scripting surface

declare global {
  interface Window {
    __harness: {
      phases: PlaybackPhase[];
      setPhase(p: PlaybackPhase): void;
      setLid(open: boolean): void;
      setLamp(on: boolean): void;
      setGenre(g: string): void;
      settle(): Promise<void>;
    };
  }
}

window.__harness = {
  phases: PHASES,
  setPhase(p) {
    engine.pinned = true;
    if (p !== 'idle' && !engine.state.station) {
      engine.state = { ...engine.state, station: engine.band.slots[6].station };
    }
    engine.setPhase(p);
  },
  setLid(open) {
    lidOpen = open;
    handle.setLidOpen(open);
  },
  setLamp(on) {
    engine.patchSettings({ dialLampOn: on });
  },
  setGenre(g) {
    engine.setGenre(g);
  },
  settle() {
    return new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => window.setTimeout(resolve, 40)));
    });
  },
};

// ---------------------------------------------------------------------------
// Human control bar

if (showChrome) {
  const bar = document.createElement('div');
  bar.className = 'harness-bar';

  const mk = (label: string, fn: () => void) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', fn);
    bar.append(b);
    return b;
  };

  for (const p of PHASES) mk(p, () => window.__harness.setPhase(p));
  const sep = document.createElement('span');
  sep.className = 'harness-sep';
  bar.append(sep);
  mk('live', () => {
    engine.pinned = false;
    engine.power(true);
  });
  mk('lid', () => window.__harness.setLid(!lidOpen));
  mk('lamp', () => engine.patchSettings({ dialLampOn: !engine.settings.dialLampOn }));

  document.body.append(bar);
  document.body.classList.add('has-harness-bar');
}
