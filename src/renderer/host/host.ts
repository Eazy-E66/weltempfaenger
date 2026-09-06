/**
 * The host: the one place where the four slices meet.
 *
 * The faceplate expresses intents. The engine reports truth. The directory and
 * the resolver live in the main process behind the preload bridge. This module
 * owns the wire between them and nothing else — it has no DOM of its own, no
 * opinion about how a knob looks, and no opinion about what the audio is doing.
 *
 * Two rules govern everything below.
 *
 * Law 2 — playback state is measured, never asserted. No handler here writes a
 * phase, lights a lamp, or nudges the meter. A click calls `engine.tune()`;
 * whether anything is playing is answered later, by the engine, through
 * `subscribe`. The only value this module ever adds to a `PlaybackState` is a
 * fresher `signalLevel`, read synchronously from the same analyser the engine
 * reads, so the needle runs at frame rate instead of at the 10 Hz emit rate.
 *
 * Law 4 — failure is a designed state. Every await below has a losing branch
 * that ends in words on the panel: a directory that is unreachable, a genre
 * with no stations, a URL that resolves to nothing playable, a stream that
 * stops. None of them may end in a spinner that never stops.
 */

import {
  DEFAULT_SETTINGS,
  EMPTY_SCOPE,
  INITIAL_PLAYBACK_STATE,
  type Band,
  type Cut,
  type LogEntry,
  type PlayableStream,
  type PlaybackError,
  type PlaybackState,
  type Preset,
  type RegisterIndex,
  type RegisterScope,
  type Settings,
  type StationRef,
} from '../../shared/contracts';
import type { DirectoryFailure, StationMemory } from '../../main/ipc';
import { cutBands, layoutBand, lockStrengthAt, nearestSlot, slotAt } from '../../main/tuning/bandLayout';
import {
  PlaybackEngine,
  TuneResolutionError,
  getBridge,
  hasBridge,
  isAttended,
  onAttentionChange,
  type PsppcprBridge,
} from '../engine';
import type { BrowseResults, FaceplateHandle, FaceplateHandlers, PanelNotice } from '../ui/types';
import { isPowered } from '../ui/types';
import {
  computeView,
  qualityCaption,
  scopeCaption,
  scopeIsEmpty,
  supersetKey,
  supersetQuery,
  type SortKey,
} from '../ui/register/facets';
import { directoryFaultText, resolveFaultText, sheetSafe } from './faults';
import { recordHeard, normaliseLog } from './logbook';
import * as say from './notices';
import { DebouncedWriter } from './persist';

/**
 * Rows fetched for a pulled scope.
 *
 * High on purpose. The register's printed counts are only honest if a pulled
 * card fetches the *whole* population of its axis — the largest single term in
 * the live directory is `pop` at 5 933 — so anything lower would silently turn
 * every count into "of the top N".
 */
const SCOPE_LIMIT = 10000;
/**
 * Rows for the idle sheet, `ON AIR NOW · MOST LISTENED`.
 *
 * There is no axis to fetch here, so this is a page rather than a population,
 * and the register says so: with nothing pulled the combs print the
 * directory's own global counts instead of counting these rows.
 */
const IDLE_LIMIT = 2000;
/** Pulling three cards in a second is one intent, not three searches. */
const SCOPE_DEBOUNCE_MS = 220;
/**
 * Measured playing seconds after which the mount currently in use counts as
 * good, and RECONNECT's candidate walk for that station is reset.
 *
 * The same figure AFC uses to decide a stream has genuinely re-locked
 * (`AFC_STABLE_MS`), for the same reason: a mount that plays for two seconds and
 * dies has not proved anything.
 */
const CANDIDATE_SETTLED_S = 10;
/** Below this the needle has not visibly moved, so the frame is skipped. */
const LEVEL_EPSILON = 0.0015;
/**
 * The order a restored cut is re-derived in.
 *
 * The register's own default, because that is what it will be showing after a
 * relaunch: the sort is a register-side input that is not persisted, so
 * re-deriving with anything else would put a band on the drum that the sheet
 * standing behind it does not agree with.
 */
const RESTORE_SORT: SortKey = 'listeners';

/**
 * Are two readings the same reading?
 *
 * A deliberately shallow comparison over every own key of both objects. The
 * engine rebuilds the state object each tick but carries the nested `station`,
 * `error`, `stream` and `retry` values by reference, so identity is the right
 * test for them — and where it is not, the answer is "different", which costs
 * one render and can never show a stale panel. It is only ever used to *skip*
 * work, so a false negative is free and a false positive is impossible.
 */
function sameReading(a: PlaybackState, b: PlaybackState): boolean {
  if (a === b) return true;
  const ka = Object.keys(a) as (keyof PlaybackState)[];
  const kb = Object.keys(b) as (keyof PlaybackState)[];
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.is(a[k], b[k])) return false;
  return true;
}

export interface FaceplateHost {
  handlers: FaceplateHandlers;
  attach(handle: FaceplateHandle): void;
}

export class ReceiverHost implements FaceplateHost {
  readonly handlers: FaceplateHandlers;

  private bridge?: PsppcprBridge;
  private engine?: PlaybackEngine;
  private handle?: FaceplateHandle;

  private settings: Settings = { ...DEFAULT_SETTINGS };
  private memory: StationMemory = { presets: [] };
  /** The operator's log, newest first. Written from observed audio, never from a click. */
  private log: LogEntry[] = [];
  private index: RegisterIndex | null = null;
  private indexFault: string | null = null;
  /** What the register threw onto the drum, and which meter band is printed. */
  private cut: Cut | null = null;
  private cutBandIndex = 0;
  private band: Band = layoutBand('', [], { totalStations: 0 });
  private browse: BrowseResults = { query: '', stations: [], loading: true };
  private state: PlaybackState = INITIAL_PLAYBACK_STATE;

  private directoryFault: DirectoryFailure | null = null;
  /** Bumped per request so a slow answer can never overwrite a newer one. */
  private scopeGeneration = 0;
  private indexGeneration = 0;
  private scopeTimer: number | undefined;

  /**
   * What the panel is currently saying, and how many times it has been told to
   * say something. The counter is what makes the tenth press of a dead control
   * visibly different from the ninth.
   */
  private notice: PanelNotice | null = null;
  private noticeSeq = 0;

