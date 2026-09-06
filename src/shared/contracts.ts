/**
 * Core contracts. Discovery, resolution, and playback are three separate concerns
 * that only meet through these types. Nothing here imports Electron or the DOM,
 * so every implementation is unit-testable against fixtures.
 */

// ---------------------------------------------------------------------------
// Discovery: "what stations exist?"  (never touches audio)
// ---------------------------------------------------------------------------

/** A station as a directory reports it. The `url` is a *candidate*, not playable yet. */
export interface StationRef {
  id: string;
  name: string;
  /** Candidate URL. May be a playlist (.pls/.m3u), a redirect, or a direct stream. */
  url: string;
  homepage?: string;
  faviconUrl?: string;
  /** Genre tags as the directory reports them, lowercased. */
  tags: string[];
  countryCode?: string;
  country?: string;
  /** The directory's first-listed language for this station. Display only. */
  language?: string;
  /**
   * *Every* language the directory files this station under, lowercased.
   *
   * Radio Browser's `language` field is a comma-separated list and its
   * `language=` query matches any member of it, so a station listed
   * `english,german` really is part of the German population and really does
   * come back from a German fetch. Keeping only the first entry made the
   * register drop that station again locally, under-reporting every tongue — and
   * made pulling two tongue cards unsatisfiable by construction, because a
   * single-valued field cannot equal two things at once.
   *
   * Always contains `language` when that is set, so a reader may use this alone.
   */
  languages?: string[];
  /** Directory's claimed bitrate in kbps. Advisory only — the engine measures the truth. */
  claimedBitrate?: number;
  /** Directory's claimed codec, e.g. "MP3", "AAC". Advisory only. */
  claimedCodec?: string;
  /** Popularity signal used to lay stations out along the dial. Higher = stronger. */
  popularity: number;
  /** Approximate geographic position, for the world map on the lid. */
  geo?: { lat: number; lon: number };

  // --- what a printed register puts in its columns. All advisory: these are
  // the directory's own bookkeeping, never a measurement this app made.
  /** Directory click count — the ledger's LISTENERS column. */
  clickCount?: number;
  /** Directory vote count. */
  votes?: number;
  /** The directory's own last-check verdict on this URL. */
  lastCheckOk?: boolean;
  /** Days since the directory last checked it successfully. */
  lastCheckAgeDays?: number;
  /**
   * The candidate URL is an HLS manifest. Marked rather than hidden: Chromium
   * has no demuxer for it, and a row struck out for a stated reason is a
   * designed state where a silently missing row is a defect (Law 4).
   */
  hls?: boolean;
}

export interface StationQuery {
  /**
   * A subject term. Providers that fold spellings expand this back into one
   * query per spelling — see `GenreTag.spellings`.
   */
  genre?: string;
  /** ISO 3166-1 alpha-2 origin. */
  countryCode?: string;
  /** The directory's own language name, e.g. `brazilian portuguese`. */
  language?: string;
  /** Free-text search over station names. */
  text?: string;
  limit: number;
  offset?: number;
}

/** A genre as it actually exists in the directory, with a real station count. */
export interface GenreTag {
  /** The highest-count spelling in the group — what the panel prints. */
  name: string;
  /** Stations across *every* spelling in the group, summed. */
  stationCount: number;
  /**
   * Every spelling the directory holds for this genre, canonical first.
   *
   * A directory tag list is user-typed, so one genre arrives as several tags:
   * `trip-hop` 24, `trip hop` 14, `triphop` 8. Folding them makes the genre
   * reachable (46 stations, not three unreachable slivers) but the directory
   * still only understands the original strings — a `tag=` query for the
   * canonical spelling returns 24 of the 46. So the members are carried here,
   * and a provider expands the group back into one query per spelling.
   *
   * Always non-empty; `spellings[0] === name`. Most groups have exactly one.
   */
  spellings: string[];
}

// ---------------------------------------------------------------------------
// The register's index: the three axes a printed station handbook is filed by.
// ---------------------------------------------------------------------------

