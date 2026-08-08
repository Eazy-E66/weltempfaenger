import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ResolveResult } from '../../src/shared/contracts';
import { HttpStreamResolver } from '../../src/main/resolver/streamResolver';
import {
  startFixtureServer,
  startIcyServer,
  type FixtureServer,
  type IcyServer,
} from '../helpers/fixtureServer';

let server: FixtureServer;
let icy: IcyServer;
const resolver = new HttpStreamResolver();

beforeAll(async () => {
  server = await startFixtureServer();
  icy = await startIcyServer();
});

afterAll(async () => {
  await server.close();
  await icy.close();
});

function streams(result: ResolveResult) {
  if (!result.ok) throw new Error(`expected success, got ${result.failure.kind}: ${result.failure.message}`);
  return result.streams;
}

function failure(result: ResolveResult) {
  if (result.ok) throw new Error(`expected failure, got ${result.streams.length} stream(s)`);
  return result.failure;
}

describe('direct stream URLs', () => {
  it('accepts an MP3 stream and reports its ICY metadata support', async () => {
    const [stream, ...rest] = streams(await resolver.resolve(`${server.base}/audio/mp3`));
    expect(rest).toHaveLength(0);
    expect(stream).toMatchObject({
      url: `${server.base}/audio/mp3`,
      contentType: 'audio/mpeg',
      supportsIcyMetadata: true,
      icyBitrate: 128,
      icyName: 'Fixture Stream',
      origin: 'direct',
    });
  });

  it('reports supportsIcyMetadata false when the server offers no icy-metaint', async () => {
    const [stream] = streams(await resolver.resolve(`${server.base}/audio/no-metadata`));
    expect(stream?.supportsIcyMetadata).toBe(false);
  });

  it('accepts an AAC stream', async () => {
    const [stream] = streams(await resolver.resolve(`${server.base}/audio/aac`));
    expect(stream?.contentType).toBe('audio/aac');
  });

  it('accepts an Ogg stream served as application/ogg', async () => {
    const [stream] = streams(await resolver.resolve(`${server.base}/audio/ogg`));
    expect(stream?.contentType).toBe('application/ogg');
  });

  it('accepts a stream whose server sent no content-type at all', async () => {
    const [stream] = streams(await resolver.resolve(`${server.base}/audio/no-content-type`));
    expect(stream?.url).toBe(`${server.base}/audio/no-content-type`);
  });

  it('accepts a stream mislabelled as text/html', async () => {
    const [stream] = streams(await resolver.resolve(`${server.base}/audio/lying-html`));
    expect(stream?.origin).toBe('direct');
  });

  it('accepts a live stream served as audio/x-mpegurl rather than parsing it as a playlist', async () => {
    const [stream] = streams(await resolver.resolve(`${server.base}/audio/x-mpegurl-stream`));
    expect(stream?.url).toBe(`${server.base}/audio/x-mpegurl-stream`);
    expect(stream?.origin).toBe('direct');
  });
});

describe('PLS playlists', () => {
  it('unwraps a single-entry playlist and marks the origin', async () => {
    const [stream] = streams(await resolver.resolve(`${server.base}/pl/valid.pls`));
    expect(stream).toMatchObject({ url: `${server.base}/audio/mp3`, origin: 'pls' });
  });

  it('returns every entry, in index order', async () => {
    const found = streams(await resolver.resolve(`${server.base}/pl/multi.pls`));
    expect(found.map((s) => s.url)).toEqual([
      `${server.base}/audio/mp3`,
      `${server.base}/audio/aac`,
      `${server.base}/audio/ogg`,
    ]);
    expect(found.every((s) => s.origin === 'pls')).toBe(true);
  });

  it('unwraps a playlist even when the server labelled it audio/mpeg', async () => {
    const [stream] = streams(await resolver.resolve(`${server.base}/pl-as-audio/valid.pls`));
    expect(stream?.url).toBe(`${server.base}/audio/mp3`);
  });

  it('unwraps a playlist delivered with chunked transfer-encoding', async () => {
    const found = streams(await resolver.resolve(`${server.base}/pl-chunked/multi.pls`));
    expect(found).toHaveLength(3);
  });

  it('reports an empty playlist as empty-playlist, not as a network problem', async () => {
    expect(failure(await resolver.resolve(`${server.base}/pl/empty.pls`))).toMatchObject({
      kind: 'empty-playlist',
    });
  });

  it('reports the underlying network error when a playlist points at a dead host', async () => {
    const f = failure(await resolver.resolve(`${server.base}/pl/dead-host.pls`));
    expect(f.kind).toBe('network');
  });
});

