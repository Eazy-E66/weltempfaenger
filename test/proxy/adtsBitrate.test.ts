/**
 * The bitrate slot, for AAC.
 *
 * An MPEG frame header indexes a bitrate table, so an MP3 mount resolves its
 * readout on the first two frames that chain. An ADTS header has no such field,
 * so for every AAC/AAC+ mount in the directory the slot printed an em-dash
 * indefinitely — the readout told the user less than the reference photograph
 * did, while `measuredBitrateKbps` sat unused in state.
 *
 * It is derivable, though, and honestly: an ADTS header states the exact byte
 * length of its own frame and how many 1024-sample blocks are in it. Bytes per
 * second of audio is bytes per frame over frame duration, and over a settled
 * window that is the codec's own rate — a measurement, not `icy-br`'s claim and
 * emphatically not delivery throughput.
 */

import { describe, expect, it } from 'vitest';
import {
  AdtsBitrateMeter,
  FormatSniffer,
  sniffAudioFormat,
} from '../../src/main/proxy/sniff';

const SAMPLE_RATE_INDEX = 4; // 44100 Hz
const SAMPLE_RATE = 44100;
const SAMPLES_PER_FRAME = 1024;

/** One real ADTS frame: a 7-byte header stating its own length, then payload. */
function adtsFrame(frameLength: number, opts: { srIdx?: number; channels?: number } = {}): Buffer {
  const srIdx = opts.srIdx ?? SAMPLE_RATE_INDEX;
  const chanCfg = opts.channels ?? 2;
  const frame = Buffer.alloc(frameLength, 0x5a);
  frame[0] = 0xff;
  frame[1] = 0xf1; // MPEG-4, layer 0, no CRC
  frame[2] = (1 << 6) | (srIdx << 2) | ((chanCfg >> 2) & 1);
  frame[3] = ((chanCfg & 3) << 6) | ((frameLength >> 11) & 3);
  frame[4] = (frameLength >> 3) & 0xff;
  frame[5] = ((frameLength & 7) << 5) | 0x1f;
  frame[6] = 0xfc; // buffer fullness tail, 1 raw data block
  return frame;
}

/**
 * `seconds` of AAC at `kbps`, as an encoder really emits it: frame lengths
 * alternate around the nominal figure because of the bit reservoir, which is
 * exactly why a single frame cannot answer the question.
 */
function adtsStream(kbps: number, seconds: number): Buffer {
  const frames = Math.ceil((seconds * SAMPLE_RATE) / SAMPLES_PER_FRAME);
  const exact = (kbps * 1000 * SAMPLES_PER_FRAME) / (8 * SAMPLE_RATE);
  const out: Buffer[] = [];
  let carried = 0;
  for (let i = 0; i < frames; i++) {
    const wanted = exact + carried;
    const length = Math.max(8, Math.round(wanted));
    carried = wanted - length;
    out.push(adtsFrame(length));
  }
  return Buffer.concat(out);
}

/** An MPEG-1 Layer III frame, whose header states 128 kbps at 44.1 kHz. */
function mp3Frame(): Buffer {
  const frame = Buffer.alloc(417, 0x31);
  frame[0] = 0xff;
  frame[1] = 0xfb; // MPEG-1, Layer III, no CRC
  frame[2] = 0x90; // bitrate index 9 (128 kbps), sample rate index 0 (44.1 kHz)
  frame[3] = 0x00; // stereo
  return frame;
}

describe('reading an ADTS header', () => {
  it('recognises the format from two frames that chain', () => {
    const format = sniffAudioFormat(Buffer.concat([adtsFrame(371), adtsFrame(372)]));
    expect(format).toMatchObject({ codec: 'aac', sampleRate: SAMPLE_RATE, channels: 2 });
  });

  it('states no bitrate from the header alone, because the header has none', () => {
    const format = sniffAudioFormat(Buffer.concat([adtsFrame(371), adtsFrame(372)]));
    expect(format!.frameBitrateKbps).toBeUndefined();
  });
});

