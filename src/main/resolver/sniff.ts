/**
 * Working out what a response actually is, given that servers routinely lie.
 *
 * Three independent signals, in increasing order of trustworthiness:
 *   1. the URL extension        (a hint, nothing more)
 *   2. the Content-Type header  (often wrong, often absent)
 *   3. the first bytes of body  (the truth)
 *
 * `decideBodyKind` combines them with the body winning wherever it can speak.
 */

export type ContentClass =
  | 'audio'
  | 'pls'
  | 'm3u'
  | 'hls'
  | 'html'
  /** A type that is used for both playlists and live streams; must sniff. */
  | 'ambiguous'
  | 'unknown';

export type BodyKind = 'audio' | 'pls' | 'm3u' | 'hls' | 'html' | 'unknown';

/** Strip parameters and normalise: `Audio/MPEG; charset=utf-8` -> `audio/mpeg`. */
export function normaliseContentType(raw: string | undefined): string {
  if (!raw) return '';
  return raw.split(';')[0]!.trim().toLowerCase();
}

const AUDIO_TYPES = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/mpeg3',
  'audio/x-mpeg',
  'audio/x-mpeg-3',
  'audio/aac',
  'audio/aacp',
  'audio/x-aac',
  'audio/x-hx-aac-adts',
  'audio/ogg',
  'application/ogg',
  'audio/opus',
  'audio/vorbis',
  'audio/flac',
  'audio/x-flac',
  'audio/wav',
  'audio/x-wav',
  'audio/webm',
  'audio/mp4',
  'audio/x-m4a',
  'video/ogg',
]);

const PLS_TYPES = new Set(['audio/x-scpls', 'audio/scpls', 'application/pls+xml']);

const HLS_TYPES = new Set(['application/vnd.apple.mpegurl', 'vnd.apple.mpegurl']);

/**
 * `audio/x-mpegurl` is genuinely ambiguous in the wild: it is the registered
 * type for an M3U playlist, but a meaningful number of stations serve a live
 * MP3 stream under it. Neither answer is safe without looking at the body.
 */
const AMBIGUOUS_TYPES = new Set([
  'audio/x-mpegurl',
  'audio/mpegurl',
  'application/x-mpegurl',
  'application/mpegurl',
]);

const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml', 'application/xml', 'text/xml']);

export function classifyContentType(raw: string | undefined): ContentClass {
  const ct = normaliseContentType(raw);
  if (!ct) return 'unknown';
  if (AUDIO_TYPES.has(ct)) return 'audio';
  if (PLS_TYPES.has(ct)) return 'pls';
  if (HLS_TYPES.has(ct)) return 'hls';
  if (AMBIGUOUS_TYPES.has(ct)) return 'ambiguous';
  if (HTML_TYPES.has(ct)) return 'html';
  if (ct.startsWith('audio/')) return 'audio';
  return 'unknown';
}

/** Extension hint from the path only — query strings are ignored. */
export function classifyUrlExtension(url: string): ContentClass {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    /* fall back to raw string matching */
  }
  const lower = path.toLowerCase();
  if (lower.endsWith('.pls')) return 'pls';
  if (lower.endsWith('.m3u8')) return 'hls';
  if (lower.endsWith('.m3u')) return 'm3u';
  if (/\.(mp3|aac|aacp|ogg|oga|opus|flac|wav|mp4|m4a)$/.test(lower)) return 'audio';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Byte-level sniffing
// ---------------------------------------------------------------------------

/** MPEG-1/2 Layer I-III frame sync: 11 set bits, and not the reserved layer/version. */
function isMpegFrameSync(b: Buffer, i: number): boolean {
  if (i + 1 >= b.length) return false;
  if (b[i] !== 0xff) return false;
  const b1 = b[i + 1]!;
  if ((b1 & 0xe0) !== 0xe0) return false;
  const version = (b1 >> 3) & 0x03;
  const layer = (b1 >> 1) & 0x03;
  if (version === 0x01) return false; // reserved MPEG version
  if (layer === 0x00) return false; // reserved layer
  return true;
}

/** ADTS AAC syncword: 0xFFF, layer bits must be 00. */
function isAdtsSync(b: Buffer, i: number): boolean {
  if (i + 1 >= b.length) return false;
  if (b[i] !== 0xff) return false;
  const b1 = b[i + 1]!;
  return (b1 & 0xf6) === 0xf0;
}