/** One origin, as the directory files it, plus a place to draw it. */
export interface RegisterPlace {
  /** ISO 3166-1 alpha-2. */
  code: string;
  /** Short enough to print in a card index. */
  name: string;
  stationCount: number;
}

/** One tongue, as the directory names it. */
export interface RegisterTongue {
  name: string;
  stationCount: number;
}

/**
 * The register's printed edition: every term the directory files under, with
 * the directory's own counts.
 *
 * This is the index of a handbook, not a copy of one. It carries the terms and
 * their counts — thousands of short strings — and never the station records
 * themselves, which are fetched per scope. That is what keeps this one round
 * trip rather than a cached copy of the whole directory.
 */
export interface RegisterIndex {
  /** Provider id, printed in the colophon. */
  source: string;
  /** When this edition was pulled. */
  pulledAt: number;
  /** What the directory says it holds, for the colophon. Zero when unknown. */
  totals: { stations: number; tags: number; countries: number; languages: number };
  /** Subject terms, spellings folded, biggest first. */
  subjects: GenreTag[];
  /** Origins, biggest first. */
  origins: RegisterPlace[];
  /** Tongues, biggest first. */
  tongues: RegisterTongue[];
}

/**
 * Station discovery. Swappable: RadioBrowserProvider (live) and
 * FixtureProvider (deterministic, offline) both implement this.
 */
