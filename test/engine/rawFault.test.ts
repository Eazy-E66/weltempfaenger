/**
 * WHAT THE SOCKET SAID, KEPT WHERE IT BELONGS.
 *
 * There are two audiences for a failure and they must never be served the same
 * string. The listener gets a designed sentence they can act on; the diagnostic
 * channel gets the transport's own words, unedited, because that is the only
 * record of what actually happened. Law 4 needs the first; a bug report needs
 * the second; `panel-truth.test.ts` forbids the second from ever becoming the
 * first.
 *
 * `ProxyLink` had the raw text in its hand — `ProxyEvent.detail`, which
 * `ProxySession.finish` fills with `upstream socket error: read ECONNRESET` —
 * and dropped it on the floor, calling `dropped(message)` with one argument
 * while `PlaybackEngine.onDrop(message, raw?)` had taken two all along. With
 * nothing to keep, `fail()` fell back to `raw ?? message` and stored the panel's
 * own paraphrase of itself: the one place that exists to hold the unvarnished
 * cause held a copy of the sentence written to hide it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlaybackEngine } from '../../src/renderer/engine/engine';
import { ProxyLink } from '../../src/renderer/engine/link';
import type { PsppcprBridge } from '../../src/renderer/engine/bridge';
import type { ProxyEvent } from '../../src/main/proxy/types';
import type { PlayableStream, StationRef } from '../../src/shared/contracts';
import { FakeAudioElement, FakeProxy, installWebAudio } from '../helpers/fakeDeck';

/** An errno, a Node call by name, or an OpenSSL label. Never for the panel. */
const JARGON = /\bE[A-Z]{4,}\b|getaddrinfo|ERR_[A-Z_]+|SSL routines|OPENSSL/;

/** What a socket that was cut mid-song actually reports. */
const RAW = 'upstream socket error: read ECONNRESET';
/** What the proxy hands over for a listener to read. */
const REASON = 'the connection to the station dropped';

function station(id = 'st-1'): StationRef {
  return { id, name: `Station ${id}`, url: `http://radio.test/${id}`, tags: [], popularity: 1 };
}
function stream(url: string): PlayableStream {
  return { url, contentType: 'audio/mpeg', supportsIcyMetadata: false, origin: 'direct' };
}

// ---------------------------------------------------------------------------
// The link: one argument was being thrown away
// ---------------------------------------------------------------------------

describe('the renderer’s half of a proxy session', () => {
  /** A bridge that is nothing but three event taps. */
  function tap(): { bridge: PsppcprBridge; fire(event: ProxyEvent): void; adopt(link: ProxyLink): void } {
    let onEvent: (e: ProxyEvent) => void = () => {};
    const bridge = {
      proxy: {
        start: async () => ({ url: 'http://127.0.0.1:9/s', sessionId: 'sess-1', port: 9, prerollSeconds: 2 }),
        stop: async () => {},
        onStats: () => () => {},
        onMetadata: () => () => {},
        onEvent: (cb: (e: ProxyEvent) => void) => {
          onEvent = cb;
          return () => {};
        },
      },
    } as unknown as PsppcprBridge;
    return {
      bridge,
      fire: (event) => onEvent(event),
      adopt: (link) => link.adopt({ url: 'http://127.0.0.1:9/s', sessionId: 'sess-1', port: 9, prerollSeconds: 2 }),
    };
  }

  it('hands the transport’s own words to the drop handler as `raw`', () => {
    const t = tap();
    const drops: Array<[string, string | undefined]> = [];
    const link = new ProxyLink(t.bridge, {
      metadata: () => {},
      dropped: (message, raw) => drops.push([message, raw]),
      changed: () => {},
    });
    t.adopt(link);

    t.fire({ sessionId: 'sess-1', kind: 'closed', graceful: false, message: REASON, detail: RAW, at: 1 });

    expect(drops).toHaveLength(1);
    const [message, raw] = drops[0]!;
    // The sentence keeps its shape, so nothing downstream of it changes.
    expect(message).toBe(`upstream closed: ${REASON}`);
    // And the second argument, which used to be `undefined` on every call this
    // class ever made, is now the socket's own text.
    expect(raw).toBe(RAW);
    link.dispose();
  });

  it('passes undefined when the proxy had no detail to give, rather than inventing one', () => {
    const t = tap();
    const drops: Array<[string, string | undefined]> = [];
    const link = new ProxyLink(t.bridge, {
      metadata: () => {},
      dropped: (message, raw) => drops.push([message, raw]),
      changed: () => {},
    });
    t.adopt(link);

    t.fire({ sessionId: 'sess-1', kind: 'closed', graceful: false, message: REASON, at: 1 });

    expect(drops[0]![1]).toBeUndefined();
    link.dispose();
  });

  it('says nothing at all about a session that is not the current one', () => {
    const t = tap();
    const drops: unknown[] = [];
    const link = new ProxyLink(t.bridge, {
      metadata: () => {},
      dropped: (...args) => drops.push(args),
      changed: () => {},
    });
    t.adopt(link);

    t.fire({ sessionId: 'someone-else', kind: 'closed', graceful: false, message: REASON, detail: RAW, at: 1 });

    expect(drops).toHaveLength(0);
    link.dispose();
  });
});

