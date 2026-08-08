/**
 * Codec sniffing from the audio bytes themselves.
 *
 * `icy-br` is a claim and Chromium exposes nothing about the decoder, so the
 * sample rate shown next to the station name would otherwise have to be invented.
 * Instead we read the first real MPEG or ADTS frame header off the wire. Two
 * consecutive frames must chain (the second frame's header must land exactly
 * where the first says it ends) before we believe it — a stray 0xFFE byte pair
 * inside compressed audio is common.
 */

import type { AudioFormat } from './types.js';

export type { AudioFormat };

const MPEG_BITRATES: Record<string, number[]> = {
  // [version][layer] -> table
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0], // MPEG1 L3
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0], // MPEG1 L2
  '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0], // MPEG2/2.5 L3
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
};
const MPEG_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG-1
  2: [22050, 24000, 16000], // MPEG-2
  0: [11025, 12000, 8000], // MPEG-2.5
};
const ADTS_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

interface Frame {
  length: number;
  format: AudioFormat;
}

function mpegFrame(b: Buffer, i: number): Frame | null {
  if (i + 4 > b.length) return null;
  if (b[i] !== 0xff || (b[i + 1]! & 0xe0) !== 0xe0) return null;
  const verBits = (b[i + 1]! >> 3) & 3;
  const layerBits = (b[i + 1]! >> 1) & 3;
  if (verBits === 1 || layerBits === 0) return null; // reserved
  const layer = 4 - layerBits; // bits 01=L3, 10=L2, 11=L1
  if (layer !== 3 && layer !== 2) return null;

  const brIdx = (b[i + 2]! >> 4) & 0xf;
  const srIdx = (b[i + 2]! >> 2) & 3;
  if (brIdx === 0 || brIdx === 15 || srIdx === 3) return null;

  const table = MPEG_BITRATES[`${verBits === 3 ? 1 : 2}-${layer}`];
  if (!table) return null;
  const kbps = table[brIdx]!;
  const sampleRate = MPEG_RATES[verBits]![srIdx]!;
  const padding = (b[i + 2]! >> 1) & 1;
  const mode = (b[i + 3]! >> 6) & 3;
  const samplesPerFrame = layer === 3 ? (verBits === 3 ? 1152 : 576) : 1152;
  const length = Math.floor((samplesPerFrame / 8) * kbps * 1000 / sampleRate) + padding;
  if (length < 8) return null;

  const versionName = verBits === 3 ? 'MPEG-1' : verBits === 2 ? 'MPEG-2' : 'MPEG-2.5';
  return {
    length,
    format: {
      codec: layer === 3 ? 'mp3' : 'mp2',
      sampleRate,
      channels: mode === 3 ? 1 : 2,
      frameBitrateKbps: kbps,
      profile: `${versionName} Layer ${'I'.repeat(layer)}`,
    },
  };
}

/** Samples one ADTS frame carries: 1024 per raw data block, 1..4 blocks. */
const AAC_SAMPLES_PER_BLOCK = 1024;

function adtsRawBlocks(b: Buffer, i: number): number {
  return (b[i + 6]! & 3) + 1;
}

function adtsFrame(b: Buffer, i: number): Frame | null {
  if (i + 7 > b.length) return null;
  if (b[i] !== 0xff || (b[i + 1]! & 0xf6) !== 0xf0) return null;
  const srIdx = (b[i + 2]! >> 2) & 0xf;
  if (srIdx >= ADTS_RATES.length) return null;
  const channels = ((b[i + 2]! & 1) << 2) | ((b[i + 3]! >> 6) & 3);
  const length = ((b[i + 3]! & 3) << 11) | (b[i + 4]! << 3) | ((b[i + 5]! >> 5) & 7);
  if (length < 7) return null;
  const profile = ((b[i + 2]! >> 6) & 3) + 1;
  return {
    length,
    format: {
      codec: 'aac',
      sampleRate: ADTS_RATES[srIdx]!,
      channels: channels === 0 ? 2 : channels,
      profile: `AAC profile ${profile}`,
    },
  };
}

/**
 * The codec bitrate of an ADTS stream, measured.
 *
 * An ADTS header has no bitrate field — unlike an MPEG frame header, which
 * indexes a table. But it does carry the exact byte length of its own frame and
 * the number of sample blocks in it, and that is the same information: bytes per
 * second of audio is bytes per frame over frame duration. Summed across a
 * settled window this is the codec's own rate to within rounding, and it is a
 * measurement rather than a claim, which is what the slot beside the codec name
 * is for.
 *
 * It has to be a window rather than a frame: AAC encoders vary frame length
 * constantly even at a nominal constant rate (the bit reservoir), so a single
 * frame reads anywhere from half to twice the real figure.
 */
