/**
 * The faceplate's public surface.
 *
 * ARCHITECTURAL RULE: this UI is pure presentation. It renders exactly the
 * `PlaybackState` / `Band` / `Settings` it is handed and nothing else. It never
 * infers, caches or optimistically advances playback truth. Pressing POWER does
 * not light the lamp; the engine reporting a non-idle phase lights the lamp.
 *
 * Controls therefore have two visual channels:
 *   - *input feedback* (a button physically depresses, a knob rotates under the
 *     finger) which is a statement about the user's hand, not about the radio;
 *   - *state display* (lamps, meter, readout, dial pointer) which is a statement
 *     about the engine and comes only from `render()`.
 */

import type {
  Band,
  Cut,
  LogEntry,
  PlaybackState,
  Preset,
  RegisterIndex,
  RegisterScope,
  Settings,
  StationRef,
} from '../../shared/contracts';

/** Result set for the register's sheet. */
export interface BrowseResults {
  query: string;
  stations: StationRef[];
  /** True while the host is fetching; the list shows a scanning state. */
  loading: boolean;
  /**
   * Which population `stations` actually *is*, as `supersetKey` names it.
   *
   * Not decoration and not a hint: it is the only thing that makes the
   * register's counts measurements rather than leftovers. `loading: false` says
   * "this fetch is finished", which is a fact about the fetch — the register
   * needs a fact about the *rows*, because the scope can change while a fetch is
   * in flight and the answer that then arrives is an answer to a question nobody
   * is asking any more. Undefined means "these rows answer nothing", which is
   * the honest state before the first fetch settles.
   */
  key?: string;
  error?: string;
  /**
   * The result is real but known to be short — today, a folded genre whose
   * expansion partly failed. Printed alongside the count, never instead of it:
   * "46 STATIONS" and "PARTIAL" are two different facts (Law 4).
   */
  warning?: string;
}


/**
 * Something the panel has to say out loud.
 *
 * Law 4 requires every failure to surface as words the listener can act on. The
 * host used to post those words through `BrowseResults.error`, i.e. onto the
 * register's sheet — a surface that is behind a lid, is conditioned on the
 * sheet having zero rows, and did not exist at all in the earlier design the
 * strings were written for. Pressing RADIO ON with nothing on the dial
 * therefore changed nothing anywhere: the message was posted to a component
 * that never displays it.
 *
 * This is the replacement, and it lands on the front panel, which is the only
 * surface guaranteed to be in front of the user when they press a panel button.
 */
export interface PanelNotice {
  /** Silkscreen voice, short. What state the receiver is in. */
  headline: string;
  /**
   * What to do next, in words a stranger understands, naming only controls
   * that are on the current faceplate. No control that has been cut from the
   * design may ever appear here.
   */
  action: string;
  /** `fault` is a red annunciator; `advice` is the amber one. */
  tone: 'fault' | 'advice';
  /**
   * Monotonic. Pressing a dead control twice must visibly do something twice,
   * so an identical message with a fresh `seq` re-strikes the lamp.
   */
  seq: number;
}

/**
 * User intents. Every one of these is a *request*. None of them may be assumed
 * to have succeeded — the host answers by calling `render()` with new truth.
 */
export interface FaceplateHandlers {
  /** RADIO ON/STANDBY pressed. `next` is what the user is asking for. */
  onPower(next: boolean): void;

  /**
   * MW/SW TUNING knob moved. `position` is 0..1 across the current band's scale.
   * `phase` is 'drag' while the flywheel is still spinning (throttled to one
   * call per frame) and 'commit' when it settles or the user releases onto a
   * slot. Hosts that only want the final answer can ignore 'drag'.
   */
  onTune(position: number, phase: 'drag' | 'commit'): void;

  /**
   * A hand tried to turn the flywheel (or scrub the drum) with nothing printed
   * on it.
   *
   * A gesture, not a per-frame report: it fires once per attempt, so the host
   * may answer it on the annunciator without a message per pointer sample.
   *
   * It exists because the biggest control on the panel was fully live over an
   * empty dial. A real four-turn arc drag moved the drum scale from 9590–9710
   * kHz to 9740–9860 kHz with the pointer lit while `document.body.innerText`
   * stayed byte-identical: no station, no blip, no notice, nothing anywhere
   * saying the dial had nothing on it. Its own neighbour already refuses
   * correctly — METER BAND is `is-disabled`, reads `no band cut`, and
   * silkscreens `METER BAND · LOCKED`.
   */
  onDialLocked(): void;

  /** A station was picked directly (dial blip, preset, register entry). */
  onSelectStation(stationId: string): void;

  /** The register's cards changed. The host refetches the scope. */
  onScope(scope: RegisterScope): void;

  /** CUT BAND thrown: print these rows onto the drum and shut the lid. */
  onCut(rows: StationRef[], caption: string, quality: string): void;

  /** REPRINT EDITION: pull the register's index again. */
  onReprint(): void;

  /** METER BAND turned: print band `index` of the current cut onto the drum. */
  onSelectMeterBand(index: number): void;

  onSetVolume(volume: number): void;         // 0..1
  onSetBass(db: number): void;               // -12..+12
  onSetTreble(db: number): void;             // -12..+12
  onSetNoiseFloor(level: number): void;      // 0..1   AM RF GAIN
  onToggleAfc(enabled: boolean): void;
  onSetBufferDepth(depth: 'narrow' | 'wide'): void;
  onToggleDialLamp(on: boolean): void;

  /** C / B / P: click recalls, press-and-hold stores. */
  onRecallPreset(slot: Preset['slot']): void;
  onStorePreset(slot: Preset['slot']): void;

