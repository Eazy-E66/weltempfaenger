/**
 * ICY (Icecast/SHOUTcast) metadata handling. Pure functions and one stateful
 * demuxer — no sockets, no Electron, no DOM. This is the byte-exact core of the
 * proxy, so it is kept isolated and independently testable.
 */

export interface IcyHeaderInfo {
  /** Bytes of audio between metadata blocks. Absent when the server sends no metadata. */
  metaint?: number;
  /** Bitrate the server *claims*, kbps. Advisory only. */
  bitrate?: number;
  name?: string;
  genre?: string;
  description?: string;
  url?: string;
  contentType?: string;
}

export interface ParsedStreamTitle {
  /** The display line: `Artist - Track` where both are known. */
  title: string;
  artist?: string;
  track?: string;
}

/** Case-insensitive header bag as produced by the upstream client. */
export type HeaderBag = Record<string, string>;

export function parseIcyHeaders(headers: HeaderBag): IcyHeaderInfo {
  const get = (k: string): string | undefined => {
    const v = headers[k.toLowerCase()];
    return v === undefined || v === '' ? undefined : v;
  };

  const metaintRaw = get('icy-metaint');
  const metaint = metaintRaw !== undefined ? Number.parseInt(metaintRaw, 10) : NaN;

  const brRaw = get('icy-br') ?? get('ice-bitrate') ?? get('x-audiocast-bitrate');
  // Some servers send "128" and some send "128,128" for multi-stream mounts.
  const br = brRaw !== undefined ? Number.parseInt(brRaw.split(',')[0]!, 10) : NaN;

  return {
    metaint: Number.isFinite(metaint) && metaint > 0 ? metaint : undefined,
    bitrate: Number.isFinite(br) && br > 0 ? br : undefined,
    name: get('icy-name') ?? get('ice-name'),
    genre: get('icy-genre') ?? get('ice-genre'),
    description: get('icy-description') ?? get('ice-description'),
    url: get('icy-url') ?? get('ice-url'),
    contentType: get('content-type'),
  };
}

/**
 * Decode a metadata block. ICY predates any encoding agreement: most servers
 * emit UTF-8, older ones Latin-1. Decode as UTF-8 and fall back when the result
 * contains replacement characters.
 */
export function decodeMetadataBlock(raw: Buffer): string {
  const utf8 = raw.toString('utf8');
  const text = utf8.includes('�') ? raw.toString('latin1') : utf8;
  // Blocks are NUL-padded up to the 16-byte quantum.
  return text.replace(/\0+$/, '').trim();
}

/**
 * Pull StreamTitle out of a metadata block. The value is single-quoted and
 * terminated by `';` — a plain `'([^']*)'` regex would truncate any title
 * containing an apostrophe, which is extremely common ("Rockin' Chair").
 */
export function parseStreamTitle(block: string): ParsedStreamTitle | null {
  const key = "StreamTitle='";
  const start = block.indexOf(key);
  if (start < 0) return null;
  const valueStart = start + key.length;

  let end = block.indexOf("';", valueStart);
  if (end < 0) {
    // Last field of the block may omit the trailing semicolon, and plenty of
    // servers do. `lastIndexOf("'")` was the wrong way to find the close: for
    // `StreamTitle='Rockin' Chair` it lands on the apostrophe *inside* the title
    // and yields `Rockin` — precisely the truncation the `';` terminator exists
    // to avoid, reintroduced on the one path that cannot use it.
    //
    // Without a terminator there is only one thing the closing quote can be: the
    // last character of the block. Anything else is a quote in the title.
    const tail = block.replace(/[\s\0]+$/, '');
    end = tail.length - 1 > valueStart && tail.endsWith("'") ? tail.length - 1 : tail.length;
  }

  return parseTitleValue(block.slice(valueStart, end));
}

/** `key="value"` anywhere in the string. Keys are ASCII identifiers in practice. */
const KEYED_FIELD = /([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*"([^"]*)"/g;
/** Keys carrying the track, best first. */
const TRACK_KEYS = ['title', 'song', 'track'];
/** Keys carrying the performer. */
const ARTIST_KEYS = ['artist', 'performer'];
/** Keys carrying an already-formatted line rather than a field. */
const TEXT_KEYS = ['text'];

/**
 * Turn a raw `StreamTitle` value into something a listener would recognise.
 *
 * The now-playing line is the largest text on the panel, and on a large slice of
 * the US directory — every iHeart and Triton mount — what arrives in this field
 * is not a song title but a scheduling record:
 *
 *   title="Sober",artist="Tool",url="song_spot="F" MediaBaseId="0" TAID="0" …"
 *
 * Printed verbatim that is a wall of `amgArtistId` / `TPID` / `cartcutId`, which
 * is what two critics reproduced on the default first station. So three forms
 * are handled, in order of how much they tell us:
 *
 *   1. keyed  — `title="…",artist="…"` and friends, the fields are read out;
 *   2. plain  — `Artist - Track`, the format most of the world sends;
 *   3. neither — kept verbatim, but with any trailing `key="value"` run cut off,
 *      because that shape also turns up appended to an otherwise good title.
 *
 * The undecorated block always survives on `ProxyMetadata.raw`, so nothing is
 * lost — it is moved to where diagnostics live rather than the panel.
 */
export function parseTitleValue(value: string): ParsedStreamTitle | null {
  const raw = value.trim();
  if (raw === '') return null;

  const fields = readKeyedFields(raw);
  const keyed = fromFields(fields);
  if (keyed) return keyed;

  const plain = stripKeyedFields(raw);
  if (plain === '') return null;
  return splitArtistTrack(plain);
}

