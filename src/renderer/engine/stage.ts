/**
 * The audio stage: the WebAudio graph, the inter-station hiss, and the meter
 * that reads the station tap. Owns everything that makes sound; knows nothing
 * about streams, sessions or phases.
 *
 * Built lazily because browsers create an AudioContext in the `suspended` state
 * until a user gesture arrives.
 */

import type { Settings } from '../../shared/contracts.js';
import { AudioGraph } from './graph.js';
import { NoisePath } from './noise.js';
import { SignalMeter } from './meter.js';

/**
 * How much of the station survives a given proximity.
 *
 * Complementary to `NoisePath.currentGain`, which uses `(1 - proximity)^1.8`.
 * The exponent here is below 1 so the station holds up through the middle of
 * the lock zone and then falls away quickly at the edges: a real front end does
 * not lose half the carrier for half a channel of detune, it holds and then
 * drops off a cliff. At proximity 0 — nowhere near a station — the station is
 * silent and all that is left is the band.
 */
export function stationGainFor(proximity: number): number {
  // Not merely defensive: an AudioParam handed a NaN throws, and `Math.max`
  // propagates NaN rather than clamping it.
  if (!Number.isFinite(proximity)) return 0;
  const p = Math.min(1, Math.max(0, proximity));
  return Math.pow(p, 0.6);
}

export class AudioStage {
  private graph?: AudioGraph;
  private noise?: NoisePath;
  private meter?: SignalMeter;
  private proximity = 1;

  constructor(private readonly element: HTMLAudioElement) {}

  /** Builds the graph if needed and resumes the context. Safe to call repeatedly. */
  async unlock(settings: Settings): Promise<void> {
    if (!this.graph) {
      this.graph = new AudioGraph(this.element);
      this.noise = new NoisePath(this.graph.ctx, this.graph.noiseDestination);
      this.meter = new SignalMeter(this.graph.stationAnalyser);
      this.noise.setProximity(this.proximity);
      this.graph.setStationGain(stationGainFor(this.proximity));
    }
    await this.graph.resume();
    this.noise?.start();
    this.applySettings(settings);
  }

  /**
   * Standby. Stop generating the inter-station hiss and let the context idle.
   *
   * The hiss is a looping three-second noise buffer through a highpass, a
   * bandpass and a gain; it plays for as long as the graph is alive, and the
   * graph was alive for as long as the app was. With the receiver switched off
   * that is a synthesiser running for nobody — measured at 5.9% of a core in
   * standby-after-use against 0.0% on a cold standby that has never built the
   * graph, which is the whole of that difference.
   *
   * Reversed by `unlock()`, which every tune goes through: the context resumes,
   * `start()` builds a fresh noise source, and `applySettings` puts the gain
   * back where the panel says it should be. Nothing is destroyed, so nothing
   * has to be rebuilt but the buffer.
   */
  async idle(): Promise<void> {
    this.noise?.stop();
    await this.graph?.suspend();
  }

  applySettings(settings: Settings): void {
    this.graph?.setVolume(settings.volume);
    this.graph?.setBassDb(settings.bassDb);
    this.graph?.setTrebleDb(settings.trebleDb);
    this.noise?.setNoiseFloor(settings.noiseFloor);
  }

  /**
   * 0 = between stations (full hiss, no station), 1 = locked on (no hiss, full
   * station).
   *
   * Both paths, not just the hiss. Feeding only the noise made "tuning between
   * stations" mean faint static laid over unchanged, full-volume music: at full
   * detune with RF GAIN at 0.55 the hiss reaches ~0.121 against a station RMS of
   * ~0.6, some 14 dB down, so the station was never actually lost. Detuning has
   * to cost you the signal or the dial is a playlist selector with a sound
   * effect.
   */
  setProximity(proximity: number): void {
    this.proximity = Math.min(1, Math.max(0, proximity));
    this.noise?.setProximity(this.proximity);
    this.graph?.setStationGain(stationGainFor(this.proximity));
  }

  /** The station path's current attenuation, 0..1. For diagnostics. */
  get stationGain(): number {
    return stationGainFor(this.proximity);
  }

  get tuningProximity(): number {
    return this.proximity;
  }

  /**
   * Level deflection from the decoded station audio, 0..1. Tapped after the
   * detune attenuator but before the master gain and before the hiss joins, so
   * it measures the signal the front end recovered rather than what happens to
   * be coming out of the speaker. This is only half of the meter reading; the
   * engine multiplies in link health.
   */
  readSignalLevel(): number {
    return this.meter?.read() ?? 0;
  }

  get noiseGain(): number {
    return this.noise?.currentGain ?? 0;
  }

  get contextState(): string | undefined {
    return this.graph?.ctx.state;
  }

  /** Post-master analyser, for any output visualisation the UI wants. */
  get outputAnalyser(): AnalyserNode | undefined {
    return this.graph?.outputAnalyser;
  }

  dispose(): void {
    this.noise?.stop();
    void this.graph?.close();
    this.graph = undefined;
    this.noise = undefined;
    this.meter = undefined;
  }
}
