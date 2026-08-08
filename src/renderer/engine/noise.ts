/**
 * Inter-station hiss. Real synthesized noise through the real graph — a looping
 * white-noise buffer through a bandpass, so it sounds like a receiver's AF stage
 * rather than a sample of static.
 *
 * Level = AM RF GAIN (Settings.noiseFloor) scaled by how far the dial is from a
 * station. Locked on (proximity 1) it is silent; between stations it comes up.
 */

/** Ceiling for the noise gain so full RF GAIN is loud but never painful. */
const MAX_GAIN = 0.22;
const CENTER_HZ = 2200;
const Q = 0.55;
const BUFFER_SECONDS = 3;
const FADE = 0.12;

export class NoisePath {
  private readonly ctx: BaseAudioContext;
  private readonly gain: GainNode;
  private readonly band: BiquadFilterNode;
  private readonly highpass: BiquadFilterNode;
  private source?: AudioBufferSourceNode;

  private noiseFloor = 0;
  private proximity = 1;

  constructor(ctx: BaseAudioContext, destination: AudioNode) {
    this.ctx = ctx;

    this.highpass = ctx.createBiquadFilter();
    this.highpass.type = 'highpass';
    this.highpass.frequency.value = 320;

    this.band = ctx.createBiquadFilter();
    this.band.type = 'bandpass';
    this.band.frequency.value = CENTER_HZ;
    this.band.Q.value = Q;

    this.gain = ctx.createGain();
    this.gain.gain.value = 0;

    this.highpass.connect(this.band);
    this.band.connect(this.gain);
    this.gain.connect(destination);
  }

  /** Starts the noise generator. Idempotent. */
  start(): void {
    if (this.source) return;
    const frames = Math.floor(this.ctx.sampleRate * BUFFER_SECONDS);
    const buffer = this.ctx.createBuffer(1, frames, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.connect(this.highpass);
    src.start();
    this.source = src;
  }

  /** 0 = nowhere near a station, 1 = locked on. */
  setProximity(proximity: number): void {
    this.proximity = clamp01(proximity);
    this.apply();
  }

  /** AM RF GAIN, 0..1. */
  setNoiseFloor(noiseFloor: number): void {
    this.noiseFloor = clamp01(noiseFloor);
    this.apply();
  }

  get currentGain(): number {
    // Curved so the hiss dies away quickly in the last stretch of the lock zone,
    // the way a real AGC snaps quiet as the carrier comes up.
    return this.noiseFloor * Math.pow(1 - this.proximity, 1.8) * MAX_GAIN;
  }

  private apply(): void {
    if (!this.source) return;
    this.gain.gain.setTargetAtTime(this.currentGain, this.ctx.currentTime, FADE);
  }

  stop(): void {
    try {
      this.source?.stop();
    } catch {
      /* already stopped */
    }
    this.source?.disconnect();
    this.source = undefined;
    this.gain.gain.value = 0;
  }
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}
