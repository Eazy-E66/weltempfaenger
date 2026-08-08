/**
 * The WebAudio graph.
 *
 *   HTMLAudioElement ─▶ MediaElementSource ─▶ Bass(lowshelf) ─▶ Treble(highshelf)
 *        ─▶ StationGain ─▶ MasterGain ─▶ SoftLimiter ─▶ Analyser ─▶ destination
 *                             ▲
 *   NoiseSource ─▶ NoiseBandpass ─▶ NoiseGain ─┘
 *
 * StationGain is the front end's selectivity: the dial's distance from a
 * station's slot attenuates the station itself, so detuning genuinely loses the
 * signal instead of laying faint hiss over unchanged, full-volume music. It sits
 * before MasterGain and can only ever reduce, so it cannot drive the limiter.
 *
 * The limiter is a safety stage, not a sound: measured at the OS sink, +12 dB of
 * BASS at full VOLUME hard-clipped 0.5% of output samples, and both tone
 * controls boosted clipped 1.2%. The curve below is exactly linear beneath
 * -1.9 dBFS, so it changes nothing until the tone stage would otherwise have
 * driven the output past full scale.
 *
 * A second analyser taps the station path after StationGain but *before* the
 * master gain and before the hiss joins. That is the one `signalLevel` is read
 * from, which keeps the meter honest in three directions: turning VOLUME down
 * does not fake a dead signal, inter-station hiss does not fake a live one, and
 * detuning off a station reads on the meter as the lost signal it is — exactly
 * as an S-meter reads the front end rather than the loudspeaker.
 */

const BASS_HZ = 180;
const TREBLE_HZ = 3200;
/** Parameter ramp constant. Long enough to avoid zipper noise, short enough to feel instant. */
const RAMP = 0.02;
/** Detune crossfade constant. Matches NoisePath's FADE so the two are complements. */
const STATION_FADE = 0.12;

export class AudioGraph {
  readonly ctx: AudioContext;
  readonly element: HTMLAudioElement;

  private readonly source: MediaElementAudioSourceNode;
  readonly bass: BiquadFilterNode;
  readonly treble: BiquadFilterNode;
  /** Front-end selectivity: how much of the station survives the current detune. */
  readonly stationGain: GainNode;
  readonly master: GainNode;
  /** Catches tone-boost overshoot before the output stage clips it. */
  readonly limiter: WaveShaperNode;
  /** Reads the signal that actually leaves, limiter included. */
  readonly outputAnalyser: AnalyserNode;
  /** Station path only. The signal meter reads this. */
  readonly stationAnalyser: AnalyserNode;

  constructor(element: HTMLAudioElement, ctx?: AudioContext) {
    this.element = element;
    this.ctx = ctx ?? new AudioContext({ latencyHint: 'playback' });

    // Only legal once per element — the engine keeps one element for its whole life.
    this.source = this.ctx.createMediaElementSource(element);

    this.bass = this.ctx.createBiquadFilter();
    this.bass.type = 'lowshelf';
    this.bass.frequency.value = BASS_HZ;

    this.treble = this.ctx.createBiquadFilter();
    this.treble.type = 'highshelf';
    this.treble.frequency.value = TREBLE_HZ;

    this.stationGain = this.ctx.createGain();
    this.stationGain.gain.value = 1; // locked on until the dial says otherwise

    this.master = this.ctx.createGain();

    this.limiter = this.ctx.createWaveShaper();
    this.limiter.curve = softClipCurve();
    this.limiter.oversample = '4x'; // the knee is nonlinear; don't alias it back down

    this.outputAnalyser = this.ctx.createAnalyser();
    this.outputAnalyser.fftSize = 2048;
    this.outputAnalyser.smoothingTimeConstant = 0;

    this.stationAnalyser = this.ctx.createAnalyser();
    this.stationAnalyser.fftSize = 2048;
    this.stationAnalyser.smoothingTimeConstant = 0;

    this.source.connect(this.bass);
    this.bass.connect(this.treble);
    this.treble.connect(this.stationGain);
    this.stationGain.connect(this.master);
    this.master.connect(this.limiter);
    this.limiter.connect(this.outputAnalyser);
    this.outputAnalyser.connect(this.ctx.destination);

    // Branch tap: an AnalyserNode with no outgoing connection still analyses.
    this.stationGain.connect(this.stationAnalyser);
  }

