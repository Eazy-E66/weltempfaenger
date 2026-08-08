/**
 * The signal meter.
 *
 * The face is silkscreened SIGNAL … HEALTH under a red "weak" arc and a teal
 * "strong" one, and Law 1's own audit says the movement should show "RMS of
 * decoded audio + connection/buffer health". So it shows both, multiplied:
 *
 *     deflection = linkHealth × levelDeflection
 *
 * That is the honest reading of the printed scale. Programme loudness alone is
 * a true number on a false scale — a quiet passage on a flawless 320 kbps mount
 * would drive the needle into the red zone marked "weak signal", which the
 * number cannot support. Multiplying by measured link health makes the left end
 * mean what it says: either the bytes have stopped, or the buffer has drained,
 * or there is no programme coming out of the decoder. Any of those *is* a weak
 * signal. All three good, and the needle sits in the teal.
 *
 * Nothing here is a timer. `levelDeflection` is RMS from the analyser and
 * nothing else; `linkHealth` is byte flow, buffer depth and session state as the
 * proxy reports them. Silence still reads exactly zero — see SILENCE_RMS below.
 *
 * --- Calibration -----------------------------------------------------------
 *
 * The old window (-60 … -6 dBFS) was set for material that no longer exists.
 * Measured on five live stations, 30 s each, raw analyser RMS at 20 Hz:
 *
 *   station                        dB min/med/max     deflection    sweep used
 *   SomaFM Groove Salad 128k MP3   -21.0/-13.8/-8.2   0.72/0.86/0.96     25.5°
 *   NRJ Paris 128k MP3             -21.4/-14.0/-8.0   0.72/0.85/0.96     26.7°
 *   SWR2 256k MP3                  -22.6/-14.4/-7.9   0.69/0.84/0.96     29.4°
 *   NIUS 192k MP3                  -50.8/-15.3/-8.4   0.17/0.83/0.96     84.8°
 *   FIP 192k AAC                   -19.5/-14.1/-7.8   0.75/0.85/0.97     23.5°
 *
 * Loudness-normalised broadcast — which is most of the directory — lives in a
 * ~13 dB band around -14 dBFS. On the old window that is 23-29° of a 108° sweep
 * pinned against the top of the scale, with 6 dB of headroom that any persisted
 * BASS boost eats, at which point the needle sits on the end stop and stops
 * being an instrument at all.
 *
 * The window below is that measured band with room either side. Re-measured on
 * NIUS 192k MP3 through the shipped build, 330 samples at 10 Hz:
 *
 *                      old (-60/-6)          new (-38/-4)
 *   deflection         0.72 / 0.83 / 0.96    0.53 / 0.76 / 0.90
 *   sweep used         25.5°                 40.0°
 *   pinned at 1.000    0/291                 0/330
 *
 * and with a persisted BASS +5 / TREBLE +5, which used to park the needle on the
 * end stop for 49 of 60 samples: 0 of 310 pinned, median 0.88, 52° of sweep.
 */

/**
 * Below this the programme is quieter than any broadcast material and the
 * needle is on its way to the stop. -38 dBFS RMS is a genuinely quiet passage,
 * not a fade-out artefact.
 */
const FLOOR_DB = -38;
/**
 * Full-scale deflection. Measured broadcast peaks reach about -8 dBFS RMS; -4
 * keeps full scale rare and reachable rather than a place the needle lives.
 */
const TOP_DB = -4;

/**
 * Anything at or below this is silence, not a level, and pins the movement to
 * zero immediately with no ballistic tail. Law 2: "A dead or silent stream
 * reads zero on the meter."
 */
const SILENCE_RMS = 1e-6;

/**
 * Movement ballistics, seconds. The analyser window is 2048 samples (~46 ms),
 * which is short enough that the raw reading jitters with individual drum hits.
 * A real moving-coil movement integrates; so does this. Asymmetric, as meter
 * ballistics always are: it rises quickly enough to show a real transient and
 * falls slowly enough not to flicker between syllables.
 *
 * These are deliberately light. A first attempt at 0.12/0.45 s was measured on
 * live audio and gave back only 23.9° of sweep — a wider window and a
 * better-placed needle, but still a dead instrument, because the integrator had
 * eaten the programme dynamics the recalibration was supposed to reveal. The UI
 * movement adds its own second-order smoothing on top of this (2.3 Hz, ζ 0.62),
 * so the engine's job is to stop the analyser jitter, not to still the needle.
 */
const ATTACK_S = 0.04;
const RELEASE_S = 0.18;