describe('M3U playlists', () => {
  it('unwraps an extended M3U in order', async () => {
    const found = streams(await resolver.resolve(`${server.base}/pl/extended.m3u`));
    expect(found.map((s) => s.url)).toEqual([`${server.base}/audio/mp3`, `${server.base}/audio/ogg`]);
    expect(found.every((s) => s.origin === 'm3u')).toBe(true);
  });

  it('unwraps a bare URL list', async () => {
    const found = streams(await resolver.resolve(`${server.base}/pl/plain.m3u`));
    expect(found).toHaveLength(2);
  });

  it('resolves relative entries against the playlist URL', async () => {
    const [stream] = streams(await resolver.resolve(`${server.base}/pl/relative.m3u`));
    expect(stream?.url).toBe(`${server.base}/audio/mp3`);
  });

  it('reports an M3U with no entries as empty-playlist', async () => {
    expect(failure(await resolver.resolve(`${server.base}/pl/empty.m3u`))).toMatchObject({
      kind: 'empty-playlist',
    });
  });
});

describe('HLS manifests', () => {
  it('refuses an HLS manifest instead of silently handing back media segments', async () => {
    const result = await resolver.resolve(`${server.base}/pl/hls.m3u8`);
    const f = failure(result);
    expect(f.kind).toBe('hls');
    expect(f.message).toMatch(/HLS/);
  });

  it('reports it as its own kind, not as the vaguer not-audio', async () => {
    // The distinction is load-bearing: "not audio" would send the user looking
    // for a dead station, when in fact the station is alive and the receiver is
    // the thing that cannot decode it.
    const f = failure(await resolver.resolve(`${server.base}/pl/hls.m3u8`));
    expect(f.kind).not.toBe('not-audio');
    expect(f).not.toHaveProperty('contentType');
  });

  it('never requests a media segment while doing so', async () => {
    server.requests.length = 0;
    await resolver.resolve(`${server.base}/pl/hls.m3u8`);
    // If HLS were mistaken for a plain M3U, the segments would resolve as real
    // AAC and the station would appear to work while producing nothing.
    expect(server.requests.filter((r) => r.startsWith('/hls/segment-'))).toEqual([]);
  });

  it('says plainly that Chromium cannot play it, so the UI can too', async () => {
    const f = failure(await resolver.resolve(`${server.base}/pl/hls.m3u8`));
    expect(f.message).toMatch(/not natively playable/i);
  });
});

describe('nested playlists', () => {
  it('follows a PLS that points at an M3U', async () => {
    const found = streams(await resolver.resolve(`${server.base}/pl/nested.pls`));
    expect(found.map((s) => s.url)).toEqual([`${server.base}/audio/mp3`, `${server.base}/audio/ogg`]);
  });

  it('records the innermost playlist as the origin', async () => {
    const [stream] = streams(await resolver.resolve(`${server.base}/pl/nested.pls`));
    expect(stream?.origin).toBe('m3u');
  });

  it('stops descending at the configured depth', async () => {
    const shallow = new HttpStreamResolver({ maxPlaylistDepth: 3 });
    const f = failure(await shallow.resolve(`${server.base}/pl/deep-1.pls`));
    expect(f.kind).toBe('not-audio');
    expect(f.message).toMatch(/nested more than 3 deep/);
  });

  it('reaches the stream when the depth allowance is enough', async () => {
    const deep = new HttpStreamResolver({ maxPlaylistDepth: 4 });
    const found = streams(await deep.resolve(`${server.base}/pl/deep-1.pls`));
    expect(found.map((s) => s.url)).toEqual([`${server.base}/audio/mp3`]);
  });
});

describe('redirects', () => {
  it('follows a chain to the stream and marks the origin as redirect', async () => {
    const [stream] = streams(await resolver.resolve(`${server.base}/redirect/3`));
    expect(stream).toMatchObject({ url: `${server.base}/audio/mp3`, origin: 'redirect' });
  });

  it('follows a relative Location header', async () => {
    const [stream] = streams(await resolver.resolve(`${server.base}/redirect-relative`));
    expect(stream?.url).toBe(`${server.base}/audio/mp3`);
  });

  it('gives up after the cap rather than following forever', async () => {
    const f = failure(await resolver.resolve(`${server.base}/redirect/9`));
    expect(f.kind).toBe('too-many-redirects');
    expect(f.message).toMatch(/More than 5 redirects/);
  });

  it('detects a two-hop loop immediately rather than burning the whole budget', async () => {
    const f = failure(await resolver.resolve(`${server.base}/redirect-loop/a`));
    expect(f.kind).toBe('too-many-redirects');
    expect(f.message).toMatch(/loop/i);
  });

  it('makes only the hops the loop needed before noticing', async () => {
    server.requests.length = 0;
    await resolver.resolve(`${server.base}/redirect-loop/a`);
    expect(server.requests).toEqual(['/redirect-loop/a', '/redirect-loop/b']);
  });

  it('keeps the playlist origin when a playlist entry itself redirects', async () => {
    const custom = new HttpStreamResolver();
    const [stream] = streams(await custom.resolve(`${server.base}/pl/valid.pls`));
    expect(stream?.origin).toBe('pls');
  });
});