// ---------------------------------------------------------------------------
// The engine: two audiences, two strings
// ---------------------------------------------------------------------------

describe('a stream the socket cut mid-song', () => {
  let audio: ReturnType<typeof installWebAudio>;
  const engines: PlaybackEngine[] = [];

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
    });
    audio = installWebAudio();
  });
  afterEach(() => {
    for (const e of engines.splice(0)) e.dispose();
    audio.restore();
    vi.useRealTimers();
  });

  async function playingDeck(): Promise<{ engine: PlaybackEngine; proxy: FakeProxy }> {
    const el = new FakeAudioElement();
    const proxy = new FakeProxy();
    const engine = new PlaybackEngine({
      bridge: proxy.bridge(),
      audioElement: el as unknown as HTMLAudioElement,
      emitHz: 10,
      // AFC off, so one drop is terminal and `fail()` is the path under test.
      settings: { afcEnabled: false },
    });
    engines.push(engine);
    audio.setLevel(0.2);
    await engine.tune(station(), [stream('http://a/1')]);
    proxy.stats({ bytesReceived: 64_000 });
    el.ready(4);
    await vi.advanceTimersByTimeAsync(450);
    return { engine, proxy };
  }

  it('keeps the socket’s own text in diagnostics(), and only there', async () => {
    const { engine, proxy } = await playingDeck();
    expect(engine.currentState.phase).toBe('playing');

    proxy.drop(REASON, RAW);
    await vi.advanceTimersByTimeAsync(300);

    const state = engine.currentState;
    const diag = engine.diagnostics();

    expect(state.phase).toBe('error');
    // The record of what happened is verbatim.
    expect(diag.rawFaultMessage).toBe(RAW);
    // The panel gets a sentence, and it is not that one.
    expect(state.error?.message).not.toBe(RAW);
    expect(state.error?.message).not.toContain('ECONNRESET');
    expect(state.error?.message ?? '').not.toMatch(JARGON);
    expect(state.error?.kind).toBe('upstream-closed');
  });

  it('no longer stores the panel’s own paraphrase as the raw record', async () => {
    const { engine, proxy } = await playingDeck();
    proxy.drop(REASON, RAW);
    await vi.advanceTimersByTimeAsync(300);

    // This is the whole defect, as an assertion: `rawFault = raw ?? message`
    // with `raw` always undefined meant the two were the same string.
    expect(engine.diagnostics().rawFaultMessage).not.toBe(engine.currentState.error?.message);
  });

  it('falls back to the sentence when the proxy genuinely had no detail', async () => {
    const { engine, proxy } = await playingDeck();
    proxy.drop(REASON);
    await vi.advanceTimersByTimeAsync(300);

    // Not a regression: with nothing raw to keep, the honest record is the only
    // thing there was. What matters is that it is not silently empty.
    expect(engine.diagnostics().rawFaultMessage).toBeTruthy();
    expect(engine.currentState.phase).toBe('error');
  });
});
