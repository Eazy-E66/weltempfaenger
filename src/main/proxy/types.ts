/**
 * Wire types for everything the proxy reports. Shared by the proxy, the IPC
 * layer, and the renderer engine — so they deliberately contain no Node or DOM
 * types and survive structured cloning across the contextBridge.
 */

/** Codec facts read out of the audio's own frame headers by the sniffer. */
export interface AudioFormat {
  codec: 'mp3' | 'mp2' | 'aac';
  sampleRate: number;
  channels: number;
  /**
   * The codec's own rate, kbps — never the delivery rate.
   *
   * MPEG frame headers state it outright. ADTS headers carry no bitrate field,
   * so for AAC it is measured from real frame lengths and sample counts over a
   * settled window, which is the same quantity arrived at by arithmetic instead
   * of by table lookup. Undefined until one of those is available.
   */
  frameBitrateKbps?: number;
  /** Display string, e.g. "MPEG-1 Layer III". */
  profile: string;
}

export interface ProxySessionInfo {
  sessionId: string;
  /** URL we were asked for. */
  url: string;
  /** URL we ended up on after redirects. */
  finalUrl: string;
  redirects: string[];
  statusCode: number;
  /** True when the server answered `ICY 200 OK` instead of an HTTP status line. */
  icyProtocol: boolean;
  contentType: string;
  icyName?: string;
  icyGenre?: string;
  icyDescription?: string;
  /** Claimed bitrate from `icy-br`. Advisory — compare against measured. */
  icyBitrate?: number;
  metaint?: number;
  supportsIcyMetadata: boolean;
  /**
   * Read out of the codec's own frame headers once enough audio has arrived —
   * the only honest source for sample rate, since the browser exposes none.
   */
  audioFormat?: AudioFormat;
}

export interface ProxyMetadata {
  sessionId: string;
  title: string;
  artist?: string;
  track?: string;
  receivedAt: number;
  /** Undecorated metadata block, kept for diagnostics. */
  raw: string;
}

export interface ProxySessionStats {
  sessionId: string;
  /** Audio bytes forwarded to the renderer, ICY metadata excluded. */
  bytesReceived: number;
  /** Raw bytes read from upstream, metadata and framing included. */
  bytesUpstream: number;
  /** Measured over a sliding window; undefined until the sample is meaningful. */
  measuredBitrateKbps?: number;
  connected: boolean;
  stalled: boolean;
  /** Seconds of audio the proxy holds back before forwarding (NARROW/WIDE). */
  prerollSeconds: number;
  /** Audio bytes currently held in the pre-roll buffer. */
  prerollHeldBytes: number;
  prerollComplete: boolean;
  /**
   * Audio written to the renderer but not yet consumed by it, in seconds. This
   * is where a WIDE buffer actually lives: Chromium caps HTMLMediaElement
   * .buffered at two or three seconds for a live MP3, so anything deeper has to
   * queue on this side of the socket.
   */
  pipelineSeconds: number;
  startedAt: number;
  firstByteAt?: number;
  info?: ProxySessionInfo;
  nowPlaying?: ProxyMetadata;
}

export type ProxyEventKind = 'open' | 'stall' | 'resume' | 'closed' | 'error';

export interface ProxyEvent {
  sessionId: string;
  kind: ProxyEventKind;
  /**
   * Present on 'closed'. True when *we* closed it (tune away, shutdown); false
   * when the upstream went away by itself — which for an endless live stream is
   * always a drop, however cleanly the socket was shut. AFC keys off this.
   */
  graceful?: boolean;
  /**
   * A sentence a listener may read. The engine turns a non-graceful close
   * straight into `PlaybackError.message`, so this may never carry a Node or
   * OpenSSL identifier — it is composed from the failure's kind at the source.
   */
  message?: string;
  /**
   * The transport's own words: `read ECONNRESET`, `getaddrinfo ENOTFOUND …`.
   *
   * Real, kept, and for diagnostics only. Split out of `message` because the
   * panel reads `message` and a faceplate printing an errno is an unhandled
   * failure state wearing a designed one's clothes (Law 4).
   */
  detail?: string;
  at: number;
}

export interface ProxyHandle {
  /** Loopback URL the <audio> element should load. Carries the session token. */
  url: string;
  sessionId: string;
  port: number;
  prerollSeconds: number;
}

export interface ProxySessionOptions {
  /** Seconds of audio to accumulate before the first byte reaches the renderer. */
  prerollSeconds?: number;
}