function startsWith(b: Buffer, ascii: string): boolean {
  if (b.length < ascii.length) return false;
  for (let i = 0; i < ascii.length; i++) {
    if (b[i] !== ascii.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * True when the first bytes look like a compressed audio bitstream.
 *
 * We only accept a sync word at or very near the start. Scanning deep into the
 * buffer would happily "find" 0xFFE. in any binary blob, and a false positive
 * here means the engine hands the user silence and calls it playing.
 */
export function looksLikeAudio(bytes: Buffer): boolean {
  if (bytes.length < 2) return false;
  if (startsWith(bytes, 'ID3')) return true; // MP3 with an ID3v2 tag
  if (startsWith(bytes, 'OggS')) return true;
  if (startsWith(bytes, 'fLaC')) return true;
  if (startsWith(bytes, 'ADIF')) return true;
  if (startsWith(bytes, 'RIFF') && bytes.length >= 12 && bytes.subarray(8, 12).toString('latin1') === 'WAVE') {
    return true;
  }
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString('latin1') === 'ftyp') return true; // MP4/M4A
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return true; // EBML — WebM/Matroska audio
  }
  // A leading sync word, allowing a couple of stray bytes of padding.
  for (let i = 0; i < Math.min(4, bytes.length - 1); i++) {
    if (isMpegFrameSync(bytes, i) || isAdtsSync(bytes, i)) return true;
  }
  return false;
}

/** Some proxies hand the raw SHOUTcast greeting back as a body. */
export function looksLikeIcyGreeting(bytes: Buffer): boolean {
  return /^ICY[ \t]+\d{3}/.test(bytes.subarray(0, 16).toString('latin1'));
}

const HLS_TAG = /^#EXT-X-[A-Z0-9-]+/m;

/** An `#EXTM3U` that carries `#EXT-X-*` tags is an HLS manifest, not a station list. */
export function isHlsManifest(text: string): boolean {
  const t = stripBom(text);
  if (!/^\s*#EXTM3U/.test(t)) return false;
  return HLS_TAG.test(t);
}

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function looksLikePls(text: string): boolean {
  if (/\[playlist\]/i.test(text)) return true;
  if (/^\s*File\d+\s*=/im.test(text)) return true;
  if (/^\s*NumberOfEntries\s*=/im.test(text)) return true;
  return false;
}

function looksLikeM3u(text: string): boolean {
  if (/^\s*#EXTM3U/.test(text)) return true;
  // A bare list of URLs, one per line, is a valid (very common) M3U.
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return false;
  const meaningful = lines.filter((l) => !l.startsWith('#'));
  if (meaningful.length === 0) return false;
  return meaningful.every((l) => /^[a-z][a-z0-9+.-]*:\/\//i.test(l));
}

function looksLikeHtml(text: string): boolean {
  const head = text.slice(0, 512).toLowerCase().trimStart();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<?xml') || head.startsWith('<head');
}

/** Reject buffers with control bytes that no text format would contain. */
function looksTextual(bytes: Buffer): boolean {
  const probe = bytes.subarray(0, Math.min(bytes.length, 1024));
  if (probe.length === 0) return false;
  let control = 0;
  for (const byte of probe) {
    if (byte === 0) return false;
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) control++;
  }
  return control / probe.length < 0.05;
}

/** What the bytes themselves claim to be, ignoring all headers. */
export function sniffBody(bytes: Buffer): BodyKind {
  if (bytes.length === 0) return 'unknown';
  if (looksLikeAudio(bytes)) return 'audio';
  if (looksLikeIcyGreeting(bytes)) return 'audio';
  if (!looksTextual(bytes)) return 'unknown';

  const text = stripBom(bytes.subarray(0, Math.min(bytes.length, 64 * 1024)).toString('utf8'));
  if (isHlsManifest(text)) return 'hls';
  if (looksLikePls(text)) return 'pls';
  if (looksLikeHtml(text)) return 'html';
  if (looksLikeM3u(text)) return 'm3u';
  return 'unknown';
}

/**
 * Final verdict for a response.
 *
 * Precedence, and the reasoning behind it:
 *   1. body says playlist  -> playlist. A playlist body is unmistakable and no
 *      header can override an actual `[playlist]` section.
 *   2. body says HTML      -> not audio, whatever the header claims. Stations
 *      that have gone away love to return a parking page as `audio/mpeg`.
 *   3. body says audio     -> audio, even under `text/html` (servers lie).
 *   4. header says audio   -> audio. Codecs we cannot sniff still deserve a try.
 *   5. header says html    -> not audio.
 *   6. otherwise           -> unknown; the caller treats that as not-audio.
 *
 * The URL extension only breaks ties when nothing else spoke.
 */
export function decideBodyKind(args: {
  contentType?: string;
  url: string;
  bytes: Buffer;
}): BodyKind {
  const byHeader = classifyContentType(args.contentType);
  const byBody = sniffBody(args.bytes);

  if (byBody === 'pls' || byBody === 'm3u' || byBody === 'hls') {
    // An `.m3u8` URL serving a plain URL list is still HLS-shaped often enough
    // that we let the manifest tags decide, which `sniffBody` already did.
    return byBody;
  }
  if (byBody === 'html') return 'html';
  if (byBody === 'audio') return 'audio';
  if (byHeader === 'audio') return 'audio';
  if (byHeader === 'html') return 'html';
  if (byHeader === 'pls') return 'pls';
  if (byHeader === 'hls') return 'hls';

  const byExt = classifyUrlExtension(args.url);
  if (byHeader === 'ambiguous') {
    // Body was silent (empty or unreadable). Trust the extension, else assume
    // the playlist reading of the type, which is what it is registered as.
    if (byExt === 'audio') return 'audio';
    return 'm3u';
  }
  if (byExt === 'audio') return 'audio';
  if (byExt === 'pls' || byExt === 'm3u' || byExt === 'hls') return byExt;
  return 'unknown';
}