export interface DirectoryProvider {
  readonly id: string;
  /** Genres with real counts, so the band selector reflects the directory, not a hardcoded list. */
  listGenres(minStations: number): Promise<GenreTag[]>;
  /**
   * The whole printed index: subjects, origins and tongues in one pull.
   *
   * Law 3 pressure, taken deliberately. The register files by three axes and
   * the directory has no faceted-count endpoint, so it must be handed the
   * vocabulary once rather than asked a question per keystroke. It is still
   * discovery, it still never touches audio, and a provider that *can* facet
   * server-side is free to answer this from a cheaper source.
   */
  listIndex(): Promise<RegisterIndex>;
  search(query: StationQuery): Promise<StationRef[]>;
  /** Fire-and-forget popularity signal; must never throw into the caller. */
  reportListening?(stationId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Resolution: "what URL can actually be played?"  (never touches audio)
// ---------------------------------------------------------------------------

export interface PlayableStream {
  /** A URL whose response body is audio bytes. */
  url: string;
  /** Content-Type observed on the audio response. */
  contentType?: string;
  /** Bitrate advertised by ICY headers (icy-br), kbps. */
  icyBitrate?: number;
  /** Station name advertised by ICY headers (icy-name). */
  icyName?: string;
  /** True when the server offers ICY metadata (icy-metaint present). */
  supportsIcyMetadata: boolean;
  /** How we got here: direct hit, or unwrapped from a playlist. */
  origin: 'direct' | 'pls' | 'm3u' | 'redirect';
}

/**
 * Which transport-level thing went wrong, as the socket layer itself reported
 * it — never as a string anybody has to read.
 *
 * `kind: 'network'` is too coarse to describe honestly. "The host does not
 * exist", "the host exists and refused", and "the host answered and its
 * certificate is not valid" are three different facts with three different
 * remedies, and the panel used to paper over all three by pasting the
 * transport's own words into a sentence — which shipped
 * `getaddrinfo ENOTFOUND …`, `connect ECONNREFUSED 127.0.0.1:18799` and an
 * OpenSSL routine dump onto a 1977 faceplate, and printed "the station's host
 * did not answer" for an expired certificate, which is simply false: the host
 * answered.
 *
 * So the *classification* happens where the structured information actually
 * exists — `error.code` on a Node socket error — and the sentence is composed
 * from this, closed-set, in `host/faults.ts`. That is what makes the guarantee
 * total rather than a denylist: an unrecognised code degrades to a vaguer
 * sentence, never to raw text.
 */
export type NetworkCause =
  /** The name does not resolve: `ENOTFOUND`, `EAI_AGAIN`. */
  | 'dns'
  /** The host is there and nothing is listening: `ECONNREFUSED`. */
  | 'refused'
  /** No route to the host at all: `EHOSTUNREACH`, `ENETUNREACH`. */
  | 'unreachable'
  /** The connection was opened and then broken: `ECONNRESET`, `EPIPE`. */
  | 'reset'
  /** The TLS handshake failed or the certificate did not check out. */
  | 'tls'
  /** Something answered, but not in HTTP or ICY. */
  | 'protocol'
  /** Classified as nothing more specific. Still never prints raw text. */
  | 'unknown';

export type ResolveFailure =
  | { kind: 'network'; message: string; cause?: NetworkCause }
  | { kind: 'http'; status: number; message: string }
  | { kind: 'not-audio'; contentType: string; message: string }
  /**
   * An HLS manifest. Split out of `not-audio` because it is not the same
   * problem: the URL *is* audio, it is simply packaged in a container Chromium
   * has no native demuxer for. "This station is HLS, which this receiver cannot
   * decode" is actionable; "not audio" would be a lie the user cannot act on.
   */
  | { kind: 'hls'; message: string }
  | { kind: 'empty-playlist'; message: string }
  | { kind: 'too-many-redirects'; message: string }
  | { kind: 'timeout'; message: string };

export type ResolveResult =
  | { ok: true; streams: PlayableStream[] }
  | { ok: false; failure: ResolveFailure };

/**
 * Turns a candidate URL into playable streams: follows redirects, unwraps
 * PLS/M3U playlists, sniffs content types. Returns candidates in preference
 * order; the engine tries them in turn.
 */
export interface StreamResolver {
  resolve(url: string, opts?: { signal?: AbortSignal }): Promise<ResolveResult>;
}

// ---------------------------------------------------------------------------
// Playback: "what is the audio engine actually doing right now?"
// ---------------------------------------------------------------------------

/**
 * Engine phases. These are derived from real HTMLAudioElement events, real
 * proxy byte flow, and real AnalyserNode output — never set optimistically by
 * a UI action. A button press requests a transition; only the engine reports one.
 */
export type PlaybackPhase =
  | 'idle'        // standby, nothing loaded
  | 'resolving'   // asking the resolver for a playable URL
  | 'connecting'  // socket opening upstream, no audio bytes yet
  | 'buffering'   // bytes arriving, not enough to play
  | 'playing'     // decoder producing audio
  | 'stalled'     // was playing, byte flow dried up
  | 'reconnecting'// AFC re-locking after a drop
  | 'error';      // gave up; `error` is populated

export interface PlaybackError {
  kind: ResolveFailure['kind'] | 'decode' | 'upstream-closed' | 'aborted';
  /**
   * A sentence for a listener, never a diagnostic.
   *
   * The engine guarantees this carries none of the browser's internals — no
   * `MEDIA_ELEMENT_ERROR`, no demuxer identifiers, no API names. Those are real
   * and are kept, but they belong in `PlaybackEngine.diagnostics()`, because a
   * 1977 receiver's panel describing an FFmpeg call stack is not a designed
   * failure state, it is an unhandled one (Law 4).
   */
  message: string;
  /** Attempts made before giving up. */
  attempts: number;
}

/**
 * Why the meter is on its zero stop, when it is.
 *
 * `signalLevel` reading zero is a measurement; this says which of the three
 * things it measured. Law 4: dead air is a designed state, and a designed state
 * has to be able to say which one it is. Never inferred from intent — each of
 * these comes from a different observed quantity (proxy byte flow, the station
 * path's own gain, the analyser).
 */
export type SignalLoss =
  /** The proxy's stall detector fired: bytes stopped arriving. */
  | 'flow-stopped'
  /** The dial is off-station, so the front end has closed on purpose. */
  | 'detuned'
  /** Bytes are flowing and the front end is open, but the decoder emits silence. */
  | 'dead-air';

/**
 * An AFC re-lock in flight. Present only while `phase` is `reconnecting`.
 *
 * The panel could not previously say a retry was happening at all: `error` is
 * populated on terminal failure only, so anything reading it during a reconnect
 * read `undefined`. This is the live counter.
 */
export interface RetryProgress {
  /** Attempt in flight on this mount, 1-based. */
  attempt: number;
  /** Attempts this mount gets before the engine moves to the next one. */
  budget: number;
  /** Candidate mount being tried, 1-based. */
  mount: number;
  /** Candidate mounts the resolver found for this station. */
  mounts: number;
}

/** Live "now playing" text, parsed from the ICY metadata stream by the proxy. */
export interface NowPlaying {
  /**
   * The display line: `Artist - Track` when both are known, otherwise whatever
   * the station actually named. Already cleaned of the `key="value"` scheduling
   * records iHeart/Triton mounts pack into `StreamTitle` — the undecorated
   * block is kept on `ProxyMetadata.raw` for diagnostics.
   */
  title: string;
  /** Split from `Artist - Track`, or read from a keyed `artist="…"` field. */
  artist?: string;
  track?: string;
  receivedAt: number;
}

/**
 * A snapshot of what the audio engine is really doing. Every field is measured,
 * not assumed. The UI renders this and nothing else.
 */
export interface PlaybackState {
  phase: PlaybackPhase;
  station?: StationRef;
  stream?: PlayableStream;
  nowPlaying?: NowPlaying;
  error?: PlaybackError;

  /**
   * Delivery throughput measured from bytes actually handed to the decoder,
   * kbps. This is a genuine measurement and is kept for diagnostics — but it is
   * *not* the codec's rate and must never be printed as one. Icecast's
   * burst-on-connect legitimately dumps several seconds of audio at wire speed,
   * so the first windows after a tune read four to ten times the codec figure,
   * and even in the steady state it wanders with TCP pacing.
   */
  measuredBitrateKbps?: number;
  /**
   * The codec's own rate, kbps — what "192 kbps MP3" actually means. Read from
   * the decoded MPEG frame headers where the container declares one (only
   * trusted after two frames chain), falling back to the `icy-br` header for
   * codecs whose frames do not, such as AAC in ADTS.
   *
   * Undefined until one of those is known. That is the point: the readout shows
   * an em-dash rather than the delivery rate, because a number the named codec
   * cannot produce is worse than no number at all.
   */
  codecBitrateKbps?: number;
  /** Decoder's real sample rate, Hz. */
  sampleRate?: number;
  /** Seconds of audio buffered ahead, from HTMLMediaElement.buffered. */
  bufferedSeconds: number;
  /** Wall-clock seconds since audio actually started flowing. */
  playingSeconds: number;
  /** Bytes received from upstream this session. */
  bytesReceived: number;

  /**
   * Real signal level, 0..1, computed from AnalyserNode RMS of the decoded
   * output. Drives the TUNING meter needle. Zero while silent — which is why
   * the meter is honest: a dead stream reads dead.
   */
  signalLevel: number;

  /**
   * Why `signalLevel` is zero, when the engine has established that it is
   * persistently zero. Undefined whenever there is a signal.
   */
  signalLoss?: SignalLoss;

  /**
   * The AFC re-lock in flight. Present only while `phase` is `reconnecting`;
   * cleared the moment the attempt succeeds or the engine gives up.
   */
  retry?: RetryProgress;
}

export const INITIAL_PLAYBACK_STATE: PlaybackState = {
  phase: 'idle',
  bufferedSeconds: 0,
  playingSeconds: 0,
  bytesReceived: 0,
  signalLevel: 0,
};

// ---------------------------------------------------------------------------
// Tuning: the dial model. Stations laid out along a band.
// ---------------------------------------------------------------------------

/**
 * A station placed at a position on the dial. `position` is 0..1 across the
 * band's scale; `width` is how wide the lock zone is — popular stations are
 * wider, so they're easier to land on, exactly like strong transmitters.
 */
export interface DialSlot {
  station: StationRef;
  position: number;
  width: number;
}

/** A band is a genre plus the stations laid out across its scale. */
export interface Band {
  genre: string;
  stationCount: number;
  slots: DialSlot[];
  /** Display scale endpoints, e.g. 88.0 / 108.0 — cosmetic labelling of the strip. */
  scaleMin: number;
  scaleMax: number;
  scaleUnit: 'MHz' | 'kHz';
  /** Meter-band name as printed on the lid chart, e.g. `49m`. */
  scaleLabel?: string;
}

/**
 * What the register threw onto the drum.
 *
 * A drum can carry twelve meter bands of forty entries — 480 — and that is a
 * physical ceiling, not a policy. A scope wider than the drum is cut to its top
 * 480 and the register says so in numbers before the throw is made.
 */
export interface Cut {
  /** The scope in printed words, e.g. `JAZZ · FRANCE`. */
  caption: string;
  /** The claimed-quality line, e.g. `≥128K · MP3` or `ANY RATE`. */
  quality: string;
  /** Entries actually printed onto the drum. */
  printed: number;
  /** Entries the scope holds. Greater than `printed` when the drum overflowed. */
  total: number;
  /** One `Band` per filled meter band, in order. */
  bands: Band[];
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export interface Preset {
  slot: 'C' | 'B' | 'P';
  station: StationRef;
  savedAt: number;
}

/**
 * One line of the operator's log.
 *
 * A receiver's log is a record of what was *heard*, not of what was requested,
 * so an entry is only written once the engine has reported `playing` — a
 * station that was tuned and never came up never happened. That is Law 2
 * applied to history: the log is a measurement, not an intention.
 *
 * `heardAt` is the first moment audio was observed from this station in this
 * sitting; re-tuning the same station later moves the existing line to the top
 * rather than printing a second one, because a log with the same call sign
 * eleven times is not a log.
 */
export interface LogEntry {
  station: StationRef;
  /** Wall clock of the most recent time audio was observed from it. */
  heardAt: number;
}

/** Lines the logbook holds before the oldest falls off the bottom. */
export const LOG_CAPACITY = 12;

/**
 * What the register is currently filed to — the cards pulled out of the deck.
 *
 * This replaces `Settings.genre` / `Settings.countryCode`. There is no genre
 * knob any more, so there is no single genre; there is a scope, and the drum
 * carries whatever the register last cut from it.
 *
 * Nothing in here is authored. `terms` are canonical folded spellings the
 * directory supplied, `origin` is an ISO code the directory supplied, `tongues`
 * are the directory's own language strings.
 */
export interface RegisterScope {
  /** Folded subject terms, canonical spelling. Combined with AND. */
  terms: string[];
  /** ISO 3166-1 alpha-2. Single throw: pulling France replaces Germany. */
  origin?: string;
  /** Directory language names. Combined with AND. */
  tongues: string[];
  /** Free text over station names. */
  text?: string;
  /** Claimed-bitrate floor, kbps. 0 = any. Claimed, and labelled as claimed. */
  minKbps: number;
  /** `ANY`, or a codec family prefix such as `MP3`, `AAC`, `OGG`, `FLAC`. */
  codec: string;
  /**
   * Keep only stations the directory's own checker last reached.
   *
   * A real predicate, and only since the provider stopped asking Radio Browser
   * for `hidebroken=true`. With that parameter on every station query the
   * directory had already removed every row this switch could remove: a critic
   * measured 14 229 rows in hand with **zero** carrying `lastCheckOk === false`,
   * and toggling the lever left the count at 5 634 both ways. A control with no
   * possible job is decoration (Law 1), so the job was given back to it rather
   * than the lever cut — the rows now arrive, the ledger already knows how to
   * print one struck and dated (Law 4), and turning this on removes them.
   */
  verifiedOnly: boolean;
  /** Keep HLS out of the scope. Off, they are printed and struck instead. */
  hideHls: boolean;
}

/**
 * Every key of `T` spelled out, values still allowed to be `undefined`.
 *
 * `RegisterScope` has two optional axes — `origin` and `text` — and a constant
 * that simply omitted them was the direct cause of a shipped dead end: RETURN
 * ALL merged `EMPTY_SCOPE` over the live scope, the two missing keys were
 * therefore not overwritten, and a station-name search survived the one control
 * whose entire job is clearing everything. It then survived quit and relaunch,
 * because it was written to `settings.json` and read back.
 *
 * Mapping over `keyof Required<T>` makes every key mandatory to *write* while
 * `T[K]` keeps the original value type, so an optional axis stays spellable as
 * `undefined` — which is exactly what clearing one means — but cannot be left
 * out. Any axis added to `RegisterScope` later cannot be forgotten here: the
 * constant stops compiling until it says what "cleared" means for it.
 */
export type Complete<T> = { [K in keyof Required<T>]: T[K] };

/**
 * The idle scope: the whole edition, nothing filed down.
 *
 * Structurally complete on purpose — see `Complete`. Prefer `emptyScope()` when
 * you need one to hold and mutate; this constant's arrays are shared by every
 * spread of it.
 *
 * ## Why both levers start disengaged
 *
 * They started engaged, and that made the sentence the register prints beside
 * them structurally unable to be true: `IN SCOPE — NOTHING — THE WHOLE EDITION
 * IS IN SCOPE` while `hideHls` withheld 191 of 2 000 rows, verified by flipping
 * it (1 809 → 2 000). It also wrote a hidden filter into every profile
 * `settings.json` on first run, so a user who never touched a lever inherited
 * two of them.
 *
 * The idle scope is the one the register describes as *the whole edition*, so it
 * has to be the whole edition. Both switches remain, both now do something (see
 * `verifiedOnly`), and both are opt-in — which is also what `StationRef.hls`
 * already said out loud: HLS is "marked rather than hidden … a row struck out
 * for a stated reason is a designed state where a silently missing row is a
 * defect (Law 4)". Hiding it by default contradicted its own contract.
 */
export const EMPTY_SCOPE: Complete<RegisterScope> = {
  terms: [],
  origin: undefined,
  tongues: [],
  text: undefined,
  minKbps: 0,
  codec: 'ANY',
  verifiedOnly: false,
  hideHls: false,
};

/** A fresh idle scope, arrays included, safe to hand to something that mutates. */
export function emptyScope(): Complete<RegisterScope> {
  return { ...EMPTY_SCOPE, terms: [], tongues: [] };
}

export interface Settings {
  volume: number;        // 0..1  VOLUME
  bassDb: number;        // -12..+12  BASS
  trebleDb: number;      // -12..+12  TREBLE
  noiseFloor: number;    // 0..1  AM RF GAIN — inter-station hiss level
  afcEnabled: boolean;   // AFC — auto-reconnect on drop
  bufferDepth: 'narrow' | 'wide'; // NARROW/WIDE — shallow vs deep buffer
  dialLampOn: boolean;   // LIGHT
  /** What the register last cut. Restored on launch, so the band survives. */
  scope: RegisterScope;
  /**
   * The scope the standing band was cut from, or absent when no band of the
   * listener's own is standing.
   *
   * `scope` alone was persisted, which restored the *invisible* half of the
   * state and dropped the half the user performed the ritual for: relaunching
   * brought back `JAZZ · FRANCE` in the register's cards and put `NO BAND CUT`
   * back on the faceplate, with the flywheel locked and the meter band dead.
   *
   * What is stored is the throw, not its output. The rows are re-derived on
   * launch from this scope — the same fetch, the same facet pass, the same
   * `cutBands` — so `settings.json` stays a flat bag of scalars and cannot
   * become a stale private copy of 480 station records that disagrees with the
   * directory. A launch with no network therefore cannot restore the drum, and
   * says so: RECONNECT re-pulls and the band comes back.
   *
   * This used to be a boolean, `cutStanding`, beside `scope` — which made the
   * pair able to lie: pull a card after the throw, quit, and the next launch
   * re-derived a band from the *new* cards that nobody had thrown. The scope of
   * the throw is its own record now; `scope` is only ever what the register's
   * cards show. Old files carrying `cutStanding: true` are read as "the throw
   * was the scope on disk", which is what they meant.
   */
  cutScope?: RegisterScope;
  /** Which meter band of that cut is printed on the drum. */
  cutBandIndex: number;
  lastStationId?: string;
}

export const DEFAULT_SETTINGS: Settings = {
  volume: 0.7,
  bassDb: 0,
  trebleDb: 0,
  noiseFloor: 0.35,
  afcEnabled: true,
  bufferDepth: 'wide',
  dialLampOn: true,
  scope: EMPTY_SCOPE,
  cutBandIndex: 0,
};
