/**
 * LIVE — opens sockets to real radio stations. Not part of `npm test`.
 * See test/live/README.md.
 */

import { describe, expect, it } from 'vitest';
import { HttpStreamResolver } from '../../src/main/resolver/streamResolver';
import { RadioBrowserProvider } from '../../src/main/directory/radioBrowser';

/** Confirmed working when this suite was written. */
const SOMA_DIRECT = 'https://ice1.somafm.com/groovesalad-128-mp3';
const SOMA_PLS = 'https://somafm.com/groovesalad.pls';

const resolver = new HttpStreamResolver({ timeoutMs: 15_000, overallTimeoutMs: 40_000 });

describe('LIVE: resolving a known-good direct stream', () => {
  it('resolves SomaFM Groove Salad to a playable MP3 stream', async () => {
    const result = await resolver.resolve(SOMA_DIRECT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [stream] = result.streams;
    expect(stream?.url).toBeTruthy();
    expect(stream?.contentType).toMatch(/audio\/(mpeg|mp3)/);
  });

  it('reports ICY metadata support for a station that offers it', async () => {
    const result = await resolver.resolve(SOMA_DIRECT);
    if (!result.ok) throw new Error(`resolve failed: ${result.failure.kind}`);
    expect(result.streams[0]?.supportsIcyMetadata).toBe(true);
  });

  it('picks up the advertised bitrate from ICY headers', async () => {
    const result = await resolver.resolve(SOMA_DIRECT);
    if (!result.ok) throw new Error(`resolve failed: ${result.failure.kind}`);
    expect(result.streams[0]?.icyBitrate).toBeGreaterThan(0);
  });
});

describe('LIVE: resolving a real PLS playlist', () => {
  it('unwraps SomaFM\'s published .pls into playable streams', async () => {
    const result = await resolver.resolve(SOMA_PLS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.streams.length).toBeGreaterThan(0);
    expect(result.streams.every((s) => s.origin === 'pls' || s.origin === 'm3u')).toBe(true);
  });
});

describe('LIVE: real failures still map onto real failure kinds', () => {
  it('reports a host that does not exist as a network failure', async () => {
    const result = await resolver.resolve('http://this-host-does-not-exist.invalid/stream');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('network');
  });

  it('reports an ordinary web page as not-audio', async () => {
    const result = await resolver.resolve('https://example.com/');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('not-audio');
  });
});

describe('LIVE: directory and resolver together', () => {
  it('takes real popular stations from the directory and resolves at least one', async () => {
    const directory = new RadioBrowserProvider({
      mirrors: ['https://de1.api.radio-browser.info'],
      timeoutMs: 20_000,
    });
    const stations = await directory.search({ genre: 'jazz', limit: 8 });
    expect(stations.length).toBeGreaterThan(0);

    const outcomes = await Promise.all(
      stations.map(async (station) => (await resolver.resolve(station.url)).ok),
    );
    // Individual stations are allowed to be down; the pipeline is not.
    expect(outcomes.some(Boolean)).toBe(true);
  });
});