describe('servers answering ICY 200 OK', () => {
  it('resolves a classic SHOUTcast response that Node cannot parse', async () => {
    const [stream] = streams(await resolver.resolve(`${icy.base}/crlf`));
    expect(stream).toMatchObject({
      contentType: 'audio/mpeg',
      supportsIcyMetadata: true,
      icyBitrate: 128,
      icyName: 'Fixture Shoutcast v1 Server',
      origin: 'direct',
    });
  });

  it('resolves an ICY response that uses bare LF line endings', async () => {
    const found = streams(await resolver.resolve(`${icy.base}/lf`));
    expect(found).toHaveLength(1);
  });
});

describe('failures each map onto their own kind', () => {
  it('reports a web page as not-audio, with the type that was served', async () => {
    const f = failure(await resolver.resolve(`${server.base}/html`));
    expect(f).toMatchObject({ kind: 'not-audio', contentType: 'text/html' });
  });

  it('reports an HTTP error status with the status attached', async () => {
    const f = failure(await resolver.resolve(`${server.base}/status/404`));
    expect(f).toMatchObject({ kind: 'http', status: 404 });
  });

  it('reports a server error status', async () => {
    expect(failure(await resolver.resolve(`${server.base}/status/503`))).toMatchObject({
      kind: 'http',
      status: 503,
    });
  });

  it('reports garbage bytes as not-audio rather than guessing', async () => {
    expect(failure(await resolver.resolve(`${server.base}/garbage`))).toMatchObject({
      kind: 'not-audio',
    });
  });

  it('reports a truncated response as not-audio', async () => {
    expect(failure(await resolver.resolve(`${server.base}/truncated`))).toMatchObject({
      kind: 'not-audio',
    });
  });

  it('reports a refused connection as network', async () => {
    expect(failure(await resolver.resolve('http://127.0.0.1:1/stream'))).toMatchObject({
      kind: 'network',
    });
  });

  it('reports a silent server as timeout', async () => {
    const impatient = new HttpStreamResolver({ timeoutMs: 250, overallTimeoutMs: 1000 });
    expect(failure(await impatient.resolve(`${server.base}/slow`))).toMatchObject({
      kind: 'timeout',
    });
  });

  it('reports an unplayable scheme as network with an explanation', async () => {
    const f = failure(await resolver.resolve('mms://example.invalid/stream'));
    expect(f.kind).toBe('network');
    expect(f.message).toMatch(/scheme/i);
  });

  it('reports a URL that is not a URL at all', async () => {
    expect(failure(await resolver.resolve('not a url'))).toMatchObject({ kind: 'network' });
  });

  it('never throws, whatever it is given', async () => {
    for (const input of ['', 'http://', 'javascript:alert(1)', 'file:///etc/passwd', 'http://127.0.0.1:1/']) {
      await expect(resolver.resolve(input)).resolves.toBeDefined();
    }
  });
});

describe('cancellation', () => {
  it('stops when the caller aborts', async () => {
    const controller = new AbortController();
    const pending = resolver.resolve(`${server.base}/slow`, { signal: controller.signal });
    controller.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
  });

  it('does nothing at all when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    server.requests.length = 0;
    const result = await resolver.resolve(`${server.base}/audio/mp3`, { signal: controller.signal });
    expect(result.ok).toBe(false);
    expect(server.requests).toEqual([]);
  });
});

describe('candidate ordering and limits', () => {
  it('returns candidates in playlist order, best first', async () => {
    const found = streams(await resolver.resolve(`${server.base}/pl/multi.pls`));
    expect(found[0]?.url).toBe(`${server.base}/audio/mp3`);
  });

  it('honours the candidate cap', async () => {
    const capped = new HttpStreamResolver({ maxCandidates: 2 });
    const found = streams(await capped.resolve(`${server.base}/pl/multi.pls`));
    expect(found).toHaveLength(2);
  });

  it('does not return the same stream URL twice', async () => {
    const found = streams(await resolver.resolve(`${server.base}/pl/multi.pls`));
    expect(new Set(found.map((s) => s.url)).size).toBe(found.length);
  });
});