/** Longest step the integrator will honour, so a stalled tab cannot jump it. */
const MAX_STEP_S = 0.25;

function makeBuffer(size: number) {
  return new Float32Array(size);
}

export class SignalMeter {
  // Inferred, not annotated: lib.dom pins getFloatTimeDomainData to an
  // ArrayBuffer-backed view, which a bare `Float32Array` annotation widens away.
  private readonly buffer: ReturnType<typeof makeBuffer>;

  /** Integrated mean square, i.e. the movement's position in power terms. */
  private power = 0;
  private lastAt?: number;

  constructor(
    private readonly analyser: AnalyserNode,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.buffer = makeBuffer(analyser.fftSize);
  }

  /** Raw RMS of the current analyser window, 0..1 linear. No ballistics. */
  rms(): number {
    this.analyser.getFloatTimeDomainData(this.buffer);
    let sum = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const s = this.buffer[i]!;
      sum += s * s;
    }
    return Math.sqrt(sum / this.buffer.length);
  }

  /**
   * Integrated RMS, 0..1 linear. Time-based rather than per-call, so it behaves
   * identically whether it is read once per engine tick or once per frame.
   */
  integratedRms(): number {
    const raw = this.rms();
    const at = this.now();
    const dt = this.lastAt === undefined ? MAX_STEP_S : Math.min(MAX_STEP_S, (at - this.lastAt) / 1000);
    this.lastAt = at;

    if (!(raw > SILENCE_RMS)) {
      // Not a quiet level — no signal at all. Snap, do not coast.
      this.power = 0;
      return 0;
    }
    const target = raw * raw;
    const tau = target > this.power ? ATTACK_S : RELEASE_S;
    const alpha = dt <= 0 ? 0 : 1 - Math.exp(-dt / tau);
    this.power += (target - this.power) * alpha;
    return Math.sqrt(Math.max(0, this.power));
  }

  /**
   * Level deflection, 0..1, from the integrated RMS on the calibrated dB
   * window. Exactly zero when the decoded output is silent.
   */
  read(): number {
    return deflectionFor(this.integratedRms());
  }
}

/** The dB mapping on its own, so a test can pin the window without an analyser. */
export function deflectionFor(rms: number): number {
  if (!(rms > SILENCE_RMS)) return 0;
  const db = 20 * Math.log10(rms);
  if (db <= FLOOR_DB) return 0;
  return Math.min(1, (db - FLOOR_DB) / (TOP_DB - FLOOR_DB));
}

// ---------------------------------------------------------------------------
// Link health — the other half of the reading
// ---------------------------------------------------------------------------

/** Below this depth the link is not keeping ahead of the decoder. */
const HEALTHY_BUFFER_S = 2;
/**
 * Byte flow is bursty by nature — the proxy forwards in chunks — so a gap
 * shorter than this says nothing. Beyond it the link is visibly drying up, and
 * by FLOW_DEAD_MS it is gone. The proxy's own stall detector fires later than
 * this and is treated as immediately fatal when it does.
 */
const FLOW_FRESH_MS = 1_200;
const FLOW_DEAD_MS = 4_000;

export interface LinkEvidence {
  /** A proxy session exists and has not been closed. */
  connected: boolean;
  /** The proxy's own stall detector has fired. */
  stalled: boolean;
  /** HTMLMediaElement.buffered ahead of the playhead, seconds. */
  bufferedSeconds: number;
  /** Audio written to the renderer but not yet consumed, seconds. */
  pipelineSeconds: number;
  /** Milliseconds since the received-byte counter last increased. */
  sinceBytesMs: number;
}

/**
 * How healthy the link is, 0..1. Every input is measured: session state and
 * byte flow from the proxy, buffer depth from HTMLMediaElement.buffered.
 *
 * The two terms are combined with `min`, not a product: a link is only as good
 * as its worst symptom, and multiplying two 0.7s to get 0.49 would understate a
 * link that is merely a bit shallow.
 */
export function linkHealth(e: LinkEvidence): number {
  if (!e.connected || e.stalled) return 0;

  const depth = Math.max(0, e.bufferedSeconds) + Math.max(0, e.pipelineSeconds);
  const bufferTerm = clamp01(depth / HEALTHY_BUFFER_S);

  const flowTerm =
    e.sinceBytesMs <= FLOW_FRESH_MS
      ? 1
      : clamp01((FLOW_DEAD_MS - e.sinceBytesMs) / (FLOW_DEAD_MS - FLOW_FRESH_MS));

  return Math.min(bufferTerm, flowTerm);
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}