  /** RECONNECT. Failure and recovery are first-class here. */
  onReconnect(): void;

  /** The hinged lid was opened or closed. */
  onLidToggle(open: boolean): void;
}

export interface FaceplateHandle {
  /** The one true render path. Idempotent; safe to call every engine tick. */
  render(state: PlaybackState, band: Band, settings: Settings): void;

  /**
   * The needle's fast path: a new reading, and nothing else.
   *
   * `signalLevel` is the one quantity on this panel that moves at frame rate —
   * the host reads the analyser every rAF so the movement tracks real RMS
   * rather than the engine's 10 Hz emit. Everything else in `render()` — the
   * band layout, the knobs, the readout's station line, the register's on-air
   * mark — changes only when the engine, the directory or a hand changes it,
   * which is at most ten times a second and usually far less.
   *
   * Calling the full `render()` for a level that moved by 0.01 therefore ran
   * the whole panel's revision — a `slots.map().join()` band key, ~60 guarded
   * attribute compares, a rebuilt phase sentence — at 57 Hz to move one
   * transform. This pushes the reading to the two things that are functions of
   * it and stops: the movement, and the readout's silence guard (which is what
   * stops the badge printing LOCKED over a needle on its zero stop).
   *
   * NOT a second render path: it may never paint anything that is not a pure
   * function of the level. Anything structural sets the host's `dirty` flag and
   * takes a full `render()` on the next frame.
   */
  renderLevel(level: number): void;

  /** The register's printed index, or null with the reason it is not printed. */
  setIndex(index: RegisterIndex | null, fault: string | null): void;
  /** Rows for the current scope — feeds the register's sheet. */
  setBrowseResults(results: BrowseResults): void;
  /** The scope the host is holding, so the register's controls agree with it. */
  setScope(scope: RegisterScope): void;
  /** What the register cut onto the drum. `struck` fires the plate's lamp. */
  setCut(cut: Cut | null, bandIndex: number, struck: boolean): void;
  /** Occupied preset slots — feeds the C/B/P jewels. */
  setPresets(presets: Preset[]): void;
  /**
   * Post (or clear) the panel's spoken state. Applied synchronously, because
   * the whole point is that a button press changes the panel now and not on
   * some later engine tick.
   */
  setNotice(notice: PanelNotice | null): void;
  /** The logbook: stations actually heard, most recent first. */
  setLog(entries: LogEntry[]): void;

  /** Open/close the lid programmatically (does not re-fire onLidToggle). */
  setLidOpen(open: boolean): void;
  isLidOpen(): boolean;

  destroy(): void;
}

/** Everything the faceplate keeps in order to paint one frame. */
export interface ViewModel {
  state: PlaybackState;
  band: Band;
  settings: Settings;
  index: RegisterIndex | null;
  presets: Preset[];
  browse: BrowseResults;
  cut: Cut | null;
  lidOpen: boolean;
  notice: PanelNotice | null;
  log: LogEntry[];
}

/** True when the receiver has left standby. Derived, never stored. */
export function isPowered(state: PlaybackState): boolean {
  return state.phase !== 'idle';
}

/**
 * What the panel is allowed to say about the station in `state.station`.
 *
 * Law 2 forbids by name what this replaces. The register's on-air mark, the
 * drum's lit blip and the band plate's hint were all derived from
 * `isPowered(state) && state.station`, i.e. from *"a station has been asked
 * for"*, which is intent. Measured on the running product: a station clicked in
 * the register failed with `phase: "error"` and its row still carried the orange
 * on-air marker and `aria-selected="true"` thirty-six seconds later, while the
 * band plate simultaneously printed `PLAYING ONE STATION` beside
 * `FAULT — HTTP … ANSWERED 404` — two surfaces asserting playback the engine had
 * explicitly reported it was not doing.
 *
 * Four states, because a receiver has four honest things to say about a station:
 *
 *   · `off`    — standby. Nothing is claimed about anything.
 *   · `trying` — the engine is working on it. Resolving, opening a socket,
 *                filling a buffer, or re-locking after a drop. Not on air.
 *   · `on`     — the decoder is producing audio. **This and only this is on air.**
 *   · `failed` — the attempt is over and it did not work, or it was working and
 *                the signal went. It stays failed until something re-tries it,
 *                which is what makes RECONNECT's job visible.
 *
 * Pure and derived per frame, so it cannot go stale the way a stored flag can —
 * which is the mechanism by which a marker survived its station by half a minute.
 */
export type AirState = 'off' | 'trying' | 'on' | 'failed';

export function airStateOf(state: PlaybackState): AirState {
  switch (state.phase) {
    case 'idle':
      return 'off';
    case 'playing':
      return 'on';
    case 'error':
    // `stalled` is "it was playing and the bytes stopped". The station is not on
    // the air, the meter is on its zero stop, and RECONNECT's lamp is already
    // red for it — so the mark has to come off, exactly as for a terminal fault.
    case 'stalled':
      return 'failed';
    case 'resolving':
    case 'connecting':
    case 'buffering':
    case 'reconnecting':
      return 'trying';
  }
}

/** Human label for the phase, as silkscreened on the status strip. */
export const PHASE_LABEL: Record<PlaybackState['phase'], string> = {
  idle: 'STANDBY',
  resolving: 'RESOLVING',
  connecting: 'CONNECTING',
  buffering: 'BUFFERING',
  playing: 'LOCKED',
  stalled: 'SIGNAL LOST',
  reconnecting: 'RE-LOCKING',
  error: 'FAULT',
};
