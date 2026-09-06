/**
 * AFC — automatic re-lock after an upstream drop.
 *
 * Exponential backoff, capped, with a bounded number of attempts before the
 * engine gives up into 'error'. The attempt counter resets only after playback
 * has been genuinely stable for a while, so a mount that drops every 20 seconds
 * still exhausts its attempts instead of retrying forever.
 */

export const AFC_BASE_MS = 500;
export const AFC_CAP_MS = 15_000;
export const AFC_MAX_ATTEMPTS = 6;
/** Continuous 'playing' time after which the stream counts as re-locked. */
export const AFC_STABLE_MS = 10_000;

export class Afc {
  private attempt = 0;

  constructor(
    private readonly maxAttempts = AFC_MAX_ATTEMPTS,
    private readonly baseMs = AFC_BASE_MS,
    private readonly capMs = AFC_CAP_MS,
  ) {}

  get attempts(): number {
    return this.attempt;
  }

  /** How many attempts this instance allows before it is exhausted. */
  get budget(): number {
    return this.maxAttempts;
  }

  get exhausted(): boolean {
    return this.attempt >= this.maxAttempts;
  }

  /** Delay before the next attempt, and consumes one attempt. */
  nextDelayMs(): number {
    const delay = Math.min(this.capMs, this.baseMs * 2 ** this.attempt);
    this.attempt += 1;
    return delay;
  }

  reset(): void {
    this.attempt = 0;
  }
}