  /** Where the noise path joins. */
  get noiseDestination(): AudioNode {
    return this.master;
  }

  setVolume(volume: number): void {
    ramp(this.master.gain, clamp(volume, 0, 1), this.ctx.currentTime);
  }

  /**
   * How much of the station reaches the output, 0..1. Only ever an attenuation,
   * so it cannot push the tone stage into the limiter's knee.
   */
  setStationGain(gain: number): void {
    // Deliberately the hiss path's fade constant rather than the control-ramp
    // one: station and noise are two halves of the same crossfade, and giving
    // them different time constants leaves an audible hole in the middle of a
    // fast sweep where neither is up yet.
    this.stationGain.gain.setTargetAtTime(
      clamp(gain, 0, 1),
      this.ctx.currentTime,
      STATION_FADE,
    );
  }

  setBassDb(db: number): void {
    ramp(this.bass.gain, clamp(db, -12, 12), this.ctx.currentTime);
  }

  setTrebleDb(db: number): void {
    ramp(this.treble.gain, clamp(db, -12, 12), this.ctx.currentTime);
  }

  /** Browsers start the context suspended until a user gesture. */
  async resume(): Promise<void> {
    if (this.ctx.state !== 'running') {
      try {
        await this.ctx.resume();
      } catch {
        /* still suspended; the UI will retry on the next gesture */
      }
    }
  }

  /**
   * Stop rendering audio until something asks for it again.
   *
   * A running AudioContext renders its whole graph every quantum whether or not
   * anything is connected to a source with samples in it — two biquads, two
   * gains, a waveshaper and two analysers, 48,000 times a second, on the audio
   * thread. Measured on the packaged build with the receiver switched OFF and
   * nothing playing: 5.9% of a core in the renderer process, indefinitely.
   *
   * Suspending is not closing: the graph, the element's MediaElementSource and
   * every setting survive, and `resume()` brings the same stage back. Closing
   * would be irreversible — a MediaElementSource can be created once per
   * element per context — which is precisely why standby had been left running.
   */
  async suspend(): Promise<void> {
    if (this.ctx.state !== 'running') return;
    try {
      await this.ctx.suspend();
    } catch {
      /* nothing to suspend */
    }
  }

  async close(): Promise<void> {
    try {
      await this.ctx.close();
    } catch {
      /* already closed */
    }
  }
}

/** Below the knee the response is the identity; above it, asymptotic to the ceiling. */
const SOFT_KNEE = 0.8;
/**
 * Deliberately short of 1.0. WaveShaper's 4x oversampling reconstructs through a
 * filter that rings past the curve's own maximum, so a curve asymptotic to 1.0
 * still put 0.2% of samples at full scale under a double tone boost. This leaves
 * that overshoot somewhere to go.
 */
const SOFT_CEILING = 0.92;

// Return type inferred, not annotated: lib.dom pins WaveShaperNode.curve to an
// ArrayBuffer-backed view, which a bare `Float32Array` annotation widens away.
function softClipCurve(points = 8192) {
  const curve = new Float32Array(points);
  for (let i = 0; i < points; i++) {
    const x = (i / (points - 1)) * 2 - 1;
    const a = Math.abs(x);
    const y =
      a <= SOFT_KNEE
        ? a
        : SOFT_KNEE +
          (SOFT_CEILING - SOFT_KNEE) * Math.tanh((a - SOFT_KNEE) / (SOFT_CEILING - SOFT_KNEE));
    curve[i] = Math.sign(x) * y;
  }
  return curve;
}

function ramp(param: AudioParam, value: number, now: number): void {
  param.setTargetAtTime(value, now, RAMP);
}

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;
}
