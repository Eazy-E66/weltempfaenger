/**
 * One upstream connection, demuxed and forwarded to one renderer response.
 *
 * A session owns exactly one upstream socket and destroys it the moment the
 * renderer goes away. Users sweep the dial fast; abandoned sockets must not
 * outlive the request that created them.
 */

import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { Dechunker } from './dechunk.js';
import { RollingBitrate } from './bitrate.js';
import { IcyDemuxer, parseIcyHeaders, parseStreamTitle } from './icy.js';
import { openUpstream, UpstreamError, type UpstreamConnection } from './upstream.js';
import { FormatSniffer } from './sniff.js';
import { PrerollBuffer } from './preroll.js';
import type { ProxyMetadata, ProxySessionInfo, ProxySessionStats } from './types.js';

export interface SessionOptions {
  sessionId: string;
  url: string;
  allowPrivateHosts: boolean;
  /** No upstream bytes for this long while connected ⇒ stall. */
  stallTimeoutMs: number;
  maxRedirects: number;
  /**
   * Seconds of audio to accumulate before forwarding anything. This is the real
   * mechanism behind NARROW/WIDE: Chromium will not hold more than ~2-3 s of a
   * live MP3 in HTMLMediaElement.buffered no matter what we ask for, so a deeper
   * buffer has to be built here and pushed across as one lump.
   */
  prerollSeconds: number;
}

export interface SessionEvents {
  open: [ProxySessionInfo];
  metadata: [ProxyMetadata];
  stall: [];
  resume: [];
  /**
   * Terminal. `graceful` means *we* ended it (tune away, shutdown). A live
   * stream has no expected end, so any upstream-initiated close — clean FIN,
   * RST, or error alike — is a drop and reports graceful:false. That is exactly
   * the signal AFC needs.
   *
   * `reason` is a sentence a listener may read: the engine turns a non-graceful
   * close straight into `PlaybackError.message`, so `read ECONNRESET` here is
   * `read ECONNRESET` on a 1977 faceplate. `detail` carries the transport's own
   * words for a log or a diagnostic, and never reaches the panel.
   */
  close: [{ reason: string; graceful: boolean; detail?: string }];
}

/**
 * A failed upstream open, in words, composed from the failure's own kind.
 *
 * Never from `error.message`: an `UpstreamError` wrapping a socket error carries
 * `getaddrinfo ENOTFOUND …` or `connect ECONNREFUSED 127.0.0.1:18799`, and the
 * only thing standing between that text and the faceplate is this function.
 * The HTTP status is the one number that survives, because it is a fact about
 * the station rather than about this process.
 */
function upstreamReason(err: UpstreamError): string {
  switch (err.kind) {
    case 'http':
      return err.status
        ? `the station's server answered HTTP ${err.status}`
        : "the station's server refused the connection";
    case 'timeout':
      return 'the station did not answer in time';
    case 'too-many-redirects':
      return 'the station\'s address redirected in circles';
    case 'blocked':
      return 'that address is not one this receiver is allowed to open';
    case 'aborted':
      return 'the attempt was cancelled';
    case 'network':
    default:
      return 'the connection to the station could not be opened';
  }
}

export class StreamSession extends EventEmitter<SessionEvents> {
  readonly sessionId: string;
  readonly url: string;

  private readonly abort = new AbortController();
  private readonly bitrate = new RollingBitrate();
  private readonly sniffer = new FormatSniffer();
  private readonly preroll: PrerollBuffer;
  private upstream?: UpstreamConnection;
  private demuxer?: IcyDemuxer;
  private dechunker?: Dechunker;
  private stallTimer?: NodeJS.Timeout;
  private stalled = false;
  private closed = false;

  private bytesUpstream = 0;
  private bytesAudio = 0;
  private info?: ProxySessionInfo;
  private lastMetadata?: ProxyMetadata;
  private startedAt = Date.now();
  private firstByteAt?: number;
  private res?: ServerResponse;

  constructor(private readonly opts: SessionOptions) {
    super();
    this.sessionId = opts.sessionId;
    this.url = opts.url;
    this.preroll = new PrerollBuffer(opts.prerollSeconds);
  }

