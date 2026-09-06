// @vitest-environment jsdom
/**
 * What the panel is allowed to say, and about what.
 *
 * Three defects were measured on the running product by an independent critic,
 * and all three are the same class: a surface asserting something the engine had
 * not reported, or quoting something no listener should ever be shown.
 *
 *   · FIX 1 — a station that failed with `phase: "error"` still carried the
 *     register's orange ON AIR marker and `aria-selected="true"` **36 seconds
 *     later**, and the band plate printed `PLAYING ONE STATION — CUT A BAND TO
 *     GET A DIAL FULL OF THEM` simultaneously with `FAULT — HTTP … ANSWERED
 *     404`, with `FAULT — HLS`, and right through a 67-second buffering freeze.
 *     One expression caused all of it: `powered ? state.station?.id : undefined`,
 *     where `powered` is `phase !== 'idle'` — intent, not measurement (Law 2).
 *
 *   · FIX 2 — the flywheel was fully live on a dial with nothing on it. A real
 *     four-turn arc drag moved the drum scale from 9590–9710 kHz to 9740–9860
 *     kHz with the pointer lit while `document.body.innerText` stayed
 *     byte-identical, and `aria-valuenow` read `0.368` over a canvas that is
 *     `aria-hidden="true"`.
 *
 *   · FIX 3 — Node and OpenSSL internals reached the faceplate verbatim:
 *     `getaddrinfo ENOTFOUND …`, `connect ECONNREFUSED 127.0.0.1:18799`,
 *     `certificate has expired` behind the false claim that the host had not
 *     answered, and an `SSL ROUTINES:OPENSSL_INTERNAL` dump.
 *
 * Every rule below is a decision, and the decisions live in pure functions on
 * purpose: a decision that can only be checked by photographing a running app is
 * a decision that will regress again.
 */

import { describe, expect, it } from 'vitest';

import {
  INITIAL_PLAYBACK_STATE,
  type Band,
  type NetworkCause,
  type PlaybackPhase,
  type PlaybackState,
  type ResolveFailure,
  type StationRef,
} from '../../src/shared/contracts';
import { airStateOf, type AirState } from '../../src/renderer/ui/types';
import { bandHint } from '../../src/renderer/ui/components/meterBand';
import { dialValueText } from '../../src/renderer/ui/components/tuningKnob';
import { FAULT_SENTENCES, directoryFaultText, resolveFaultText } from '../../src/renderer/host/faults';
import { networkCauseOf } from '../../src/main/resolver/rawHttp';
import * as say from '../../src/renderer/host/notices';

/**
 * The internals a 1977 faceplate may never print.
 *
 * `\bE[A-Z]{4,}\b` catches every errno (`ENOTFOUND`, `ECONNREFUSED`,
 * `ECONNRESET`, `EPROTO`); the rest catch the DNS call by name, OpenSSL's own
 * labels, and an IP address with a port on it.
 *
 * The word boundaries are load-bearing and are the one deviation from the
 * literal `/E[A-Z]{4,}|…/` this was specified as: unanchored, `E[A-Z]{4,}`
 * matches `ECONNECT` inside **RECONNECT**, so the pattern forbids the name of
 * the control that every one of these sentences is required to offer. An errno
 * is a standalone token and is only ever a standalone token, so anchoring it
 * loses nothing — `ENOTFOUND`, `getaddrinfo ENOTFOUND x` and `(EPROTO)` all
 * still match, and `RECONNECT` does not.
 */
const JARGON = /\bE[A-Z]{4,}\b|getaddrinfo|OPENSSL|SSL ROUTINES|\d+\.\d+\.\d+\.\d+:\d+/;

/**
 * Identifier-shaped tokens: what a transport string carries that prose does not.
 *
 * Sweeping *every* word of the input would be self-defeating — "connect" is both
 * a word in `connect ECONNREFUSED …` and a word in "the station broke the
 * connection". These are the shapes that can only have come from a machine: a
 * SCREAMING_CASE identifier, a dotted hostname, an IPv4 address, a port.
 */