export class AdtsBitrateMeter {
  private pending: Buffer = Buffer.alloc(0);
  private bytes = 0;
  private samples = 0;
  private seen = 0;
  private result?: number;

  constructor(
    private readonly sampleRate: number,
    /** Audio seconds to average over before answering. */
    private readonly windowSeconds = 2,
    /** Give up after this much audio without a settled window. */
    private readonly maxBytes = 4 * 1024 * 1024,
  ) {}

  /** Feed audio bytes. Returns the measured kbps once the window is full. */
  push(chunk: Buffer): number | undefined {
    if (this.result !== undefined || this.spent) return this.result;
    this.seen += chunk.length;
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);

    let i = 0;
    while (i + 7 <= this.pending.length) {
      const frame = adtsFrame(this.pending, i);
      if (!frame || frame.format.sampleRate !== this.sampleRate) {
        // Sync lost mid-stream (a torn chunk, or a byte pattern that only looked
        // like a header). Hunt forward rather than trusting the arithmetic.
        const next = this.pending.indexOf(0xff, i + 1);
        if (next < 0) {
          i = this.pending.length;
          break;
        }
        i = next;
        continue;
      }
      if (i + frame.length > this.pending.length) break; // frame not fully arrived
      this.bytes += frame.length;
      this.samples += AAC_SAMPLES_PER_BLOCK * adtsRawBlocks(this.pending, i);
      i += frame.length;
    }
    this.pending = this.pending.subarray(i);

    if (this.samples >= this.sampleRate * this.windowSeconds) {
      this.result = Math.round((this.bytes * 8 * this.sampleRate) / (this.samples * 1000));
      this.pending = Buffer.alloc(0);
    }
    return this.result;
  }

  /** True once the meter has answered or given up; either way, stop feeding it. */
  get spent(): boolean {
    return this.result !== undefined || this.seen > this.maxBytes;
  }
}

/** Returns the format once two consecutive frames agree, else null. */
export function sniffAudioFormat(buf: Buffer): AudioFormat | null {
  const limit = Math.min(buf.length, 64 * 1024);
  for (let i = 0; i + 8 < limit; i++) {
    if (buf[i] !== 0xff) continue;
    for (const parse of [mpegFrame, adtsFrame]) {
      const first = parse(buf, i);
      if (!first) continue;
      const next = parse(buf, i + first.length);
      if (next && next.format.sampleRate === first.format.sampleRate) return first.format;
    }
  }
  return null;
}

/**
 * Accumulates the head of the stream until a format can be established, then —
 * for ADTS, whose headers do not declare a rate — keeps counting frames until
 * the bitrate has settled.
 *
 * `settled` is what the caller watches: an MP3 is settled the instant its first
 * two frames chain, because the header states the rate; an AAC stream needs a
 * couple of seconds of audio first, which is the difference between the readout
 * resolving its bitrate slot and printing an em-dash forever.
 */
export class FormatSniffer {
  private head: Buffer[] = [];
  private size = 0;
  private result: AudioFormat | null = null;
  private done = false;
  private meter?: AdtsBitrateMeter;

  push(chunk: Buffer): AudioFormat | null {
    if (!this.done) {
      this.head.push(chunk);
      this.size += chunk.length;
      if (this.size < 4096) return null;
      this.result = sniffAudioFormat(Buffer.concat(this.head));
      if (this.result || this.size > 64 * 1024) {
        this.done = true;
        this.head = [];
        if (this.result && this.result.frameBitrateKbps === undefined && this.result.codec === 'aac') {
          this.meter = new AdtsBitrateMeter(this.result.sampleRate);
        }
      }
      return this.result;
    }

    const meter = this.meter;
    if (meter && this.result) {
      const kbps = meter.push(chunk);
      if (kbps !== undefined && kbps > 0) {
        this.result = { ...this.result, frameBitrateKbps: kbps };
      }
      if (meter.spent) this.meter = undefined;
    }
    return this.result;
  }

  get format(): AudioFormat | null {
    return this.result;
  }

  /** Nothing further can be learned from more bytes. */
  get settled(): boolean {
    return this.done && this.meter === undefined;
  }
}