  stats(): ProxySessionStats {
    return {
      sessionId: this.sessionId,
      bytesReceived: this.bytesAudio,
      bytesUpstream: this.bytesUpstream,
      measuredBitrateKbps: this.bitrate.kbps(),
      connected: this.upstream !== undefined && !this.closed,
      stalled: this.stalled,
      prerollSeconds: this.opts.prerollSeconds,
      prerollHeldBytes: this.preroll.heldBytes,
      prerollComplete: this.preroll.isComplete,
      pipelineSeconds: this.pipelineSeconds(),
      startedAt: this.startedAt,
      firstByteAt: this.firstByteAt,
      info: this.info,
      nowPlaying: this.lastMetadata,
    };
  }

  /** Opens upstream and pumps until either side ends. Resolves when forwarding starts. */
  async run(res: ServerResponse): Promise<void> {
    this.res = res;
    res.on('close', () => this.destroy('renderer disconnected'));

    let up: UpstreamConnection;
    try {
      up = await openUpstream(this.url, {
        maxRedirects: this.opts.maxRedirects,
        allowPrivateHosts: this.opts.allowPrivateHosts,
        signal: this.abort.signal,
      });
    } catch (err) {
      const e = err as UpstreamError;
      if (!res.headersSent) {
        res.writeHead(e.kind === 'http' && e.status ? e.status : 502, {
          'content-type': 'text/plain; charset=utf-8',
          'access-control-allow-origin': '*',
        });
        res.end(`upstream error: ${e.message}`);
      }
      this.finish(upstreamReason(e), 'upstream', `upstream error: ${e.message}`);
      return;
    }

    if (this.closed) {
      up.socket.destroy();
      return;
    }

    this.upstream = up;
    this.startedAt = Date.now();
    this.preroll.arm(this.startedAt);

    const icy = parseIcyHeaders(up.headers);
    this.info = {
      sessionId: this.sessionId,
      url: up.url,
      finalUrl: up.redirects.at(-1) ?? up.url,
      redirects: up.redirects,
      statusCode: up.statusCode,
      icyProtocol: up.icyProtocol,
      contentType: icy.contentType ?? 'audio/mpeg',
      icyName: icy.name,
      icyGenre: icy.genre,
      icyDescription: icy.description,
      icyBitrate: icy.bitrate,
      metaint: icy.metaint,
      supportsIcyMetadata: icy.metaint !== undefined,
    };

    if (icy.metaint !== undefined) this.demuxer = new IcyDemuxer(icy.metaint);
    if ((up.headers['transfer-encoding'] ?? '').toLowerCase().includes('chunked')) {
      this.dechunker = new Dechunker();
    }

    // No content-length: this is an endless body, and the renderer's <audio>
    // must not think it can seek. ACAO is what keeps createMediaElementSource
    // from producing a tainted (silent) node.
    res.writeHead(200, {
      'content-type': this.info.contentType,
      'access-control-allow-origin': '*',
      'cache-control': 'no-store, no-cache, must-revalidate',
      'accept-ranges': 'none',
      connection: 'close',
      'x-psppcpr-session': this.sessionId,
    });
    this.emit('open', this.info);

    up.socket.on('data', (chunk: Buffer) => this.onUpstreamData(chunk, res));
    up.socket.on('error', (err) =>
      this.finish('the connection to the station dropped', 'upstream', `upstream socket error: ${err.message}`),
    );
    up.socket.on('end', () => this.finish('upstream ended the stream', 'upstream'));
    up.socket.on('close', () => this.finish('upstream socket closed', 'upstream'));

    if (up.leftover.length > 0) this.onUpstreamData(up.leftover, res);
    up.socket.resume();
    this.armStallTimer();
  }