const MACHINE_TOKEN = /\b[A-Z][A-Z_0-9]{3,}\b|\b[a-z0-9-]+\.[a-z][a-z0-9-]*\.[a-z]{2,}\b|\b\d+\.\d+\.\d+\.\d+\b|:\d{2,5}\b/g;

const PHASES: PlaybackPhase[] = [
  'idle',
  'resolving',
  'connecting',
  'buffering',
  'playing',
  'stalled',
  'reconnecting',
  'error',
];

function station(id: string, name = id.toUpperCase()): StationRef {
  return { id, name, url: `http://example.invalid/${id}`, tags: [], popularity: 1 };
}

function at(phase: PlaybackPhase, patch: Partial<PlaybackState> = {}): PlaybackState {
  return { ...INITIAL_PLAYBACK_STATE, phase, station: station('s1', 'Radio Paradise'), ...patch };
}

function band(over: Partial<Band> = {}): Band {
  const slots = over.slots ?? [
    { station: station('a', 'Radio Paradise'), position: 0.25, width: 0.01 },
    { station: station('b', 'FIP'), position: 0.75, width: 0.01 },
  ];
  return {
    genre: 'jazz',
    stationCount: slots.length,
    slots,
    scaleMin: 9500,
    scaleMax: 9900,
    scaleUnit: 'kHz',
    scaleLabel: '31 m',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// FIX 1 — the on-air marker is a measurement
// ---------------------------------------------------------------------------

describe('the on-air marker is measured, never asserted', () => {
  it('is on air for exactly one phase, and it is the one the decoder reports', () => {
    const onAir = PHASES.filter((phase) => airStateOf(at(phase)) === 'on');
    expect(onAir).toEqual(['playing']);
  });

  it('does not mark a station whose attempt ended in error', () => {
    // The measured case: `phase: "error"`, marker still orange 36 s later.
    expect(airStateOf(at('error', { error: { kind: 'http', message: 'gone', attempts: 3 } }))).toBe(
      'failed',
    );
  });

  it('reads an attempt in flight as trying, not as playing', () => {
    for (const phase of ['resolving', 'connecting', 'buffering', 'reconnecting'] as PlaybackPhase[]) {
      expect(airStateOf(at(phase)), phase).toBe('trying');
    }
  });

  it('takes the marker off a stream whose bytes stopped', () => {
    // `stalled` is "it was playing and the flow dried up". The meter is on its
    // zero stop and RECONNECT's lamp is red; a row still claiming ON AIR would
    // contradict both in one glance.
    expect(airStateOf(at('stalled'))).toBe('failed');
  });

  it('claims nothing in standby', () => {
    expect(airStateOf(at('idle'))).toBe('off');
  });

  it('never reports on air for a phase that is not playing', () => {
    for (const phase of PHASES) {
      if (phase === 'playing') continue;
      expect(airStateOf(at(phase)), phase).not.toBe('on');
    }
  });
});

describe('the band plate never claims playback the engine did not report', () => {
  /** The plate's exact words, as measured beside `FAULT — HTTP … ANSWERED 404`. */
  const PLAYING = 'PLAYING ONE STATION';

  it('says PLAYING only when the engine says playing', () => {
    const said = (air: AirState): string => bandHint({ registerVisible: false, air, warming: false }, false);
    expect(said('on')).toContain(PLAYING);
    for (const air of ['off', 'trying', 'failed'] as AirState[]) {
      expect(said(air), air).not.toContain(PLAYING);
    }
  });

  it('reads a fault as failed, and names the control that re-tries it', () => {
    const hint = bandHint({ registerVisible: false, air: 'failed', warming: false }, false);
    expect(hint).toContain('FAILED');
    expect(hint).toContain('RECONNECT');
  });

  it('reads an attempt in flight as trying', () => {
    expect(bandHint({ registerVisible: true, air: 'trying', warming: false }, false)).toContain('TRYING');
  });

  it('cannot print PLAYING for any phase the whole pipeline can produce', () => {
    // The end-to-end version of the same rule, run through the real derivation
    // rather than through a hand-written `air` value. This is the assertion that
    // would have failed on the shipped build for five of the eight phases.
    for (const phase of PHASES) {
      const state = at(phase);
      const hint = bandHint({ registerVisible: false, air: airStateOf(state), warming: false }, false);
      if (phase === 'playing') expect(hint).toContain(PLAYING);
      else expect(hint, phase).not.toContain(PLAYING);
    }
  });
});

// ---------------------------------------------------------------------------
// FIX 2 — the flywheel says where it is, and refuses when there is nowhere
// ---------------------------------------------------------------------------

describe('the flywheel has a text equivalent for a canvas nobody can read', () => {
  it('says "no band cut" rather than a bare decimal when the drum is empty', () => {
    // Measured: `aria-valuenow: 0.368` and nothing else, over a drum canvas that
    // is `aria-hidden="true"` and prints every station name.
    expect(dialValueText(null, 0.368)).toBe('no band cut');
    expect(dialValueText(band({ slots: [], stationCount: 0 }), 0.368)).toBe('no band cut');
  });

  it('matches the treatment its neighbour already had', () => {
    // METER BAND's `aria-valuetext` for the same state, verbatim. Two controls in
    // the same state must not have two vocabularies.
    expect(dialValueText(null, 0.5)).toBe('no band cut');
  });

  it('names the station under the cursor', () => {
    const text = dialValueText(band(), 0.25, 'Radio Paradise');
    expect(text).toContain('Radio Paradise');
    expect(text).toContain('31 m');
    expect(text).toContain('kHz');
  });

  it('says where it is even between stations, so the number means something', () => {
    const text = dialValueText(band(), 0.5);
    expect(text).toContain('between stations');
    // The frequency is the drum's printed scale, not the 0..1 slider position.
    expect(text).toContain('9,700');
    expect(text).not.toContain('0.5');
  });

  it('follows the printed scale across the whole drum', () => {
    expect(dialValueText(band(), 0)).toContain('9,500');
    expect(dialValueText(band(), 1)).toContain('9,900');
  });

  it('prints an FM-style scale to two places, in its own unit', () => {
    const fm = band({ scaleMin: 88, scaleMax: 108, scaleUnit: 'MHz', scaleLabel: '' });
    expect(dialValueText(fm, 0.5)).toContain('98.00 MHz');
  });
});

describe('a locked dial says so in words a stranger can act on', () => {
  it('names the control that fills it, and never one that was cut', () => {
    for (const open of [true, false]) {
      const notice = say.dialLocked(open);
      expect(notice.headline).toBeTruthy();
      expect(notice.action).toMatch(/STATIONS|REGISTER/);
      expect(notice.action).toMatch(/PICK|PRESS|THROW/);
      expect(notice.action).not.toMatch(/GENRE/i);
    }
  });

  it('does not send anyone to open a register that is standing open', () => {
    expect(say.dialLocked(true).action).not.toMatch(/PRESS THE LIT REGISTER KEY/);
    expect(say.dialLocked(true).action).toContain('ABOVE');
  });
});

// ---------------------------------------------------------------------------
// FIX 3 — no transport internals on the faceplate, ever
// ---------------------------------------------------------------------------

/**
 * The four strings the critic photographed on the panel, plus the two shapes
 * behind them.
 *
 * These are inputs, not expectations: each one is fed in as a failure `message`
 * and the assertion is that **none of it comes out**.
 */
const RAW_TRANSPORT_TEXT = [
  'getaddrinfo ENOTFOUND stream.somewhere.invalid',
  'connect ECONNREFUSED 127.0.0.1:18799',
  'certificate has expired',
  '28879379129536:error:100000F7:SSL routines:OPENSSL_internal:WRONG_VERSION_NUMBER',
  'read ECONNRESET',
  'write EPROTO',
  'Client network socket disconnected before secure TLS connection was established',
  'unable to verify the first certificate',
  'socket hang up',
];

const CAUSES: NetworkCause[] = ['dns', 'refused', 'unreachable', 'reset', 'tls', 'protocol', 'unknown'];

/** Every `ResolveFailure` the contract admits, each carrying the worst raw text. */
function everyResolveFailure(): ResolveFailure[] {
  const out: ResolveFailure[] = [];
  for (const message of RAW_TRANSPORT_TEXT) {
    out.push({ kind: 'network', message });
    for (const cause of CAUSES) out.push({ kind: 'network', message, cause });
    for (const status of [200, 301, 400, 401, 403, 404, 410, 429, 451, 500, 502, 503]) {
      out.push({ kind: 'http', status, message });
    }
    out.push({ kind: 'not-audio', contentType: 'text/html; charset=utf-8', message });
    out.push({ kind: 'not-audio', contentType: message, message });
    out.push({ kind: 'hls', message });
    out.push({ kind: 'empty-playlist', message });
    out.push({ kind: 'too-many-redirects', message });
    out.push({ kind: 'timeout', message });
  }
  return out;
}

describe('no fault sentence carries a Node or OpenSSL identifier', () => {
  it('sweeps every failure shape crossed with every leak the critic measured', () => {
    const offenders: string[] = [];
    for (const failure of everyResolveFailure()) {
      const said = resolveFaultText(failure);
      if (JARGON.test(said)) offenders.push(`${failure.kind}: ${said}`);
    }
    expect(offenders).toEqual([]);
  });

  it('quotes no machine token from the transport text, not merely no known jargon', () => {
    // The stronger statement, and the one that makes the guarantee total: a
    // denylist can only ever forbid the internals somebody has already been
    // shown. Composition cannot leak, so nothing identifier-shaped survives —
    // including identifiers no denylist in this repository has heard of.
    for (const failure of everyResolveFailure()) {
      const said = resolveFaultText(failure);
      for (const token of failure.message.match(MACHINE_TOKEN) ?? []) {
        expect(said, `${token} → ${said}`).not.toContain(token);
      }
    }
  });

  it('lets a made-up identifier through no more than a known one', () => {
    // A code invented for this test, so it cannot be in any list anywhere.
    const said = resolveFaultText({
      kind: 'network',
      message: 'connect EQUUXFROB 203.0.113.9:8000 (VENDOR_PRIVATE_HANDSHAKE_FAULT)',
    });
    expect(said).not.toMatch(JARGON);
    expect(said).not.toContain('EQUUXFROB');
    expect(said).not.toContain('203.0.113.9');
    expect(said).not.toContain('VENDOR_PRIVATE_HANDSHAKE_FAULT');
  });

  it('holds for the whole closed set of sentences this receiver can print', () => {
    expect(FAULT_SENTENCES.length).toBeGreaterThan(25);
    for (const sentence of FAULT_SENTENCES) {
      expect(sentence, sentence).not.toMatch(JARGON);
      expect(sentence.length, sentence).toBeGreaterThan(10);
    }
  });

  it('keeps the directory’s own faults composed too', () => {
    for (const kind of ['network', 'timeout', 'http', 'malformed', 'no-mirror'] as const) {
      const said = directoryFaultText({ kind, message: RAW_TRANSPORT_TEXT[0]!, status: 500 });
      expect(said, kind).not.toMatch(JARGON);
      expect(said, kind).toContain('RECONNECT');
    }
  });
});

describe('each transport failure says the true thing about itself', () => {
  const said = (cause: NetworkCause): string =>
    resolveFaultText({ kind: 'network', message: 'irrelevant', cause });

  it('separates a name that does not resolve from a host that refused', () => {
    expect(said('dns')).toBe('that address does not exist any more');
    expect(said('refused')).toBe('nothing is listening at that address');
    expect(said('dns')).not.toBe(said('refused'));
  });

  it('stops claiming the host did not answer when it answered with a bad certificate', () => {
    // Measured, verbatim: `the station's host did not answer (certificate has
    // expired)`. The host answered. Its certificate had expired.
    const tls = said('tls');
    expect(tls).toContain('certificate');
    expect(tls).not.toMatch(/did not answer/);
  });

  it('never prints the same sentence for two different causes', () => {
    const all = CAUSES.map(said);
    expect(new Set(all).size).toBe(all.length);
  });

  it('names RECONNECT wherever RECONNECT can actually help', () => {
    // 403 is a refusal by the station and another mount will not change it; HLS
    // is undecodable by construction. Everything else is worth a press, and not
    // one of the six fault paths used to say so.
    expect(resolveFaultText({ kind: 'http', status: 404, message: '' })).toContain('RECONNECT');
    expect(resolveFaultText({ kind: 'http', status: 500, message: '' })).toContain('RECONNECT');
    expect(resolveFaultText({ kind: 'timeout', message: '' })).toContain('RECONNECT');
    expect(resolveFaultText({ kind: 'empty-playlist', message: '' })).toContain('RECONNECT');
    expect(resolveFaultText({ kind: 'hls', message: '' })).not.toContain('RECONNECT');
  });

  it('stops reading 403 and 500 as "it may have moved"', () => {
    const refused = resolveFaultText({ kind: 'http', status: 403, message: '' });
    const broken = resolveFaultText({ kind: 'http', status: 500, message: '' });
    const gone = resolveFaultText({ kind: 'http', status: 404, message: '' });
    expect(refused).toBe('the station refused this receiver');
    expect(broken).toContain('broken');
    expect(gone).toContain('gone');
    expect(new Set([refused, broken, gone]).size).toBe(3);
  });
});

describe('the cause is classified from structured fields, not from prose', () => {
  /** A Node socket error, as Node actually shapes one. */
  const err = (code: string, extra: Record<string, unknown> = {}): unknown =>
    Object.assign(new Error('a message no classifier may read'), { code, ...extra });

  it('reads the errno', () => {
    expect(networkCauseOf(err('ENOTFOUND'))).toBe('dns');
    expect(networkCauseOf(err('EAI_AGAIN'))).toBe('dns');
    expect(networkCauseOf(err('ECONNREFUSED'))).toBe('refused');
    expect(networkCauseOf(err('EHOSTUNREACH'))).toBe('unreachable');
    expect(networkCauseOf(err('ENETUNREACH'))).toBe('unreachable');
    expect(networkCauseOf(err('ECONNRESET'))).toBe('reset');
    expect(networkCauseOf(err('EPIPE'))).toBe('reset');
  });

  it('recognises TLS from the certificate verdict and from the OpenSSL library', () => {
    expect(networkCauseOf(err('CERT_HAS_EXPIRED'))).toBe('tls');
    expect(networkCauseOf(err('UNABLE_TO_VERIFY_LEAF_SIGNATURE'))).toBe('tls');
    expect(networkCauseOf(err('ERR_TLS_CERT_ALTNAME_INVALID'))).toBe('tls');
    expect(networkCauseOf(err('ERR_SSL_WRONG_VERSION_NUMBER'))).toBe('tls');
    // OpenSSL's own dump: the code is unhelpful, `library` is the structured part.
    expect(networkCauseOf(err('ERR_OSSL_INTERNAL', { library: 'SSL routines' }))).toBe('tls');
  });

  it('degrades to a sentence rather than to raw text when it recognises nothing', () => {
    for (const value of [undefined, null, 'a string', 42, new Error('bare'), err('EWHATEVER')]) {
      const cause = networkCauseOf(value);
      expect(CAUSES).toContain(cause);
      expect(resolveFaultText({ kind: 'network', message: 'raw', cause })).not.toMatch(JARGON);
    }
  });
});