  /** Which resolved candidate to prefer per station; advanced by RECONNECT. */
  private readonly candidate = new Map<string, number>();
  /**
   * RECONNECT's own record: which station the presses are about, how many there
   * have been, and what the last fault on it said.
   *
   * All three exist so the control can be honest about a *persistent* fault. A
   * press is acknowledged from the count; a re-attempt that ends in the same
   * fault is recognised by comparing the sentence, and says so rather than
   * re-posting the first failure's words as though it were news.
   */
  private retryOf: string | undefined;
  private retryPresses = 0;
  private lastFaultText: string | undefined;
  /**
   * True once a real gesture has moved the dial in this sitting.
   *
   * RADIO ON prefers "whatever the pointer is on" over "whatever was on last
   * time", which is right when the hand has moved the dial and wrong when it has
   * not: with a band restored at launch, the default pointer position sits on
   * whichever station the layout happens to put near the middle, so switching on
   * would have started something the listener never chose. The flywheel is inert
   * on an uncut dial, so this can only become true when there is a band to be on.
   */
  private dialTouched = false;
  /**
   * A cut is standing in `settings` and has not been put back on the drum yet.
   *
   * Cleared once the rows arrive and the band is re-derived. It survives a failed
   * launch on purpose: an offline start cannot restore the drum, and a later
   * RECONNECT re-pulls the directory and brings the band back with it.
   */
  private cutToRestore = false;
  /** The population a restore is valid against — the scope that was on disk. */
  private restoreKey = '';
  /**
   * A first launch, with nothing ever cut and no scope filed down.
   *
   * A real receiver has no play button because it has no empty state: you switch
   * it on and a band is already there. This app switched on to a bare drum, and
   * three independent first-time users all failed at exactly that point — one of
   * them took a hundred and twenty seconds to reach audio, because the only door
   * to a station was a small key on the bottom rail.
   *
   * So an empty profile arrives with a band already on the drum, cut from the
   * idle sheet the register fetches anyway (`ON AIR NOW · MOST LISTENED`). It
   * costs no extra request, it chooses nothing on anyone's behalf beyond "the
   * most-listened stations right now", it is not written to disk, and the first
   * band the listener cuts for themselves replaces it for good.
   *
   * It does NOT start audio. RADIO ON is still the only thing that does.
   */
  private openingCut = false;
  /**
   * RADIO ON was pressed before there was anything to switch on to, and the
   * station list was still on its way.
   *
   * The press is a request, and a request the receiver cannot answer yet is not
   * a request it should throw away: a valve set takes a moment to come up too.
   * The intent stands until the first band lands (then it tunes, exactly as if
   * the dome had been pressed a second later) or until the list settles with
   * nothing on it (then the panel says so). STANDBY takes it back.
   */
  private powerPending = false;
  /**
   * Where the pointer is. Owned by the faceplate as an input, mirrored here
   * because RADIO ON has to switch on to whatever the dial is pointing at —
   * turning the knob in standby and then pressing power is how the control
   * actually gets used.
   */
  private dialPosition = 0.5;
  private reportedStationId: string | undefined;
  private unlocked = false;

  private raf = 0;
  private unwatchAttention?: () => void;
  private dirty = true;
  private lastLevel = -1;

  private readonly settingsWriter: DebouncedWriter<Settings>;
  private readonly memoryWriter: DebouncedWriter<StationMemory>;