  private onUpstreamData(chunk: Buffer, res: ServerResponse): void {
    if (this.closed) return;
    this.bytesUpstream += chunk.length;
    if (this.firstByteAt === undefined) this.firstByteAt = Date.now();

    let payload = chunk;
    if (this.dechunker) {
      try {
        payload = this.dechunker.push(chunk);
      } catch (err) {
        this.finish(
          'the station sent audio this receiver could not unpack',
          'upstream',
          (err as Error).message,
        );
        return;
      }
    }

    let audio = payload;
    if (this.demuxer) {
      const out = this.demuxer.push(payload);
      audio = out.audio;
      for (const block of out.blocks) this.onMetadataBlock(block);
    }

    if (audio.length > 0) {
      this.bytesAudio += audio.length;
      this.bitrate.add(audio.length);
      // Kept fed past the first answer: an ADTS stream's codec bitrate is only
      // knowable by measuring frames over a window, so the sniffer needs the
      // audio that arrives after the format itself is known.
      if (this.info && !this.sniffer.settled) {
        const fmt = this.sniffer.push(audio);
        if (fmt && fmt !== this.info.audioFormat) this.info = { ...this.info, audioFormat: fmt };
      }
      if (this.stalled) {
        this.stalled = false;
        this.emit('resume');
      }
      this.forward(audio, res);
    }

    this.armStallTimer();
  }

  /**
   * Once the pre-roll releases, the renderer's socket queue is where the extra
   * depth lives — back-pressure keeps it there instead of in an unbounded
   * main-process heap buffer.
   */
  private forward(audio: Buffer, res: ServerResponse): void {
    const out = this.preroll.push(audio, this.bytesPerSecond(), Date.now());
    if (out) this.write(out, res);
  }

  private write(audio: Buffer, res: ServerResponse): void {
    // Back-pressure: if the renderer cannot keep up, stop reading upstream
    // rather than buffering an unbounded live stream in main-process memory.
    if (!res.write(audio)) {
      this.upstream?.socket.pause();
      res.once('drain', () => {
        if (!this.closed) this.upstream?.socket.resume();
      });
    }
  }

  /** Bytes per second of audio, from the most trustworthy source available. */
  private bytesPerSecond(): number {
    const kbps =
      this.info?.audioFormat?.frameBitrateKbps ??
      this.bitrate.kbps() ??
      this.info?.icyBitrate ??
      128;
    return (kbps * 1000) / 8;
  }

  /** Audio handed to the renderer's socket but not yet drained by it. */
  private pipelineSeconds(): number {
    const queued = (this.res?.writableLength ?? 0) + this.preroll.heldBytes;
    return queued / this.bytesPerSecond();
  }

  private onMetadataBlock(block: string): void {
    const parsed = parseStreamTitle(block);
    if (!parsed) return;
    if (this.lastMetadata?.title === parsed.title) return;
    this.lastMetadata = {
      sessionId: this.sessionId,
      title: parsed.title,
      artist: parsed.artist,
      track: parsed.track,
      receivedAt: Date.now(),
      raw: block,
    };
    this.emit('metadata', this.lastMetadata);
  }

  private armStallTimer(): void {
    if (this.closed) return;
    clearTimeout(this.stallTimer);
    this.stallTimer = setTimeout(() => {
      if (this.closed || this.stalled) return;
      this.stalled = true;
      this.emit('stall');
      this.armStallTimer();
    }, this.opts.stallTimeoutMs);
  }

  /** Tear down immediately. Safe to call repeatedly and from any state. */
  destroy(reason = 'aborted'): void {
    this.finish(reason, 'local');
  }

  private finish(reason: string, initiator: 'local' | 'upstream', detail?: string): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.stallTimer);
    this.preroll.discard();
    this.abort.abort();
    const sock = this.upstream?.socket;
    if (sock) {
      sock.removeAllListeners('data');
      sock.destroy();
    }
    // End the renderer response so the <audio> element sees a real EOF instead
    // of hanging on a half-open socket.
    const res = this.res;
    if (res && !res.writableEnded) {
      try {
        res.end();
      } catch {
        res.destroy();
      }
    }
    this.emit(
      'close',
      detail === undefined
        ? { reason, graceful: initiator === 'local' }
        : { reason, graceful: initiator === 'local', detail },
    );
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