/** Every `key="value"` pair in the string, first occurrence of each key wins. */
function readKeyedFields(text: string): Map<string, string> {
  const out = new Map<string, string>();
  KEYED_FIELD.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = KEYED_FIELD.exec(text)) !== null) {
    const key = match[1]!.toLowerCase();
    if (!out.has(key)) out.set(key, match[2]!.trim());
  }
  return out;
}

/** Build a result from keyed fields, or null when none of them carry a title. */
function fromFields(fields: Map<string, string>): ParsedStreamTitle | null {
  if (fields.size === 0) return null;

  const track = firstOf(fields, TRACK_KEYS);
  const artist = firstOf(fields, ARTIST_KEYS);
  if (track) {
    // `title="Artist - Track"` happens too, and an explicit artist field wins
    // over guessing from a dash.
    if (!artist) return splitArtistTrack(track);
    return { title: `${artist} - ${track}`, artist, track };
  }

  // Triton's other shape: one preformatted line under `text`.
  const text = firstOf(fields, TEXT_KEYS);
  if (text) return splitArtistTrack(text);
  return null;
}

function firstOf(fields: Map<string, string>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = fields.get(key);
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

/**
 * Cut a trailing run of `key="value"` records off an otherwise plain title.
 * Only from the end: a song genuinely called `Say "Yes"` keeps its quotes.
 */
function stripKeyedFields(text: string): string {
  const trimmed = text.replace(
    /(?:[,;\s]*[A-Za-z_][A-Za-z0-9_.-]*\s*=\s*"[^"]*")+\s*$/,
    '',
  );
  return trimmed.replace(/[,;\s]+$/, '').trim();
}

/** The `Artist - Track` convention, which is what most of the world sends. */
function splitArtistTrack(text: string): ParsedStreamTitle {
  const title = text.trim();
  const out: ParsedStreamTitle = { title };
  const sep = title.indexOf(' - ');
  if (sep > 0 && sep < title.length - 3) {
    out.artist = title.slice(0, sep).trim();
    out.track = title.slice(sep + 3).trim();
  }
  return out;
}

/**
 * Splits an ICY body into pure audio and metadata blocks.
 *
 * Wire format: `metaint` audio bytes, then one length byte L, then L*16 bytes of
 * metadata (L may be 0, meaning "unchanged"), repeating forever. Chunk
 * boundaries fall anywhere — including between the length byte and its block —
 * so all position state lives on the instance, not in the loop.
 */
export class IcyDemuxer {
  private mode: 'audio' | 'length' | 'meta' = 'audio';
  private audioRemaining: number;
  private metaRemaining = 0;
  private metaParts: Buffer[] = [];

  constructor(private readonly metaint: number) {
    if (!Number.isInteger(metaint) || metaint <= 0) {
      throw new RangeError(`metaint must be a positive integer, got ${metaint}`);
    }
    this.audioRemaining = metaint;
  }

  /**
   * Consume one upstream chunk. Returns the audio bytes it contained (possibly
   * empty) and every metadata block that completed inside it.
   */
  push(chunk: Buffer): { audio: Buffer; blocks: string[] } {
    const audioParts: Buffer[] = [];
    const blocks: string[] = [];
    let i = 0;

    while (i < chunk.length) {
      if (this.mode === 'audio') {
        const take = Math.min(this.audioRemaining, chunk.length - i);
        audioParts.push(chunk.subarray(i, i + take));
        i += take;
        this.audioRemaining -= take;
        if (this.audioRemaining === 0) this.mode = 'length';
        continue;
      }

      if (this.mode === 'length') {
        this.metaRemaining = chunk[i]! * 16;
        i += 1;
        if (this.metaRemaining === 0) {
          this.beginAudio();
        } else {
          this.mode = 'meta';
          this.metaParts = [];
        }
        continue;
      }

      const take = Math.min(this.metaRemaining, chunk.length - i);
      this.metaParts.push(chunk.subarray(i, i + take));
      i += take;
      this.metaRemaining -= take;
      if (this.metaRemaining === 0) {
        blocks.push(decodeMetadataBlock(Buffer.concat(this.metaParts)));
        this.metaParts = [];
        this.beginAudio();
      }
    }

    return {
      audio: audioParts.length === 1 ? audioParts[0]! : Buffer.concat(audioParts),
      blocks,
    };
  }

  private beginAudio(): void {
    this.mode = 'audio';
    this.audioRemaining = this.metaint;
  }
}

/** Builds an ICY body from audio bytes and a metadata schedule. Used by tests. */
export function encodeIcyStream(
  audio: Buffer,
  metaint: number,
  blockAt: (index: number) => string | null,
): Buffer {
  const out: Buffer[] = [];
  let offset = 0;
  let index = 0;
  while (offset < audio.length) {
    const slice = audio.subarray(offset, offset + metaint);
    out.push(slice);
    offset += slice.length;
    if (slice.length < metaint) break; // trailing partial segment carries no marker
    const block = blockAt(index++);
    if (block === null) {
      out.push(Buffer.from([0]));
    } else {
      const bytes = Buffer.from(block, 'utf8');
      const padded = Buffer.alloc(Math.ceil(bytes.length / 16) * 16);
      bytes.copy(padded);
      out.push(Buffer.from([padded.length / 16]), padded);
    }
  }
  return Buffer.concat(out);
}
