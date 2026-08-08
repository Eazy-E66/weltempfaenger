/**
 * Minimal JSON-over-HTTP helper for directory providers. Node 20 has global
 * `fetch`, so there is nothing to install; all this adds is a hard timeout and
 * a typed error, because a directory that hangs must not hang the receiver.
 */

/** Every directory failure the app can see arrives as one of these. */
export type DirectoryErrorKind = 'network' | 'timeout' | 'http' | 'malformed' | 'no-mirror';

export class DirectoryError extends Error {
  readonly kind: DirectoryErrorKind;
  readonly status?: number;

  constructor(kind: DirectoryErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'DirectoryError';
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface JsonGetOptions {
  timeoutMs: number;
  userAgent: string;
  fetchImpl: FetchLike;
  signal?: AbortSignal | undefined;
}

/**
 * GET a URL and parse it as JSON. Times out on its own clock rather than
 * trusting the platform's, and never leaks an `AbortError` to the caller.
 */
export async function getJson<T>(url: string, opts: JsonGetOptions): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  const onOuterAbort = (): void => controller.abort();
  opts.signal?.addEventListener('abort', onOuterAbort, { once: true });

  try {
    const response = await opts.fetchImpl(url, {
      method: 'GET',
      headers: {
        // Radio Browser's API etiquette asks every client to identify itself so
        // they can contact operators of misbehaving software. Anonymous
        // requests are, by their own docs, liable to be blocked.
        'User-Agent': opts.userAgent,
        Accept: 'application/json',
      },
      signal: controller.signal,
      redirect: 'follow',
    });

    if (!response.ok) {
      throw new DirectoryError(
        'http',
        `${url} returned ${response.status} ${response.statusText}`,
        response.status,
      );
    }
    const text = await response.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new DirectoryError('malformed', `${url} did not return JSON`);
    }
  } catch (err) {
    if (err instanceof DirectoryError) throw err;
    if (opts.signal?.aborted) throw new DirectoryError('network', 'Request cancelled');
    if (err instanceof Error && err.name === 'AbortError') {
      throw new DirectoryError('timeout', `${url} did not answer within ${opts.timeoutMs}ms`);
    }
    throw new DirectoryError('network', err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onOuterAbort);
  }
}
