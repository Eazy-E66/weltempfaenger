/**
 * Measured bitrate over a sliding window. Counts *audio* bytes only (ICY
 * metadata is excluded upstream of this), so the number reflects what the
 * decoder is actually being fed rather than what `icy-br` claims.
 *
 * Note this is genuinely the *delivery* rate, not the codec's rate. Icecast's
 * burst-on-connect dumps several seconds of audio at line speed, so the first
 * few windows legitimately read far above the codec bitrate before pacing
 * settles to real time (roughly one window). For a "128 kbps" style readout, use the sniffed
 * `AudioFormat.frameBitrateKbps` instead — that is the codec's own number.
 */
export class RollingBitrate {
  private readonly samples: Array<{ at: number; bytes: number }> = [];
  private windowBytes = 0;

  constructor(
    private readonly windowMs = 5_000,
    private readonly now: () => number = Date.now,
  ) {}

  add(bytes: number): void {
    if (bytes <= 0) return;
    const at = this.now();
    this.samples.push({ at, bytes });
    this.windowBytes += bytes;
    this.trim(at);
  }

  /**
   * kbps across the window, or undefined until there is enough span to divide
   * by honestly (a 40 ms sample of one 16 KiB chunk means nothing).
   */
  kbps(): number | undefined {
    const at = this.now();
    this.trim(at);
    if (this.samples.length < 2) return undefined;
    const spanMs = at - this.samples[0]!.at;
    if (spanMs < 750) return undefined;
    // The first sample's bytes arrived *before* the window opened at its
    // timestamp, so they are not part of the elapsed-time measurement.
    const bytes = this.windowBytes - this.samples[0]!.bytes;
    if (bytes <= 0) return undefined;
    return (bytes * 8) / spanMs; // bytes*8/ms === kbit/s
  }

  private trim(at: number): void {
    const cutoff = at - this.windowMs;
    while (this.samples.length > 2 && this.samples[0]!.at < cutoff) {
      this.windowBytes -= this.samples.shift()!.bytes;
    }
  }
}
