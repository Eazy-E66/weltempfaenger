/**
 * The NARROW/WIDE pre-roll buffer.
 *
 * This has to live on the main-process side of the socket. Chromium will not
 * hold more than roughly two or three seconds of a live MP3 in
 * HTMLMediaElement.buffered however much you feed it, so a "10 second buffer"
 * asked for in the renderer is simply ignored there. Accumulating the audio here
 * and releasing it in one lump puts the depth into the pipe between the proxy
 * and the decoder, where it genuinely survives an upstream hiccup.
 */

/** Never hold more than this, whatever the bitrate turns out to be. */
export const MAX_PREROLL_BYTES = 2 * 1024 * 1024;

export class PrerollBuffer {
  private held: Buffer[] = [];
  private bytes = 0;
  private complete: boolean;
  private deadline = 0;

  constructor(readonly targetSeconds: number) {
    this.complete = targetSeconds <= 0;
  }

  /** Starts the bounded wait. Called when the upstream response headers arrive. */
  arm(now: number): void {
    this.deadline = now + this.targetSeconds * 2000 + 3000;
  }

  /**
   * Offers a chunk. Returns the bytes to forward now — nothing while filling,
   * the whole accumulation on the release tick, the chunk itself thereafter.
   */
  push(audio: Buffer, bytesPerSecond: number, now: number): Buffer | null {
    if (this.complete) return audio;

    this.held.push(audio);
    this.bytes += audio.length;

    const enough =
      this.bytes >= this.targetSeconds * bytesPerSecond ||
      this.bytes >= MAX_PREROLL_BYTES ||
      now >= this.deadline;
    if (!enough) return null;

    this.complete = true;
    const lump = Buffer.concat(this.held);
    this.held = [];
    this.bytes = 0;
    return lump;
  }

  get isComplete(): boolean {
    return this.complete;
  }

  get heldBytes(): number {
    return this.bytes;
  }

  discard(): void {
    this.held = [];
    this.bytes = 0;
  }
}