  constructor() {
    this.settingsWriter = new DebouncedWriter<Settings>(
      (value) => this.bridge?.settings.save(value) ?? Promise.resolve(),
      400,
    );
    this.memoryWriter = new DebouncedWriter<StationMemory>(
      (value) => this.bridge?.memory.save(value) ?? Promise.resolve(),
      250,
    );
    this.handlers = this.buildHandlers();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  attach(handle: FaceplateHandle): void {
    this.handle = handle;
    this.raf = requestAnimationFrame(this.frame);
    /* The panel's whole product is photons, so behind a shut lid, a minimised
       window or a locked screen it has none. markDirty on the way back is what
       keeps Law 2: it forces a full render on the very next frame, so the first
       thing drawn is the reading the analyser gives *then*, never a stale one. */
    this.unwatchAttention = onAttentionChange((attentive) => {
      if (attentive) this.markDirty();
    });
    // Anything the user does counts as the gesture that lets an AudioContext
    // start; capture phase so it is seen before any control swallows it.
    document.addEventListener('pointerdown', this.onFirstGesture, { capture: true });
    document.addEventListener('keydown', this.onFirstGesture, { capture: true });
    window.addEventListener('pagehide', this.onPageHide);
    void this.boot();
  }

  private async boot(): Promise<void> {
    const handle = this.handle;
    if (!handle) return;

    // Paint before anything is awaited. A window that comes up blank while a
    // directory call is in flight is the "infinite spinner" Law 4 forbids.
    handle.setIndex(null, null);
    handle.setBrowseResults(this.browse);
    handle.render(this.state, this.band, this.settings);

    if (!hasBridge()) {
      // The preload script did not run. Nothing can work; say so rather than
      // sitting there looking like a radio with nothing on the air. Both
      // surfaces, because the register is genuinely unprintable *and* every
      // control on the panel is genuinely dead.
      this.setBrowse({
        query: '',
        stations: [],
        loading: false,
        error: 'APP BRIDGE MISSING — RESTART THE APP',
      });
      this.notify(say.bridgeMissing());
      return;
    }
    this.bridge = getBridge();

    // --- persisted state ---------------------------------------------------
    try {
      this.settings = await this.bridge.settings.load();
    } catch {
      this.settings = { ...DEFAULT_SETTINGS };
    }
    try {
      this.memory = await this.bridge.memory.load();
    } catch {
      this.memory = { presets: [] };
    }

    this.band = layoutBand('', [], { totalStations: 0 });
    // The visible half of the register's throw. `scope` has always come back;
    // the band never did, so the ritual's result was the one piece of state a
    // restart threw away — the faceplate returned to `NO BAND CUT` with a locked
    // flywheel and a dead meter band, while the cards behind the lid still
    // remembered exactly what had been pulled.
    this.cutToRestore = this.settings.cutScope !== undefined;
    // Nothing has ever been cut and nothing is filed down: this is a first run,
    // and the drum is filled from the sheet the register is about to fetch.
    this.openingCut = !this.cutToRestore && scopeIsEmpty(this.settings.scope);
    this.restoreKey = supersetKey(this.settings.cutScope ?? this.settings.scope);
    handle.setScope(this.settings.scope);
    handle.setCut(null, 0, false);
    handle.setPresets(this.memory.presets);
    // The log survives a restart, which is the entire point of it: the station
    // you liked yesterday is on the panel this morning without a search.
    this.log = normaliseLog(this.memory.log);
    handle.setLog(this.log);
    this.markDirty();

    // --- the engine --------------------------------------------------------
    this.engine = new PlaybackEngine({
      settings: this.settings,
      resolve: (station, signal) => this.resolveStream(station, signal),
      emitHz: 10,
    });
    this.engine.subscribe((state) => this.onEngineState(state));

    // The last station comes back onto the dial, but not onto the air: the
    // browser will not start audio without a gesture, and a panel that claimed
    // to be playing while silent would be exactly the lie Law 2 forbids.
    // RADIO ON is that gesture.

    await this.bootstrapDirectory();
  }

  /** The register's index, then the rows for the restored scope. Both may fail. */
  private async bootstrapDirectory(): Promise<void> {
    await this.loadIndex();
    await Promise.all([this.refreshScope(), this.restoreDivergentCut()]);
  }

  /**
   * The standing band was cut from a scope the register's cards no longer
   * show — a card was pulled after the throw, and then the app was quit. The
   * register's own fetch answers the cards; this one answers the throw. It is
   * one extra round trip, made only in that case.
   */
  private async restoreDivergentCut(): Promise<void> {
    const bridge = this.bridge;
    const cutScope = this.settings.cutScope;
    if (!bridge || !this.cutToRestore || !cutScope) return;
    const key = supersetKey(cutScope);
    if (key === supersetKey(this.settings.scope)) return; // the register's fetch carries it
    const result = await bridge.directory.search(supersetQuery(cutScope, SCOPE_LIMIT) ?? { limit: IDLE_LIMIT });
    if (!this.cutToRestore || key !== this.restoreKey) return;
    // Failed: the flag stays armed and RECONNECT re-pulls, exactly as for the
    // register's own fetch. `directoryFault` is already carrying the reason.
    if (!result.ok) return;
    this.restoreCut(key, result.value);
    this.settleRestore(key);
    this.settlePendingPower();
  }

  /**
   * A definitive answer for `key` has landed, and whatever it could not put on
   * the drum is not "still coming". Both warm-up flags are disarmed here.
   *
   * They used to stay armed when the directory answered with nothing — a term
   * that matched no station, or a card pulled before the first list landed —
   * and `warmingUp()` then held RADIO ON on `WARMING UP · PLAY STARTS ON ITS
   * OWN` for ever, on every launch, with nothing on its way. A throw the
   * directory can no longer satisfy is also forgotten on disk, so the next
   * launch does not repeat the question; the cards stay where they were.
   */
  private settleRestore(key: string): void {
    if (this.cutToRestore && key === this.restoreKey) {
      this.cutToRestore = false;
      this.patchSettings({ cutScope: undefined });
    }
    // The opening band is only ever the idle sheet; an answer to anything else
    // means a card was pulled first and the receiver is no longer coming up.
    this.openingCut = false;
  }

  /**
   * Put the persisted band back on the drum.
   *
   * The throw is replayed, not replayed *from a copy*: the same scope, the same
   * facet pass the register would have made with its own default sort, the same
   * `cutBands`. So `settings.json` stays a flat bag of scalars and cannot become
   * a stale private snapshot of 480 station records that quietly disagrees with
   * the directory — what comes back is today's answer to the question the
   * listener asked yesterday.
   *
   * Three things it deliberately does NOT do, all of which `applyCut` does and
   * all of which would be wrong here: it does not shut the lid (nobody opened
   * it), it does not strike the plate's lamp (nothing was just thrown), and it
   * does not tune. Restoring a band is not a gesture, the browser will not start
   * audio without one, and a panel that came up claiming to play would be exactly
   * the lie Law 2 forbids. RADIO ON is that gesture, and the station it switches
   * on to is the one the log remembers.
   *
   * `key` is the population the rows in hand actually are. The restore is only
   * valid against the scope that was on disk: if the listener pulled a card
   * before the first fetch landed, these rows answer a different question and
   * re-deriving from them would put a band on the drum that nobody threw.
   */
  private restoreCut(key: string, rows: readonly StationRef[]): void {
    if (!this.cutToRestore || key !== this.restoreKey) return;
    const scope = this.settings.cutScope;
    if (!scope || rows.length === 0) return;
    this.cutToRestore = false;
    const index = this.index;
    const view = computeView(rows, scope, index, RESTORE_SORT);
    if (view.rows.length === 0) return;
    const caption = scopeCaption(scope, (code) => this.originName(code));
    const cut = cutBands(caption, qualityCaption(scope), view.rows);
    if (cut.bands.length === 0) return;
    this.cut = cut;
    this.cutBandIndex = Math.min(Math.max(this.settings.cutBandIndex, 0), cut.bands.length - 1);
    this.band = cut.bands[this.cutBandIndex]!;
    this.handle?.setCut(cut, this.cutBandIndex, false);
    this.markDirty();
  }

  /**
   * FIRST LAUNCH: put the idle sheet on the drum, so the dial is live from the
   * first second.
   *
   * The complaint this answers was three users deep and unanimous: *"there is no
   * play button. Anywhere."* It is a true observation and the wrong remedy — a
   * 1977 receiver has no play button either. What it also has is no empty state.
   * You switch it on and it plays, because a band is always there. The fault was
   * never the missing button; it was that switching on landed you on a bare
   * dial, which no real receiver does.
   *
   * So the drum is cut from `ON AIR NOW · MOST LISTENED` — the same rows the
   * register's idle sheet is already showing, from the same fetch, laid across
   * the same twelve meter bands the register's own throw would lay them across.
   * Deliberately identical machinery to `restoreCut` and to `applyCut`, because
   * a dial the user did not have to earn must still be a dial the register can
   * explain: turn METER BAND and it steps the bands, open the register and the
   * sheet behind it is the very list on the drum.
   *
   * Four things it does not do:
   *
   *   · it does not tune. RADIO ON is still the only thing that starts audio;
   *   · it does not strike the plate's lamp — nothing was thrown by a hand;
   *   · it does not shut or open the lid;
   *   · it does not write `cutStanding` to disk. This is not a standing band, it
   *     is what an unconfigured receiver comes up on, and it is re-derived from
   *     the live directory every launch until the listener cuts one of their
   *     own — at which point `applyCut` persists theirs and this never fires
   *     again.
   *
   * `key` is the population the rows in hand answer. Only the idle one will do:
   * if a card was pulled while the first fetch was in flight, these rows answer
   * a different question and putting them on the drum would be the receiver
   * choosing a subject nobody asked for.
   */
  private openingBand(key: string): void {
    if (!this.openingCut || this.cut) return;
    const scope = this.settings.scope;
    if (key !== supersetKey(EMPTY_SCOPE) || !scopeIsEmpty(scope)) return;
    const rows = this.browse.stations;
    // No rows means the directory did not answer, or answered with nothing. The
    // flag stays armed: RECONNECT re-pulls, and the opening band comes with it.
    if (rows.length === 0) return;
    const view = computeView(rows, scope, this.index, RESTORE_SORT);
    // ONLY STATIONS THIS RECEIVER CAN ACTUALLY PLAY.
    //
    // The register's idle sheet deliberately prints the ones it cannot — struck
    // and dated, because a missing row leaves the reader wondering and a struck
    // one does not (`EMPTY_SCOPE.hideHls` is false for exactly that reason). A
    // band the *receiver* cut is a different object: nobody chose these, so
    // handing one of them the first slot on the drum is the receiver choosing a
    // station it already knows will fault. Measured on the packaged build: a
    // cold launch put `Radio Italia Solo Musica Italiana` under the pointer,
    // RADIO ON reached `FAULT — HLS ONLY, WHICH THIS RECEIVER CANNOT DECODE`,
    // and the first thing a first-time user saw was a red lamp.
    //
    // Two facts, both already on the record and both checked before the click:
    // an HLS stream Chromium has no demuxer for, and a mount the directory's own
    // checker could not reach.
    const playable = view.rows.filter((row) => !row.hls && row.lastCheckOk !== false);
    if (playable.length === 0) return;
    const cut = cutBands(scopeCaption(scope, (code) => this.originName(code)), qualityCaption(scope), playable);
    if (cut.bands.length === 0) return;
    this.openingCut = false;
    this.cut = cut;
    this.cutBandIndex = 0;
    this.band = cut.bands[0]!;
    this.handle?.setCut(cut, 0, false);
    this.markDirty();
  }

  /**
   * The list has settled. If RADIO ON is still waiting on it, answer the press.
   *
   * This is the other half of "switching on lands you on a full dial": the
   * obvious first gesture happens within a couple of seconds of launch, and the
   * directory does not always answer that fast. A press that arrived early used
   * to be told the dial was empty — which was true at the instant it was read
   * and false a second later, and is exactly the kind of answer that makes a
   * stranger conclude the control does nothing.
   *
   * It is not autoplay: nothing starts here that a hand did not ask for, the
   * request is one press old, and STANDBY cancels it.
   */
  private settlePendingPower(): void {
    if (!this.powerPending) return;
    const station = this.band.slots[0]?.station;
    if (!station) {
      // Settled, and there is genuinely nothing to switch on to. Say which of
      // the two reasons it is, rather than leaving WARMING UP standing for ever.
      this.powerPending = false;
      const registerOpen = this.handle?.isLidOpen() ?? false;
      this.notify(
        this.directoryFault
          ? say.nothingToPlay({ directoryFault: directoryFaultText(this.directoryFault), registerOpen })
          : say.nothingToPlay({ registerOpen }),
      );
      return;
    }
    this.powerPending = false;
    this.clearNotice();
    this.tuneStation(station);
  }

  /**
   * Is the receiver still coming up?
   *
   * True while the first station list is in flight, or while a band is known to
   * be on its way onto the drum. It is the difference between "there is nothing
   * here" and "there is nothing here YET", and those need different words.
   */
  private warmingUp(): boolean {
    return this.browse.loading || this.openingCut || this.cutToRestore;
  }

  /** The directory's own name for an origin code, for the restored caption. */
  private originName(code: string): string {
    return this.index?.origins.find((o) => o.code === code)?.name ?? code;
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.unwatchAttention?.();
    window.clearTimeout(this.scopeTimer);
    document.removeEventListener('pointerdown', this.onFirstGesture, { capture: true });
    document.removeEventListener('keydown', this.onFirstGesture, { capture: true });
    window.removeEventListener('pagehide', this.onPageHide);
    this.settingsWriter.flush();
    this.memoryWriter.flush();
    this.engine?.dispose();
  }

  private readonly onPageHide = (): void => {
    this.settingsWriter.flush();
    this.memoryWriter.flush();
  };

  private readonly onFirstGesture = (): void => {
    if (this.unlocked) return;
    this.unlocked = true;
    void this.engine?.unlock().catch(() => {
      /* The context resumes on the next gesture; nothing to report yet. */
    });
  };

  // -------------------------------------------------------------------------
  // Painting
  // -------------------------------------------------------------------------

  /**
   * One frame. The engine emits state at 10 Hz, which is the right rate for
   * text; it is far too slow for a moving-coil needle, so the level is read
   * synchronously off the analyser here and rendered at frame rate.
   *
   * TWO INSTRUMENTS, NOT ONE.
   *
   * This used to take a full `render(state, band, settings)` on every frame in
   * which the level had moved — with programme material on the air, that is
   * every frame, so the whole panel's revision ran at ~57 Hz to answer "the RMS
   * moved by 0.01": a `slots.map().join()` band key rebuilt from scratch, ~60
   * guarded attribute compares, a re-derived phase sentence, a re-derived
   * on-air mark, and a `{...state}` allocation, all of it producing the same
   * values it produced on the previous frame.
   *
   * The level is the only quantity here that moves at frame rate. Everything
   * else changes because the engine emitted, the directory answered, or a hand
   * moved something — all of which set `dirty`. So a frame is now one of two
   * things:
   *
   *   · STRUCTURAL (`dirty`) — a full render, with the fresh level folded in so
   *     the needle never falls back to the 10 Hz reading. About ten a second.
   *   · A READING — `renderLevel`, which pushes the number to the movement and
   *     to the readout's silence guard and touches nothing else.
   *
   * `dirty` is still the whole safety property: nothing structural can reach the
   * screen through the fast path, because nothing structural can change without
   * going through `onEngineState` or a handler, and both mark the host dirty.
   */
  private readonly frame = (): void => {
    const handle = this.handle;
    if (!handle) {
      this.raf = 0;
      return;
    }
    /* Nobody is looking — park until attention returns. This has to sit above
       the level read, not inside `canSettle`: with a stream on the air the
       level moves every frame, so the settle branch is never reached and the
       loop would never park. `dirty` is deliberately left standing, so whatever
       changed while nobody watched is painted in the first frame back. */
    if (!isAttended()) {
      this.raf = 0;
      return;
    }
    const level = this.engine?.readSignalLevel() ?? 0;
    if (!this.dirty) {
      // Below the epsilon the needle has not visibly moved and the silence
      // guard cannot change its mind, so the frame costs one analyser read.
      if (Math.abs(level - this.lastLevel) < LEVEL_EPSILON) {
        // NOTHING IS MOVING. A loop that wakes sixty times a second to
        // rediscover that is pure cost — on the CPU, on the compositor's
        // BeginFrame production, and on a laptop battery. Park it. Every path
        // that can make the panel or the level move again goes through
        // `markDirty` or `wake`, and both restart it.
        //
        // The reading is untouched: the analyser is still read on the very next
        // frame after any wake, and the level that parked the loop is the level
        // the needle is already showing.
        if (this.canSettle(level)) {
          this.raf = 0;
          return;
        }
        this.raf = requestAnimationFrame(this.frame);
        return;
      }
      this.raf = requestAnimationFrame(this.frame);
      this.lastLevel = level;
      handle.renderLevel(level);
      return;
    }
    this.raf = requestAnimationFrame(this.frame);
    this.dirty = false;
    this.lastLevel = level;
    handle.render({ ...this.state, signalLevel: level }, this.band, this.settings);
  };

  /**
   * May the frame loop stop until something wakes it?
   *
   * Only when the movement is genuinely at rest *and* there is no live audio
   * path that could move it without an engine emit. Two phases qualify, and
   * they are exactly the two the engine calls settled in `syncTicker`:
   *
   *   · `idle`  — standby. Nothing has been asked for.
   *   · `error` — terminal. A station that has given up, with a sentence on the
   *     panel, a steady (not pulsing) fault lamp, no session, no reconnect in
   *     flight and no audio thread — `syncTicker` has already stopped the 10 Hz
   *     ticker and idled the audio stage for this very phase.
   *
   * `error` was missing here, and it is the expensive omission: a dead mount is
   * the single most common outcome of a directory of user-submitted stream URLs,
   * and it left this loop re-arming sixty times a second — for hours, on a
   * motionless panel, presenting not one frame. Measured on the shipped build:
   * 7.9% of a core on a dead station against 0.3% with the identical DOM in
   * standby. The whole difference was this predicate.
   *
   * It is safe for the same reason `idle` is safe, and by exactly the same
   * mechanism: parking is decided here, but *waking* is decided in `wake()`,
   * which knows nothing about the phase. Every route back to a moving panel —
   * RECONNECT, a station change, an engine emit whose reading differs, a
   * settings write, the lid, the return of attention — goes through `markDirty`
   * or `wake`. So whatever wakes the loop out of `idle` wakes it out of `error`,
   * unchanged and untested-for.
   *
   * Anything else — playing, buffering, connecting, resolving, stalled,
   * reconnecting — keeps the loop running at frame rate exactly as before.
   * Law 2 is untouched: this changes when the analyser is read, never what it
   * reports.
   */
  private canSettle(level: number): boolean {
    const settled = this.state.phase === 'idle' || this.state.phase === 'error';
    return settled && level === 0 && this.lastLevel <= 0;
  }

  /**
   * Something structural changed. Mark the panel dirty and make sure a frame is
   * coming, because the loop is allowed to park itself when nothing moves.
   */
  private markDirty(): void {
    this.dirty = true;
    this.wake();
  }

  /** Restart the frame loop if it has parked. */
  private wake(): void {
    /* Without the attention test the engine's 10 Hz emit marks the host dirty
       ten times a second and restarts the loop for a full-panel render each
       time, every one of them invisible. */
    if (this.raf || !this.handle || !isAttended()) return;
    this.raf = requestAnimationFrame(this.frame);
  }

  private onEngineState(state: PlaybackState): void {
    const previous = this.state;
    this.state = state;
    /* A tick that reports exactly what the last one reported cannot change a
     * character on the panel: `render` is a pure function of (state, band,
     * settings), and the other two mark the host dirty through their own paths.
     *
     * The engine emits every 100 ms whether or not anything moved, so in
     * standby this used to re-render the whole faceplate six hundred times a
     * minute to redraw the identical panel — a band key rebuilt from a
     * `slots.map().join()`, ~60 guarded attribute compares, and the register's
     * `setAir`/`setPlayback` behind them. Skipping an identical reading is
     * conservative by construction: it can only skip when *every* field is
     * equal, so nothing can go stale. */
    if (!sameReading(previous, state)) this.markDirty();

    // The directory's popularity signal is what keeps the dial layout
    // meaningful, and it is only honest to send it once audio is really
    // flowing — not when someone merely clicked.
    const station = state.station;
    if (state.phase === 'playing' && station && this.reportedStationId !== station.id) {
      this.reportedStationId = station.id;
      void this.bridge?.directory.reportListening(station.id);
    }

    // Same test, same reason: the log records what was *heard*.
    if (state.phase === 'playing' && station) this.logStation(station);

    // The candidate walk is a search for a mount that works. Once one
    // demonstrably does — measured playing time, not a click — the search is
    // over and the next fault on this station starts again at the head of the
    // list. Without this the counter only ever grew, so a station that had
    // needed RECONNECT once began every later attempt part-way down a list
    // whose first entries may well be healthy again.
    if (station && state.phase === 'playing' && state.playingSeconds >= CANDIDATE_SETTLED_S) {
      this.candidate.delete(station.id);
    }

    // A message about there being nothing to play stops being true the moment
    // something plays. Terminal faults keep their own words — the engine's
    // readout owns those — so only the host's advice is taken down here.
    if (state.phase === 'playing' && previous.phase !== 'playing') {
      this.clearNotice();
      // A mount that came up ends the retry record for this station: the next
      // fault on it is a new fault, not the eleventh press of an old one.
      if (station && this.retryOf === station.id) {
        this.retryOf = undefined;
        this.retryPresses = 0;
        this.lastFaultText = undefined;
      }
    }

    // The outcome half of RECONNECT, and of any attempt that ends badly.
    // Transition-guarded: the engine emits at 10 Hz and re-posting the same
    // sentence sixty times would re-strike the annunciator lamp for a minute.
    const faultChanged = state.error?.message !== previous.error?.message;
    if (state.phase === 'error' && state.error && (previous.phase !== 'error' || faultChanged)) {
      const faulted = station ?? this.memory.lastStation;
      if (faulted) this.announceFault(state.error, faulted);
    }
  }

  /**
   * Write a line in the log, or move an existing one to the top.
   *
   * Called from the engine's own `playing` report and nowhere else, so the log
   * cannot fill up with stations that were requested and never arrived.
   */
  private logStation(station: StationRef): void {
    const next = recordHeard(this.log, station, Date.now());
    if (next === this.log) return;
    this.log = next;
    this.memory = { ...this.memory, log: this.log };
    this.memoryWriter.queue(this.memory);
    this.handle?.setLog(this.log);
    this.markDirty();
  }

  /**
   * Publish rows for the register's sheet.
   *
   * INVARIANT, and it is the whole of FIX 2: a fault may only ride along with
   * an *empty* result. The register turns `fault` into a `NOT PRINTED` sheet
   * header, which is the truth when there is nothing on the sheet and a
   * fabrication when there are two thousand rows under it — and it stayed
   * fabricated for as long as the sheet was not refetched, because the header
   * has no idea the message was really about the front panel. Panel-level
   * messages go to `notify()` and never through here.
   */
  private setBrowse(results: BrowseResults): void {
    const safe = sheetSafe(results);
    this.browse = safe;
    this.handle?.setBrowseResults(safe);
    this.markDirty();
  }

  // -------------------------------------------------------------------------
  // The panel's voice
  // -------------------------------------------------------------------------

  /**
   * Say something on the front panel.
   *
   * Law 4's "failure is a designed state" needs somewhere for the design to
   * land, and until now the only channel the host had was the register's sheet
   * — a surface behind a lid, conditioned on a row count, and in the Design D
   * rebuild not even the same component the strings were written for. Every
   * message the host produced went nowhere and pressing RADIO ON on a fresh
   * profile changed literally zero pixels.
   *
   * Anything said here must name only controls that are on the current
   * faceplate. The genre selector is gone; nothing may mention it.
   */
  private notify(spec: say.NoticeSpec): void {
    this.notice = { ...spec, seq: ++this.noticeSeq };
    this.handle?.setNotice(this.notice);
    this.markDirty();
  }

  /** Take the message down. Called the moment the state it described is over. */
  private clearNotice(): void {
    if (!this.notice) return;
    this.notice = null;
    this.handle?.setNotice(null);
    this.markDirty();
  }

  // -------------------------------------------------------------------------
  // Directory
  // -------------------------------------------------------------------------

  /**
   * The register's printed index.
   *
   * Law 4: a failure here does not empty the panel, it *names* the state. The
   * register prints REGISTER NOT PRINTED with the reason, and carries REPRINT
   * EDITION, which is the control that fixes it.
   */
  private async loadIndex(): Promise<void> {
    const bridge = this.bridge;
    if (!bridge) return;
    // REPRINT, RECONNECT and RADIO ON can each start a pull while another is in
    // flight; without this the slower answer lands last and wins.
    const generation = ++this.indexGeneration;
    const result = await bridge.directory.listIndex();
    if (generation !== this.indexGeneration) return;
    if (!result.ok) {
      this.directoryFault = result.failure;
      this.index = null;
      this.indexFault = directoryFaultText(result.failure);
      this.handle?.setIndex(null, this.indexFault);
      // The register says it on its own colophon, but the register is behind a
      // lid: the panel has to carry it too, or a first run with no network is a
      // receiver that simply does nothing and never says why.
      this.notify(say.noDirectory(this.indexFault));
      this.markDirty();
      return;
    }
    this.directoryFault = null;
    this.index = result.value;
    this.indexFault = null;
    this.handle?.setIndex(this.index, null);
    if (this.notice && say.DIRECTORY_HEADLINES.includes(this.notice.headline)) this.clearNotice();
    this.markDirty();
  }

  /**
   * Fetch the rows for the current scope.
   *
   * One request, on the most selective axis the scope has pulled. Everything
   * narrower is applied inside the register, over a set that provably contains
   * every row that could match — see `ui/register/facets.ts` for why that keeps
   * the printed counts exact rather than sampled.
   */
  private async refreshScope(): Promise<void> {
    const bridge = this.bridge;
    if (!bridge) return;
    const generation = ++this.scopeGeneration;
    const scope = this.settings.scope;
    // The identity of the population this request is going to fetch, captured
    // here and carried all the way to the register with the rows it names. The
    // register may not re-derive it from the scope it is holding when the answer
    // lands, because by then the scope can be a different one.
    const key = supersetKey(scope);

    // `loading: true` carries the PREVIOUS rows forward by design, so it carries
    // the previous key with them: the rows and their identity travel together on
    // every publish, without exception.
    this.setBrowse({ query: '', stations: this.browse.stations, loading: true, key: this.browse.key });

    const query = supersetQuery(scope, SCOPE_LIMIT) ?? { limit: IDLE_LIMIT };
    const result = await bridge.directory.search(query);
    if (generation !== this.scopeGeneration) return;

    if (!result.ok) {
      this.directoryFault = result.failure;
      // A fault is a settled answer to *this* question (Law 4), so it carries
      // this question's key and the register may print NOT PRINTED for it.
      this.setBrowse({
        query: '',
        stations: [],
        loading: false,
        key,
        error: directoryFaultText(result.failure),
      });
      // A settled answer, even though it is a bad one: a press that was waiting
      // on this list has to be told, or WARMING UP stands for ever.
      this.settlePendingPower();
      return;
    }
    // Rows answered, but a failed index is still a directory fault: RECONNECT
    // must go on re-pulling the edition, not only the sheet.
    if (this.index) this.directoryFault = null;
    // Zero rows is a real answer, and the register prints NO ENTRY for it. It
    // is not a fault and must not be dressed as one.
    this.setBrowse({
      query: '',
      stations: result.value,
      loading: false,
      key,
      warning: result.warning,
    });
    // Rows are the one thing a restored cut was waiting for, and this is the only
    // place they arrive. Putting it here rather than in `bootstrapDirectory` is
    // what makes an offline launch recoverable: RECONNECT, or a REPRINT, or the
    // network simply coming back, all land here.
    this.restoreCut(key, result.value);
    // …and on a profile that has never cut anything, this is where the drum
    // gets its opening band. Same place, same rows, same reason.
    this.openingBand(key);
    this.settleRestore(key);
    this.settlePendingPower();
  }

  /** The register threw CUT BAND: print the scope onto the drum. */
  private applyCut(rows: StationRef[], caption: string, quality: string): void {
    this.clearNotice();
    this.cut = cutBands(caption, quality, rows);
    this.cutBandIndex = 0;
    this.band = this.cut.bands[0] ?? layoutBand(caption, [], { totalStations: 0 });
    this.handle?.setCut(this.cut, this.cutBandIndex, true);
    this.handle?.setLidOpen(false);
    // The throw itself is persisted, so the drum survives a restart. A throw that
    // filled nothing is not a standing band and must not be remembered as one.
    this.cutToRestore = false;
    // A band the listener cut for themselves replaces the opening one for good.
    this.openingCut = false;
    // The throw tunes below, so a press that was waiting on a band is answered.
    this.powerPending = false;
    this.patchSettings({
      cutScope: this.cut.bands.length > 0 ? { ...this.settings.scope } : undefined,
      cutBandIndex: 0,
    });
    this.markDirty();

    // The throw is a gesture, so it may start audio. The dial opens at the head
    // of the first band — asking the engine, never asserting that it happened.
    const first = this.band.slots[0]?.station;
    if (first) this.tuneStation(first);
  }

  /** METER BAND turned: reprint the drum with another band of the same cut. */
  private selectMeterBand(index: number): void {
    const cut = this.cut;
    if (!cut || cut.bands.length === 0) return;
    const next = Math.min(Math.max(index, 0), cut.bands.length - 1);
    if (next === this.cutBandIndex && this.band === cut.bands[next]) return;
    this.cutBandIndex = next;
    this.band = cut.bands[next]!;
    this.handle?.setCut(cut, next, false);
    // Which band of the cut is printed is part of what the drum is showing, so it
    // survives a restart with the cut rather than resetting to the first band.
    this.patchSettings({ cutBandIndex: next });
    this.markDirty();
    const first = this.band.slots[0]?.station;
    if (first && isPowered(this.state)) this.tuneStation(first);
  }

  // -------------------------------------------------------------------------
  // Resolution + tuning
  // -------------------------------------------------------------------------

  /**
   * The engine's resolve hook. Runs in the main process, where the raw sockets
   * are, and comes back as data: either playable candidates in preference
   * order, or one specific reason there are none.
   */
  private async resolveStream(station: StationRef, signal: AbortSignal): Promise<PlayableStream[]> {
    const bridge = this.bridge;
    if (!bridge) throw new TuneResolutionError('network', 'the stream resolver is unavailable');

    const result = await Promise.race([
      bridge.resolver.resolve(station.url),
      new Promise<never>((_resolve, reject) => {
        if (signal.aborted) reject(new TuneResolutionError('aborted', 'tuned away'));
        signal.addEventListener(
          'abort',
          () => reject(new TuneResolutionError('aborted', 'tuned away')),
          { once: true },
        );
      }),
    ]);

    if (!result.ok) throw new TuneResolutionError(result.failure.kind, resolveFaultText(result.failure));

    if (result.streams.length === 0) {
      throw new TuneResolutionError('empty-playlist', `${station.name} has no playable stream`);
    }

    // The WHOLE preference list, rotated to start at the candidate RECONNECT has
    // walked to. Handing over one mount was the reason a PLS with a dead first
    // entry cost six AFC attempts and twenty-nine seconds before the listener
    // could do anything about it, while a working sibling mount sat in the same
    // playlist untouched: the engine can only walk a list it has been given.
    // Rotating rather than truncating keeps every candidate reachable, so a
    // listener who has walked past a mount that has since come back still gets
    // it on the next lap. `Math.min` did not rotate, it *clamped*: on a
    // three-mount PLS the third press of RECONNECT gave start = 2 and so did
    // every press after it, so the control stuck on the last mount for ever.
    return rotateCandidates(result.streams, this.candidate.get(station.id) ?? 0);
  }

  private tuneStation(station: StationRef): void {
    const engine = this.engine;
    if (!engine) return;
    this.reportedStationId = undefined;
    // Landing on a station is landing on it: the hiss belongs between them.
    engine.setTuningProximity(1);
    void engine.tune(station).catch(() => {
      /* Every failure path inside tune() already reports through PlaybackState. */
    });
    this.memory = { ...this.memory, lastStation: station };
    this.memoryWriter.queue(this.memory);
    this.markDirty();
  }

  /** Every station the panel currently knows about, for id lookups. */
  private findStation(id: string): StationRef | undefined {
    return (
      this.band.slots.find((slot) => slot.station.id === id)?.station ??
      this.cut?.bands.flatMap((b) => b.slots).find((slot) => slot.station.id === id)?.station ??
      this.browse.stations.find((s) => s.id === id) ??
      this.memory.presets.find((p) => p.station.id === id)?.station ??
      // The log is a real way back to a station, so it has to be a real place
      // to look one up: its rows outlive the cut that produced them and, after
      // a restart, outlive the directory fetch entirely.
      this.log.find((e) => e.station.id === id)?.station ??
      (this.memory.lastStation?.id === id ? this.memory.lastStation : undefined)
    );
  }

  private patchSettings(patch: Partial<Settings>): void {
    this.settings = { ...this.settings, ...patch };
    this.engine?.setSettings(patch);
    this.settingsWriter.queue(this.settings);
    this.markDirty();
  }

  // -------------------------------------------------------------------------
  // Handlers — every one of these is a request, never a statement
  // -------------------------------------------------------------------------

  private buildHandlers(): FaceplateHandlers {
    return {
      onPower: (next) => this.onPower(next),
      onTune: (position, phase) => this.onTune(position, phase),
      onDialLocked: () => this.onDialLocked(),
      onSelectStation: (id) => this.onSelectStation(id),
      onScope: (scope) => this.onScope(scope),
      onCut: (rows, caption, quality) => this.onCut(rows, caption, quality),
      onReprint: () => this.onReprint(),
      onSelectMeterBand: (i) => this.selectMeterBand(i),

      onSetVolume: (volume) => this.patchSettings({ volume }),
      onSetBass: (bassDb) => this.patchSettings({ bassDb }),
      onSetTreble: (trebleDb) => this.patchSettings({ trebleDb }),
      onSetNoiseFloor: (noiseFloor) => this.patchSettings({ noiseFloor }),
      onToggleAfc: (afcEnabled) => this.patchSettings({ afcEnabled }),
      onSetBufferDepth: (bufferDepth) => this.patchSettings({ bufferDepth }),
      onToggleDialLamp: (dialLampOn) => this.patchSettings({ dialLampOn }),

      onRecallPreset: (slot) => this.onRecallPreset(slot),
      onStorePreset: (slot) => this.onStorePreset(slot),
      onReconnect: () => this.onReconnect(),
      onLidToggle: (open) => this.onLidToggle(open),
    };
  }

  private onPower(next: boolean): void {
    const engine = this.engine;
    if (!engine) {
      // The panel is up but the receiver behind it is not. Pressing power still
      // has to answer; this used to be a bare `return`.
      this.notify(say.engineMissing());
      return;
    }
    this.onFirstGesture();

    if (!next) {
      engine.stop();
      // Standby is silent, including the band noise.
      engine.setTuningProximity(1);
      // Switching off takes back a switch-on that was still waiting for a band.
      this.powerPending = false;
      this.clearNotice();
      return;
    }

    // What the pointer is on beats what was on last time: if the user has moved
    // the dial in standby, that is the station they are asking for.
    //
    // `dialTouched` is what makes that sentence true. The pointer starts at 0.5
    // and a restored band puts stations all along the scale, so an untouched dial
    // "is on" whichever station the layout happened to place near the middle —
    // which would silently outrank the station the listener was actually last
    // hearing. An untouched pointer is not a choice.
    const station =
      (this.dialTouched ? slotAt(this.band, this.dialPosition)?.station : undefined) ??
      engine.currentState.station ??
      this.memory.lastStation ??
      (this.dialTouched ? nearestSlot(this.band, this.dialPosition)?.station : undefined) ??
      this.band.slots[0]?.station;

    if (!station) {
      // Nothing to switch on to. This is the fresh-install case, and it is the
      // one the whole first minute turns on: the dial is empty because no band
      // has been cut yet, and the words have to say that in a way a stranger
      // can act on, naming controls that are on this faceplate. There is no
      // genre selector any more, so no message may send anyone to look for one.
      if (this.directoryFault) {
        // The press stands: this re-pulls the directory, and if the list comes
        // back the receiver switches on to it without a second press.
        this.powerPending = true;
        this.notify(say.nothingToPlay({ directoryFault: directoryFaultText(this.directoryFault), registerOpen: true }));
        void this.bootstrapDirectory();
        return;
      }
      // Still coming up. "Nothing on the dial" would be true at the instant it
      // was read and false a second later, which is how a stranger learns that
      // the biggest control on the panel does nothing. The press is held instead
      // and answered by `settlePendingPower` the moment the list lands.
      if (this.warmingUp()) {
        this.powerPending = true;
        this.notify(say.warmingUp());
        return;
      }
      // Deliberately NOT opened for them. The obvious move is to swing the lid
      // up so the cards are right there — and it is wrong, because the raised
      // lid covers the entire faceplate including the line that has just
      // explained what to do. A message you cannot read is the defect this
      // whole change exists to remove. So the panel says it, the band plate
      // says it, and the lamp beside REGISTER lights: three signposts, all on
      // the surface the user is already looking at, and the lid still opens
      // when they decide to open it.
      this.notify(say.nothingToPlay({ registerOpen: this.handle?.isLidOpen() ?? false }));
      return;
    }
    this.clearNotice();
    this.tuneStation(station);
  }

  /**
   * A hand tried to turn a dial with nothing on it.
   *
   * The panel says the same thing RADIO ON says in the same state, because it is
   * the same state. The flywheel has already gone maroon under the finger; this
   * is the sentence that explains it, on the surface that exists for sentences.
   */
  private onDialLocked(): void {
    this.notify(say.dialLocked(this.handle?.isLidOpen() ?? false));
  }

  private onTune(position: number, phase: 'drag' | 'commit'): void {
    const engine = this.engine;
    this.dialPosition = position;
    // A real gesture reached the flywheel, which is only possible with a band on
    // the drum. From here on the pointer speaks for the listener.
    this.dialTouched = true;
    if (!engine) return;

    // Between stations you hear the band; on one you hear the station. This is
    // continuous, which is why it is driven from every drag frame and not only
    // from the commit.
    //
    // `this.band.slots.length > 0` is not a micro-optimisation, it is the fix
    // for an unrecoverable dial. `lockStrengthAt` measures how close the pointer
    // is to a printed slot, so on a band with no slots it answers 0 at every
    // position on the scale — there is no station anywhere, which is true, and
    // the honest reading of "fully detuned". Feeding that to the engine holds
    // the station gain shut with no dial position that reopens it, and since a
    // preset recall is what last set it open, one idle drag on an uncut dial
    // silenced a station that was playing perfectly and nothing but another
    // re-tune brought it back. A drum with nothing printed on it is not a drum
    // you can be off-station on.
    engine.setTuningProximity(
      isPowered(this.state) && this.band.slots.length > 0 ? lockStrengthAt(this.band, position) : 1,
    );
    if (phase !== 'commit') return;

    const slot =
      slotAt(this.band, position) ??
      (() => {
        // The flywheel's capture zone reaches a little past the printed width;
        // a settle inside it is a landing, not a near miss.
        const near = nearestSlot(this.band, position);
        return near && Math.abs(near.position - position) <= near.width * 1.35 ? near : undefined;
      })();

    if (!slot) return; // dead air: the hiss above is the whole answer
    if (!isPowered(this.state)) return; // the dial moves in standby; nothing tunes
    if (this.state.station?.id === slot.station.id) return;
    this.tuneStation(slot.station);
  }

  /**
   * A card was pulled or pushed back. The scope is an input the register owns;
   * this stores it, persists it, and asks the directory for the rows.
   */
  private onScope(scope: RegisterScope): void {
    this.patchSettings({ scope });
    this.handle?.setScope(scope);
    window.clearTimeout(this.scopeTimer);
    // Invalidated here, not 220 ms from here. The generation used to be bumped
    // only inside `refreshScope`, so a scope change during the debounce did not
    // supersede the fetch already in flight and its answer was published as
    // though it were the answer to the new scope.
    this.scopeGeneration += 1;
    this.scopeTimer = window.setTimeout(() => void this.refreshScope(), SCOPE_DEBOUNCE_MS);
  }

  private onCut(rows: StationRef[], caption: string, quality: string): void {
    this.onFirstGesture();
    this.applyCut(rows, caption, quality);
  }

  private onReprint(): void {
    this.onFirstGesture();
    void this.bootstrapDirectory();
  }

  private onSelectStation(id: string): void {
    this.onFirstGesture();
    const station = this.findStation(id);
    if (station) this.tuneStation(station);
  }

  private onRecallPreset(slot: Preset['slot']): void {
    this.onFirstGesture();
    const preset = this.memory.presets.find((p) => p.slot === slot);
    if (preset) {
      this.clearNotice();
      this.tuneStation(preset.station);
      return;
    }
    // Law 4: an empty slot is a designed state. Clicking one used to be a
    // silent no-op, which is exactly how nobody ever discovers that holding it
    // is what fills it.
    this.notify(say.emptyPreset(slot, this.state.station ?? this.memory.lastStation));
  }

  private onStorePreset(slot: Preset['slot']): void {
    const station = this.state.station ?? this.memory.lastStation;
    if (!station) {
      // Holding a key with nothing to put in it has to say so; silence here
      // reads exactly like a hold that was not long enough.
      this.notify(say.nothingToStore(slot));
      return;
    }
    this.memory = {
      ...this.memory,
      presets: [
        ...this.memory.presets.filter((p) => p.slot !== slot),
        { slot, station, savedAt: Date.now() },
      ],
    };
    this.memoryWriter.queue(this.memory);
    this.handle?.setPresets(this.memory.presets);
    // The store confirms itself in words as well as in light: the jewel lights
    // and the slip is written, and the panel says which station went where.
    this.notify(say.stored(slot, station));
    this.markDirty();
  }

  /**
   * The lid moved, so anything the panel is saying about the lid is now out of
   * date. "PRESS THE LIT REGISTER KEY" is exactly right until the moment they
   * press it, and reading it afterwards is how a panel teaches people to stop
   * reading it — the same defect as the band plate telling you to open a
   * register that is already open, one surface along.
   */
  private onLidToggle(open: boolean): void {
    this.handle?.setLidOpen(open);
    if (this.notice?.headline !== say.NOTHING_ON_THE_DIAL) return;
    this.notify(say.nothingToPlay({ registerOpen: open }));
  }

  /**
   * RECONNECT.
   *
   * Law 4 puts this on the front panel because streams break, and a recovery
   * control that gives no sign of having been pressed is worse than no control:
   * three presses on a permanently-404 station left the panel byte-identical
   * across a 240-frame capture while a fault server logged a fresh request per
   * press. The work happened; the panel denied it.
   *
   * So every press is acknowledged before anything is awaited — the press writes
   * the annunciator synchronously, exactly as the power dome's refusal does — and
   * the count rides along, because the tenth press has to look different from the
   * ninth. The *outcome* is a separate statement, posted when the engine reports
   * one; a re-attempt that ends in the same fault says so instead of re-printing
   * the first failure's words as news.
   */
  private onReconnect(): void {
    this.onFirstGesture();
    // RECONNECT is the panel's one recovery control, so it recovers whichever
    // thing is broken: the directory, the station, or both.
    if (this.directoryFault) {
      this.notify(say.repullingDirectory(directoryFaultText(this.directoryFault)));
      void this.bootstrapDirectory();
    }

    const station = this.state.station ?? this.memory.lastStation;
    if (!station) {
      if (!this.directoryFault) {
        // Same wound as RADIO ON: this went to a sheet overlay nobody could
        // see. The remedy is on the faceplate, so the words are too.
        this.notify(say.nothingTuned(this.log[0]?.station, this.handle?.isLidOpen() ?? false));
      }
      return;
    }

    // A station that failed outright gets the next candidate the resolver
    // found; one that merely dropped gets the same mount again.
    const faulted = this.state.phase === 'error';
    if (faulted) {
      this.candidate.set(station.id, (this.candidate.get(station.id) ?? 0) + 1);
    }

    // Presses are counted per station, so the number reads as what the listener
    // has tried on *this* mount rather than a session-wide tally.
    this.retryPresses = this.retryOf === station.id ? this.retryPresses + 1 : 1;
    this.retryOf = station.id;
    this.lastFaultText = faulted ? this.state.error?.message : undefined;
    this.notify(say.reconnecting(station, this.retryPresses, faulted));
    this.tuneStation(station);
  }

  /**
   * The engine reported a terminal fault. Say what it is and what to do.
   *
   * The readout's own strip already prints `FAULT — <kind> — <sentence>`, which
   * is what broke. This is the other half Law 4 asks for: the remedy, on the
   * annunciator, beside the lamp that has just gone red — and RECONNECT named by
   * name, which not one of the six fault paths used to do.
   */
  private announceFault(error: PlaybackError, station: StationRef): void {
    // Tries, not presses: the attempt that first failed counts, so one press that
    // fails the same way reads "after 2 tries" rather than "after 1". The counter
    // is read here and never written — it belongs to the presses, and having this
    // advance it too made the tenth press announce itself as the nineteenth.
    const again =
      this.retryOf === station.id && this.retryPresses > 0 && this.lastFaultText === error.message
        ? this.retryPresses + 1
        : 0;
    this.notify(
      say.stationFaulted(station, error.message, {
        again,
        // HLS is the one fault another mount cannot fix: Chromium has no demuxer
        // for it, so offering RECONNECT here would teach that RECONNECT never
        // works.
        canRetry: error.kind !== 'hls',
      }),
    );
    // Remember what this attempt said, so the *next* one can recognise a repeat.
    this.lastFaultText = error.message;
  }

}

/**
 * The resolver's preference list, rotated to start at `start`.
 *
 * A true rotation — `% length`, not `min(start, length - 1)`. RECONNECT's
 * counter only ever grows, so a clamp meant the walk reached the last mount and
 * stopped there: press four, five and six of a three-mount PLS all retried the
 * same corpse, and a head mount that had since come back was unreachable for
 * the rest of the session. The comment above the call site has always claimed
 * "keeps every candidate reachable"; this is that claim, executed.
 */
export function rotateCandidates<T>(streams: readonly T[], start: number): T[] {
  if (streams.length === 0) return [];
  const n = streams.length;
  // Defensive against a negative or fractional counter: the walk is modular in
  // both directions and never throws a hole in the list.
  const at = ((Math.trunc(start) % n) + n) % n;
  return [...streams.slice(at), ...streams.slice(0, at)];
}