describe('measuring the codec rate over a settled window', () => {
  it.each([64, 96, 128, 192, 256])('recovers %i kbps to within a kbps', (kbps) => {
    const meter = new AdtsBitrateMeter(SAMPLE_RATE);
    const measured = meter.push(adtsStream(kbps, 3));
    expect(measured).toBeDefined();
    expect(Math.abs(measured! - kbps)).toBeLessThanOrEqual(1);
  });

  it('says nothing until the window is full', () => {
    const meter = new AdtsBitrateMeter(SAMPLE_RATE);
    expect(meter.push(adtsStream(128, 0.5))).toBeUndefined();
    expect(meter.spent).toBe(false);
    expect(meter.push(adtsStream(128, 2))).toBeDefined();
    expect(meter.spent).toBe(true);
  });

  it('reassembles frames split across chunk boundaries', () => {
    const stream = adtsStream(128, 3);
    const meter = new AdtsBitrateMeter(SAMPLE_RATE);
    let measured: number | undefined;
    for (let offset = 0; offset < stream.length; offset += 137) {
      measured = meter.push(stream.subarray(offset, offset + 137)) ?? measured;
    }
    expect(measured).toBeDefined();
    expect(Math.abs(measured! - 128)).toBeLessThanOrEqual(1);
  });

  it('re-syncs after a torn stretch instead of reporting nonsense', () => {
    const stream = Buffer.concat([
      adtsStream(128, 0.4),
      Buffer.alloc(700, 0x00), // a hole where a router dropped a segment
      adtsStream(128, 3),
    ]);
    const meter = new AdtsBitrateMeter(SAMPLE_RATE);
    const measured = meter.push(stream);
    expect(measured).toBeDefined();
    expect(Math.abs(measured! - 128)).toBeLessThanOrEqual(2);
  });

  it('gives up rather than growing without bound on a stream it cannot parse', () => {
    const meter = new AdtsBitrateMeter(SAMPLE_RATE, 2, 8192);
    expect(meter.push(Buffer.alloc(9000, 0x00))).toBeUndefined();
    expect(meter.spent).toBe(true);
  });
});

describe('the sniffer as the session drives it', () => {
  it('resolves an AAC bitrate within a few seconds of the first audio', () => {
    const sniffer = new FormatSniffer();
    // The head, which establishes the format.
    expect(sniffer.push(adtsStream(128, 0.5))?.codec).toBe('aac');
    expect(sniffer.format!.frameBitrateKbps).toBeUndefined();
    expect(sniffer.settled).toBe(false);

    // The window that measures it.
    sniffer.push(adtsStream(128, 2.5));
    expect(sniffer.format!.frameBitrateKbps).toBeCloseTo(128, 0);
    expect(sniffer.settled).toBe(true);
  });

  it('keeps the sample rate and channel count it read from the header', () => {
    const sniffer = new FormatSniffer();
    sniffer.push(adtsStream(96, 0.5));
    sniffer.push(adtsStream(96, 2.5));
    expect(sniffer.format).toMatchObject({
      codec: 'aac',
      sampleRate: SAMPLE_RATE,
      channels: 2,
      frameBitrateKbps: 96,
    });
  });

  it('is settled immediately for MP3, whose header states the rate outright', () => {
    const sniffer = new FormatSniffer();
    const audio = Buffer.concat(Array.from({ length: 20 }, () => mp3Frame()));
    const format = sniffer.push(audio);
    expect(format).toMatchObject({ codec: 'mp3', frameBitrateKbps: 128 });
    expect(sniffer.settled).toBe(true);
  });

  it('never reports delivery throughput in this slot: the figure is frame-derived', () => {
    // The same audio delivered in one burst and delivered slowly must produce
    // the identical number, which is what distinguishes a codec rate from a
    // delivery rate. Nothing here consults a clock.
    const burst = new FormatSniffer();
    burst.push(adtsStream(192, 0.5));
    burst.push(adtsStream(192, 3));

    const paced = new FormatSniffer();
    const stream = Buffer.concat([adtsStream(192, 0.5), adtsStream(192, 3)]);
    for (let offset = 0; offset < stream.length; offset += 1024) {
      paced.push(stream.subarray(offset, offset + 1024));
    }

    expect(paced.format!.frameBitrateKbps).toBe(burst.format!.frameBitrateKbps);
    expect(Math.abs(paced.format!.frameBitrateKbps! - 192)).toBeLessThanOrEqual(1);
  });
});
