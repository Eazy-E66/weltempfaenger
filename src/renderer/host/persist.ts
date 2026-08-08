/**
 * Writing state to disk without writing it on every frame.
 *
 * A knob drag emits a value per pointer sample. Persisting each one would put a
 * hundred synchronous file writes behind one gesture, so the writer coalesces:
 * the newest value wins, and it lands once the hand stops. The window closing
 * is the one case that cannot wait, so `flush()` exists and is wired to
 * `pagehide`.
 */

export class DebouncedWriter<T> {
  private timer: number | undefined;
  private pending: T | undefined;
  /** The drain loop currently running, so a second call joins it rather than racing it. */
  private draining: Promise<void> | undefined;
  /**
   * A flush has been asked for and has not finished draining.
   *
   * This is what separates "the hand stopped" from "the window is closing".
   * Between writes the debounce normally takes the pacing back — a value that
   * arrived mid-write goes onto a fresh `delayMs` timer, which is correct while
   * the page is alive and fatal once it is not: `pagehide` is the end of the
   * document, that timer never fires, and the newest settings or memory never
   * reach disk. While this is set the loop keeps going instead.
   */
  private flushing = false;

  constructor(
    private readonly write: (value: T) => Promise<void>,
    private readonly delayMs = 400,
  ) {}

  queue(value: T): void {
    this.pending = value;
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.run(), this.delayMs);
  }

  /**
   * Write everything that is waiting, now.
   *
   * The returned promise settles once nothing is pending, which is what makes
   * "did the last value land?" a question a test can ask. Callers on the
   * `pagehide` path cannot await it — nothing can, at that point — but the write
   * is issued synchronously from here either way, which is the part that matters.
   */
  flush(): Promise<void> {
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = undefined;
    this.flushing = true;
    return this.run();
  }

  private run(): Promise<void> {
    this.timer = undefined;
    this.draining ??= this.drain().finally(() => {
      this.draining = undefined;
    });
    return this.draining;
  }

  private async drain(): Promise<void> {
    while (this.pending !== undefined) {
      const value = this.pending;
      this.pending = undefined;
      try {
        await this.write(value);
      } catch {
        // Persistence is best-effort. A settings file that could not be written
        // must not take the receiver down mid-song; the next write will retry.
      }
      // A value that arrived while the write was in flight still has to land.
      // Outside a flush the debounce owns the pacing and it goes back on the
      // timer; inside one there is no later tick to be rescheduled onto, so the
      // loop simply goes round again.
      if (this.pending !== undefined && !this.flushing) {
        this.queue(this.pending);
        break;
      }
    }
    this.flushing = false;
  }
}
