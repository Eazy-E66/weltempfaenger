import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  classifyContentType,
  classifyUrlExtension,
  decideBodyKind,
  isHlsManifest,
  looksLikeAudio,
  normaliseContentType,
  sniffBody,
} from '../../src/main/resolver/sniff';
import { aacBytes, fixturePath, mp3Bytes, oggBytes } from '../helpers/fixtureServer';

/**
 * Playlist fixtures carry a `{{BASE}}` placeholder where the test server's
 * ephemeral base URL goes. Sniffing has to see the substituted form, because
 * "is every line a URL?" is exactly the question being asked.
 */
async function fixture(...parts: string[]): Promise<Buffer> {
  const raw = await readFile(fixturePath(...parts));
  if (!raw.includes('{{BASE}}')) return raw;
  return Buffer.from(raw.toString('utf8').split('{{BASE}}').join('http://radio.test'), 'utf8');
}

describe('content-type normalisation', () => {
  it('strips parameters and lowercases', () => {
    expect(normaliseContentType('Audio/MPEG; charset=UTF-8')).toBe('audio/mpeg');
  });

  it('treats an absent header as empty rather than throwing', () => {
    expect(normaliseContentType(undefined)).toBe('');
  });
});

describe('classifying by content-type', () => {
  it('recognises the common stream types', () => {
    for (const ct of ['audio/mpeg', 'audio/aacp', 'application/ogg', 'audio/flac']) {
      expect(classifyContentType(ct)).toBe('audio');
    }
  });

  it('recognises PLS and Apple HLS types', () => {
    expect(classifyContentType('audio/x-scpls')).toBe('pls');
    expect(classifyContentType('application/vnd.apple.mpegurl')).toBe('hls');
  });

  it('refuses to commit on audio/x-mpegurl, which is used for both playlists and streams', () => {
    expect(classifyContentType('audio/x-mpegurl')).toBe('ambiguous');
    expect(classifyContentType('application/x-mpegurl')).toBe('ambiguous');
  });

  it('reports an unknown or missing type as unknown', () => {
    expect(classifyContentType('application/octet-stream')).toBe('unknown');
    expect(classifyContentType('')).toBe('unknown');
  });
});

describe('classifying by URL extension', () => {
  it('distinguishes .m3u from .m3u8', () => {
    expect(classifyUrlExtension('http://a/x.m3u')).toBe('m3u');
    expect(classifyUrlExtension('http://a/x.m3u8')).toBe('hls');
  });

  it('ignores the query string', () => {
    expect(classifyUrlExtension('http://a/stream.mp3?token=abc.m3u')).toBe('audio');
  });
});

describe('sniffing audio bytes', () => {
  it('recognises an MPEG frame sync', () => {
    expect(looksLikeAudio(mp3Bytes())).toBe(true);
  });

  it('recognises an ADTS AAC syncword', () => {
    expect(looksLikeAudio(aacBytes())).toBe(true);
  });

  it('recognises an Ogg page', () => {
    expect(looksLikeAudio(oggBytes())).toBe(true);
  });

  it('recognises an ID3 tag at the head of an MP3', () => {
    expect(looksLikeAudio(Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00', 'latin1'))).toBe(true);
  });

  it('does not mistake random binary for audio', async () => {
    expect(looksLikeAudio(await fixture('binary', 'garbage.bin'))).toBe(false);
  });

  it('does not mistake a web page for audio', async () => {
    expect(looksLikeAudio(await fixture('html', 'parking-page.html'))).toBe(false);
  });

  it('rejects a reserved MPEG version that only looks like a sync word', () => {
    // 0xFF 0xF9 has the 11 sync bits but declares the reserved version.
    expect(looksLikeAudio(Buffer.from([0xff, 0xe9, 0x00, 0x00]))).toBe(false);
  });
});

describe('sniffing playlists', () => {
  it('identifies a PLS body', async () => {
    expect(sniffBody(await fixture('playlists', 'valid.pls'))).toBe('pls');
  });

  it('identifies an extended M3U body', async () => {
    expect(sniffBody(await fixture('playlists', 'extended.m3u'))).toBe('m3u');
  });

  it('identifies a bare URL list as M3U', async () => {
    expect(sniffBody(await fixture('playlists', 'plain.m3u'))).toBe('m3u');
  });

  it('identifies HTML', async () => {
    expect(sniffBody(await fixture('html', 'parking-page.html'))).toBe('html');
  });

  it('gives up on binary garbage instead of guessing', async () => {
    expect(sniffBody(await fixture('binary', 'garbage.bin'))).toBe('unknown');
  });

  it('gives up on an empty body', () => {
    expect(sniffBody(Buffer.alloc(0))).toBe('unknown');
  });
});

describe('telling HLS apart from a plain M3U', () => {
  it('treats an #EXTM3U carrying #EXT-X- tags as HLS', async () => {
    const text = (await fixture('playlists', 'hls.m3u8')).toString('utf8');
    expect(isHlsManifest(text)).toBe(true);
    expect(sniffBody(Buffer.from(text))).toBe('hls');
  });

  it('does not treat an extended M3U station list as HLS', async () => {
    const text = (await fixture('playlists', 'extended.m3u')).toString('utf8');
    expect(isHlsManifest(text)).toBe(false);
  });

  it('does not treat a bare URL list as HLS even when served as .m3u8', () => {
    expect(isHlsManifest('http://a/1\nhttp://a/2\n')).toBe(false);
  });
});

describe('deciding what a response really is', () => {
  it('believes the body over a content-type that claims HTML', () => {
    expect(decideBodyKind({ contentType: 'text/html', url: 'http://a/s', bytes: mp3Bytes() })).toBe(
      'audio',
    );
  });

  it('believes the body over a content-type that claims audio', async () => {
    const bytes = await fixture('html', 'parking-page.html');
    expect(decideBodyKind({ contentType: 'audio/mpeg', url: 'http://a/s', bytes })).toBe('html');
  });

  it('treats a playlist body as a playlist however it was labelled', async () => {
    const bytes = await fixture('playlists', 'valid.pls');
    expect(decideBodyKind({ contentType: 'audio/mpeg', url: 'http://a/s', bytes })).toBe('pls');
  });

  it('resolves audio/x-mpegurl to audio when the body is a stream', () => {
    expect(
      decideBodyKind({ contentType: 'audio/x-mpegurl', url: 'http://a/s', bytes: mp3Bytes() }),
    ).toBe('audio');
  });

  it('resolves audio/x-mpegurl to a playlist when the body is a URL list', async () => {
    const bytes = await fixture('playlists', 'plain.m3u');
    expect(decideBodyKind({ contentType: 'audio/x-mpegurl', url: 'http://a/s', bytes })).toBe('m3u');
  });

  it('trusts an audio content-type when the bytes are unreadable', async () => {
    // A codec we cannot sniff still deserves an attempt.
    const bytes = await fixture('binary', 'garbage.bin');
    expect(decideBodyKind({ contentType: 'audio/mp4', url: 'http://a/s', bytes })).toBe('audio');
  });

  it('falls back to the URL extension when nothing else spoke', () => {
    expect(decideBodyKind({ url: 'http://a/stream.mp3', bytes: Buffer.alloc(0) })).toBe('audio');
  });

  it('reports unknown when header, body and extension are all silent', () => {
    expect(decideBodyKind({ url: 'http://a/stream', bytes: Buffer.alloc(0) })).toBe('unknown');
  });
});
