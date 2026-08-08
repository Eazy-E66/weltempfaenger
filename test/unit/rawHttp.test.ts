import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseResponseHead, RawHttpError, rawRequest } from '../../src/main/resolver/rawHttp';
import { startFixtureServer, startIcyServer, type FixtureServer, type IcyServer } from '../helpers/fixtureServer';

describe('parsing a response head', () => {
  it('parses an ordinary HTTP status line', () => {
    const head = parseResponseHead('HTTP/1.1 200 OK\r\nContent-Type: audio/mpeg');
    expect(head).toMatchObject({ protocol: 'HTTP/1.1', status: 200, statusText: 'OK' });
    expect(head.headers['content-type']).toBe('audio/mpeg');
  });

  it('parses the SHOUTcast ICY status line that Node rejects', () => {
    const head = parseResponseHead('ICY 200 OK\r\nicy-name:Groove Salad\r\nicy-br:128');
    expect(head).toMatchObject({ protocol: 'ICY', status: 200 });
    expect(head.headers['icy-name']).toBe('Groove Salad');
  });

  it('accepts bare LF line endings', () => {
    const head = parseResponseHead('ICY 200 OK\nicy-metaint:8192');
    expect(head.headers['icy-metaint']).toBe('8192');
  });

  it('lowercases header names and keeps values verbatim', () => {
    const head = parseResponseHead('HTTP/1.0 200 OK\r\nICY-Name:  Mixed Case Name  ');
    expect(head.headers['icy-name']).toBe('Mixed Case Name');
  });

  it('joins repeated headers rather than dropping one', () => {
    const head = parseResponseHead('HTTP/1.1 200 OK\r\nset-cookie: a=1\r\nset-cookie: b=2');
    expect(head.headers['set-cookie']).toBe('a=1, b=2');
  });

  it('rejects a first line that is not a status line at all', () => {
    expect(() => parseResponseHead('<html>hello</html>')).toThrow(RawHttpError);
  });
});

describe('requesting over a real socket', () => {
  let server: FixtureServer;
  beforeAll(async () => {
    server = await startFixtureServer();
  });
  afterAll(async () => {
    await server.close();
  });

  it('reads headers and body from an ordinary response', async () => {
    const res = await rawRequest(`${server.base}/audio/mp3`);
    try {
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('audio/mpeg');
      const body = await res.read(16);
      expect(body.length).toBe(16);
      expect(body[0]).toBe(0xff);
    } finally {
      res.close();
    }
  });

  it('continues where the previous read stopped', async () => {
    const res = await rawRequest(`${server.base}/audio/mp3`);
    try {
      const first = await res.read(8);
      const second = await res.read(32);
      expect(first.length).toBe(8);
      expect(second.length).toBe(32);
      expect(second.subarray(0, 8)).toEqual(first);
    } finally {
      res.close();
    }
  });

  it('decodes a chunked body', async () => {
    const res = await rawRequest(`${server.base}/pl-chunked/multi.pls`);
    try {
      expect(res.headers['transfer-encoding']).toBe('chunked');
      const body = (await res.read(64 * 1024)).toString('utf8');
      expect(body).toContain('[playlist]');
      expect(body).toContain('File3=');
      expect(body).not.toContain('\r\n0\r\n');
    } finally {
      res.close();
    }
  });

  it('reports a refused connection as a network error', async () => {
    await expect(rawRequest('http://127.0.0.1:1/nothing')).rejects.toMatchObject({
      code: 'network',
    });
  });

  it('reports a silent server as a timeout, not a hang', async () => {
    await expect(rawRequest(`${server.base}/slow`, { timeoutMs: 250 })).rejects.toMatchObject({
      code: 'timeout',
    });
  });

  it('reports a server that hangs up before answering', async () => {
    await expect(rawRequest(`${server.base}/hangup`)).rejects.toMatchObject({ code: 'network' });
  });

  it('refuses a scheme it could never play', async () => {
    await expect(rawRequest('mms://example.invalid/stream')).rejects.toThrow(/scheme/i);
  });
});

describe('SHOUTcast servers that answer "ICY 200 OK"', () => {
  let icy: IcyServer;
  beforeAll(async () => {
    icy = await startIcyServer();
  });
  afterAll(async () => {
    await icy.close();
  });

  it('is unreadable by Node\'s own fetch, which is why the raw client exists', async () => {
    // If this ever starts passing, undici has become lenient and the raw
    // client's justification needs revisiting.
    await expect(fetch(`${icy.base}/crlf`)).rejects.toThrow();
  });

  it('reads the status line and ICY headers', async () => {
    const res = await rawRequest(`${icy.base}/crlf`);
    try {
      expect(res.protocol).toBe('ICY');
      expect(res.status).toBe(200);
      expect(res.headers['icy-name']).toBe('Fixture Shoutcast v1 Server');
      expect(res.headers['icy-metaint']).toBe('8192');
      expect(res.headers['content-type']).toBe('audio/mpeg');
    } finally {
      res.close();
    }
  });

  it('reads the audio body that follows the ICY head', async () => {
    const res = await rawRequest(`${icy.base}/crlf`);
    try {
      const body = await res.read(64);
      expect(body.length).toBe(64);
      expect(body.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfb]));
    } finally {
      res.close();
    }
  });

  it('copes with an ICY head that uses bare LF line endings', async () => {
    const res = await rawRequest(`${icy.base}/lf`);
    try {
      expect(res.protocol).toBe('ICY');
      expect(res.headers['icy-br']).toBe('128');
    } finally {
      res.close();
    }
  });

  it('returns from an endless stream instead of waiting for an EOF that never comes', async () => {
    const res = await rawRequest(`${icy.base}/crlf`);
    try {
      const started = Date.now();
      await res.read(128);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      res.close();
    }
  });
});
