/**
 * The first sixty seconds.
 *
 * Four independent critics arrived at the same wound from different directions,
 * including a deliberately naive user who gave up after forty seconds. The
 * evidence they produced was, in order of severity:
 *
 *   · Pressing the power dome ten times on a fresh profile changed **zero
 *     pixels**. Panel `innerText` was byte-identical before and after, polled
 *     at 150 ms for four seconds, on two fresh profiles, with real xdotool
 *     input proven delivered.
 *   · One real click on RADIO at cold start set the register's sheet header to
 *     `NOT PRINTED` above 43 still-rendered rows, and it was still wrong twenty
 *     seconds later.
 *   · The band plate printed `OPEN THE REGISTER` while the register stood open
 *     in the bay above it, and while audio was playing.
 *   · The readout printed `LOCKED` beside `signalLevel: 0.000` with the needle
 *     on the zero stop.
 *
 * All four are one root cause plus three of its neighbours: `setBrowse({error})`
 * was the only route the host's error strings had, and it leads to a component
 * that displays them only when the sheet has no rows — so on a cold start with
 * ~2000 rows loaded, `BAND EMPTY` and `NOTHING TUNED` were unreachable by
 * anyone, ever, while the sheet header was corrupted as a side effect.
 *
 * These tests pin the replacement. They are deliberately DOM-free: every rule
 * below is a decision, the decisions now live in pure functions, and a decision
 * that can only be checked by photographing a running app is a decision that
 * will regress again.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  INITIAL_PLAYBACK_STATE,
  LOG_CAPACITY,
  type LogEntry,
  type PlaybackState,
  type StationRef,
} from '../../src/shared/contracts';
import { sheetSafe } from '../../src/renderer/host/faults';
import { normaliseLog, recordHeard } from '../../src/renderer/host/logbook';
import * as say from '../../src/renderer/host/notices';
import { bandHint } from '../../src/renderer/ui/components/meterBand';
import { describePhase } from '../../src/renderer/ui/components/readout';

const SRC = path.resolve(__dirname, '../../src');

function station(id: string, name = id.toUpperCase()): StationRef {
  return { id, name, url: `http://example.invalid/${id}`, tags: [], popularity: 1 };
}

function playing(patch: Partial<PlaybackState> = {}): PlaybackState {
  return { ...INITIAL_PLAYBACK_STATE, phase: 'playing', signalLevel: 0.7, ...patch };
}

/** Every notice the host can produce, so the rules below can sweep all of them. */
function everyNotice(): say.NoticeSpec[] {
  const s = station('s1', 'Radio Paradise');
  return [
    say.nothingToPlay({ registerOpen: false }),
    say.nothingToPlay({ registerOpen: true }),
    say.nothingToPlay({ directoryFault: 'NO ROUTE — RECONNECT TO RETRY', registerOpen: true }),
    say.nothingTuned(),
    say.nothingTuned(s),
    say.repullingDirectory('NO ANSWER IN TIME — RECONNECT'),
    say.noDirectory('NO MIRROR REACHABLE — RECONNECT'),
    say.emptyPreset('C'),
    say.emptyPreset('B', s),
    say.nothingToStore('P'),
    say.stored('C', s),
    say.bridgeMissing(),
    say.engineMissing(),
    // The recovery voice: RECONNECT acknowledging a press, a fault naming its
    // remedy, a repeat fault admitting it is a repeat, and a locked dial.
    say.reconnecting(s, 1, false),
    say.reconnecting(s, 4, true),
    say.stationFaulted(s, 'that mount is gone — try RECONNECT for another'),
    say.stationFaulted(s, 'this station is HLS only', { canRetry: false }),
    say.stationFaulted(s, 'that mount is gone', { again: 3 }),
    say.dialLocked(false),
    say.dialLocked(true),
    say.warmingUp(),
  ];
}

// ---------------------------------------------------------------------------
// FIX 1 — RADIO ON and RECONNECT are no longer silent
// ---------------------------------------------------------------------------

describe('the panel answers a control that cannot do what was asked', () => {
  it('gives RADIO ON with an empty dial words, not silence', () => {
    const notice = say.nothingToPlay({ registerOpen: false });
    expect(notice.headline).toBeTruthy();
    expect(notice.action).toBeTruthy();
  });

  it('tells the user what to do next, not only what is wrong', () => {
    // A verb, an object, and a control. "BAND EMPTY" alone is a diagnosis
    // handed to somebody who did not ask for one. The one exception is the
    // store confirmation, which reports a thing that already succeeded and has
    // no next step to name.
    const blocked = everyNotice().filter((n) => n.headline !== 'STORED');
    for (const notice of blocked) {
      expect(notice.action.length, notice.headline).toBeGreaterThan(12);
      expect(notice.action, notice.headline).toMatch(
        /PRESS|HOLD|THROW|PICK|TUNE|RESTART|RECONNECT|REPRINT|OPEN/,
      );
    }
    expect(blocked.length).toBeGreaterThan(10);
  });

  it('separates a broken directory from an empty dial', () => {
    const broken = say.nothingToPlay({
      directoryFault: 'NO ROUTE — RECONNECT TO RETRY',
      registerOpen: true,
    });
    const empty = say.nothingToPlay({ registerOpen: true });
    expect(broken.tone).toBe('fault');
    expect(empty.tone).toBe('advice');
    expect(broken.headline).not.toBe(empty.headline);
  });

  it('offers the log strip when RECONNECT has nothing tuned but something was heard', () => {
    const heard = station('s9', 'BBC Radio 4');
    expect(say.nothingTuned(heard).action).toContain('BBC RADIO 4');
    // With nothing ever heard there is no log to point at, so it points at the
    // only other route there is — by the name printed on the key, which is
    // STATIONS. `REGISTER` read as a settings screen to every first-time user
    // who met it, and the register's own vocabulary starts on the far side of
    // the door rather than on it.
    expect(say.nothingTuned().action).toContain('STATIONS');
  });

  it('never tells anyone to open a register that is open', () => {
    for (const heard of [undefined, station('s9', 'BBC Radio 4')]) {
      expect(say.nothingTuned(heard, true).action).not.toMatch(/OPEN THE REGISTER|PRESS REGISTER/);
      expect(say.nothingTuned(heard, true).action).toContain('ABOVE');
      expect(say.nothingTuned(heard, false).action).toContain('STATIONS');
    }
  });

  it('names an empty preset key and how to fill it', () => {
    const notice = say.emptyPreset('C', station('s2', 'FIP'));
    expect(notice.headline).toContain('C');
    expect(notice.action).toContain('HOLD');
    expect(notice.action).toContain('FIP');
  });

  it('re-words itself when the register is opened', () => {
    // The advice names a key; pressing that key must not leave the panel still
    // telling you to press it.
    const shut = say.nothingToPlay({ registerOpen: false });
    const open = say.nothingToPlay({ registerOpen: true });
    expect(shut.headline).toBe(say.NOTHING_ON_THE_DIAL);
    expect(open.headline).toBe(say.NOTHING_ON_THE_DIAL);
    expect(shut.action).not.toBe(open.action);
    expect(open.action).not.toMatch(/PRESS THE LIT REGISTER KEY/);
  });

  it('confirms a store in words', () => {
    expect(say.stored('B', station('s3', 'SomaFM')).action).toContain('SOMAFM');
  });

  /**
   * THE DOOR IS CALLED BY THE NAME PRINTED ON IT.
   *
   * Three first-time users in a row, given only "it's an internet radio app",
   * failed to reach audio. The third one's diagnosis: "there is no play button
   * anywhere" — ~40 controls, twelve band keys, six knobs, a world map, and the
   * one door to a station is a small key on the bottom rail labelled REGISTER,
   * third in a row beside LIGHT and RECONNECT. "That's the front door and it's
   * disguised as a coat hook."
   *
   * The key is silkscreened STATIONS now. These sentences are the only place the
   * panel names it, so this is the only place the two can drift apart.
   */
  it('sends a stranger to the key by the name on the key', () => {
    const shut = [
      say.nothingToPlay({ registerOpen: false }).action,
      say.dialLocked(false).action,
      say.nothingTuned(undefined, false).action,
      say.nothingTuned(station('s9', 'BBC Radio 4'), false).action,
    ];
    for (const action of shut) {
      expect(action).toContain('STATIONS');
      // Not "press REGISTER". The register is what is *behind* the door, and its
      // own vocabulary — index, term, entry, scope, CUT BAND — is deliberate and
      // stays. It is the label on the outside that has to be a word a stranger
      // already owns.
      expect(action).not.toMatch(/PRESS (THE LIT )?REGISTER/);
    }
  });

  it('holds a switch-on that arrived before the station list did', () => {
    // The obvious first gesture happens a second or two after launch and the
    // directory does not always answer that fast. "NOTHING ON THE DIAL" is true
    // for one more second and then wrong, and it is the answer that taught a
    // first-time user the power dome does nothing.
    const warming = say.warmingUp();
    expect(warming.tone).toBe('advice');
    expect(warming.headline).not.toBe(say.NOTHING_ON_THE_DIAL);
    expect(warming.action).toMatch(/RECONNECT/);
  });
});

// ---------------------------------------------------------------------------
// The cut control may never be named again
// ---------------------------------------------------------------------------

/**
 * Collect the string literals from a TypeScript source, skipping comments.
 *
 * A regex over the raw text would be useless here: the comments in the fixed
 * files quote the old broken strings by name in order to explain what was wrong
 * with them, and a test that could not tell a quotation from a shipped string
 * would either fail on the documentation or pass on the defect.
 */
function stringLiterals(source: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      let text = '';
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') {
          text += source[i + 1] ?? '';
          i += 2;
          continue;
        }
        text += source[i];
        i++;
      }
      i++;
      out.push(text);
      continue;
    }
    i++;
  }
  return out;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'harness') continue; // dev-only, never in the shipped bundle
      out.push(...sourceFiles(full));
    } else if (name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('no shipped string names a control that was cut', () => {
  const files = [...sourceFiles(path.join(SRC, 'renderer')), ...sourceFiles(path.join(SRC, 'main'))];

  it('finds source to scan', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('never sends anyone to the genre selector', () => {
    // Law 1 cut the genre selector in this design round: the category axis is
    // the register now. `BAND EMPTY — TURN THE GENRE SELECTOR` nonetheless
    // shipped in the built bundle, pointing a first-time user at a knob that
    // does not exist on the faceplate they are looking at.
    const offenders: string[] = [];
    for (const file of files) {
      for (const literal of stringLiterals(readFileSync(file, 'utf8'))) {
        if (/genre\s+selector/i.test(literal)) offenders.push(`${path.relative(SRC, file)}: ${literal}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('has retired the two strings nobody could ever have seen', () => {
    const all = files.flatMap((file) => stringLiterals(readFileSync(file, 'utf8')));
    expect(all.filter((s) => s.includes('BAND EMPTY'))).toEqual([]);
    expect(all.filter((s) => s.includes('NOTHING TUNED — PICK A STATION'))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// FIX 2 — a fault may never be published over printed rows
// ---------------------------------------------------------------------------

describe('the sheet header cannot be poisoned by a panel message', () => {
  it('keeps a fault when the sheet is genuinely empty', () => {
    const results = { query: '', stations: [], loading: false, error: 'NO ROUTE — RECONNECT' };
    expect(sheetSafe(results).error).toBe('NO ROUTE — RECONNECT');
  });

  it('drops a fault that would print NOT PRINTED over real rows', () => {
    const rows = [station('a'), station('b')];
    const safe = sheetSafe({ stations: rows, loading: false, error: 'NOTHING TUNED' });
    expect(safe.error).toBeUndefined();
    expect(safe.stations).toHaveLength(2);
  });

  it('leaves a warning alone — a short result is still a printed one', () => {
    const safe = sheetSafe({
      stations: [station('a')],
      loading: false,
      warning: 'PARTIAL',
      error: 'SOMETHING',
    });
    expect(safe.warning).toBe('PARTIAL');
    expect(safe.error).toBeUndefined();
  });

  it('passes a clean result through untouched', () => {
    const clean = { query: '', stations: [station('a')], loading: false };
    expect(sheetSafe(clean)).toBe(clean);
  });
});

// ---------------------------------------------------------------------------
// FIX 3 — the band plate describes the panel as it actually is
// ---------------------------------------------------------------------------

describe('the band plate hint reflects reality', () => {
  it('does not tell you to open a register that is already open', () => {
    const hint = bandHint({ registerVisible: true, air: 'off', warming: false }, false);
    expect(hint).not.toMatch(/OPEN THE REGISTER/);
    expect(hint).toContain('ABOVE');
  });

  it('does tell you where the register is when it is not on screen', () => {
    const hint = bandHint({ registerVisible: false, air: 'off', warming: false }, false);
    // Named as the key is silkscreened, not as the machine files it.
    expect(hint).toContain('STATIONS');
  });

  it('says the list is still coming in, rather than sending you to cut a band that is about to appear', () => {
    // Measured on the packaged build: the plate said `PRESS STATIONS, PICK A
    // SUBJECT, THEN THROW CUT BAND` while the annunciator two rows down said
    // `THE DIAL FILLS AND PLAY STARTS ON ITS OWN`. Two instructions, one panel.
    const hint = bandHint({ registerVisible: false, air: 'off', warming: true }, false);
    expect(hint).toMatch(/COMING IN/);
    expect(hint).not.toMatch(/CUT BAND/);
    // A cut on the drum outranks everything: the plate prints the caption.
    expect(bandHint({ registerVisible: false, air: 'off', warming: true }, true)).toBe('');
  });

  it('stops nagging while audio is playing', () => {
    const hint = bandHint({ registerVisible: false, air: 'on', warming: false }, false);
    expect(hint).not.toMatch(/PRESS REGISTER/);
    expect(hint).toContain('PLAYING');
  });

  it('says nothing at all once a band is cut', () => {
    expect(bandHint({ registerVisible: true, air: 'on', warming: false }, true)).toBe('');
    expect(bandHint({ registerVisible: false, air: 'off', warming: false }, true)).toBe('');
  });

  it('is in plain words, not in register vocabulary', () => {
    // `NO BAND CUT` stays on the plate above this line — that is the machine's
    // own word for the state and the register teaches it. The instruction a
    // stranger reads may not require having learnt it first.
    for (const registerVisible of [true, false]) {
      const hint = bandHint({ registerVisible, air: 'off', warming: false }, false);
      expect(hint).not.toContain('NO BAND CUT');
      expect(hint).toMatch(/PICK|PRESS/);
    }
  });
});

// ---------------------------------------------------------------------------
// FIX 4 — the readout never affirms a lock the meter contradicts
// ---------------------------------------------------------------------------

describe('the phase badge agrees with the needle', () => {
  it('says LOCKED when there is a signal', () => {
    expect(describePhase(playing({ signalLevel: 0.42 }), 0).label).toBe('LOCKED');
  });

  it('does not say LOCKED at a measured zero once the silence is established', () => {
    const said = describePhase(playing({ signalLevel: 0 }), 5_000);
    expect(said.label).not.toBe('LOCKED');
    expect(said.label).toBe('NO AUDIO');
    // And it must not wear the green LOCKED background either.
    expect(said.key).toBe('silent');
  });

  it('rides out a short gap between items rather than flickering', () => {
    // Broadcast material really does hit digital silence between tracks.
    expect(describePhase(playing({ signalLevel: 0 }), 200).label).toBe('LOCKED');
  });

  it('takes the engine at its word the moment it names the cause', () => {
    const flow = describePhase(playing({ signalLevel: 0, signalLoss: 'flow-stopped' }), 0);
    expect(flow.label).toBe('NO AUDIO');
    expect(flow.detail).toContain('BYTES STOPPED');

    const detuned = describePhase(playing({ signalLevel: 0, signalLoss: 'detuned' }), 0);
    expect(detuned.detail).toContain('BETWEEN STATIONS');

    const dead = describePhase(playing({ signalLevel: 0, signalLoss: 'dead-air' }), 0);
    expect(dead.detail).toContain('SILENCE');
  });

  it('does not blame flow for a stall the dial caused', () => {
    // Captured live by the engine in the detuned state: `SIGNAL LOST · 850KB
    // RECEIVED · FLOW STOPPED`, while the bytes were flowing perfectly and the
    // only thing wrong was where the pointer was parked.
    const stalled = (loss?: PlaybackState['signalLoss']): string =>
      describePhase(
        { ...INITIAL_PLAYBACK_STATE, phase: 'stalled', bytesReceived: 850_000, ...(loss ? { signalLoss: loss } : {}) },
        0,
      ).detail;
    expect(stalled('detuned')).toContain('OFF STATION');
    expect(stalled('detuned')).not.toContain('FLOW STOPPED');
    expect(stalled('dead-air')).toContain('NO PROGRAMME');
    expect(stalled('dead-air')).not.toContain('FLOW STOPPED');
    expect(stalled('flow-stopped')).toContain('FLOW STOPPED');
    // No verdict from the engine: the observable fact is that flow stopped.
    expect(stalled()).toContain('FLOW STOPPED');
  });

  it('leaves every other phase exactly as it was', () => {
    expect(describePhase({ ...INITIAL_PLAYBACK_STATE }, 99_999).label).toBe('STANDBY');
    expect(describePhase({ ...INITIAL_PLAYBACK_STATE, phase: 'buffering' }, 99_999).label).toBe(
      'BUFFERING',
    );
  });
});

describe('a retry in progress is visible', () => {
  it('reads the live counter rather than the terminal one', () => {
    // `error.attempts` is populated only when the engine has given up, so the
    // old branch reading it could never render during a reconnect.
    const said = describePhase(
      {
        ...INITIAL_PLAYBACK_STATE,
        phase: 'reconnecting',
        retry: { attempt: 2, budget: 4, mount: 1, mounts: 1 },
      },
      0,
    );
    expect(said.detail).toBe('ATTEMPT 2 OF 4');
  });

  it('names the mount once the engine has moved on to another one', () => {
    const said = describePhase(
      {
        ...INITIAL_PLAYBACK_STATE,
        phase: 'reconnecting',
        retry: { attempt: 1, budget: 4, mount: 2, mounts: 3 },
      },
      0,
    );
    expect(said.detail).toBe('MOUNT 2/3 · ATTEMPT 1 OF 4');
  });

  it('says what it knows when the engine publishes no counter', () => {
    const said = describePhase({ ...INITIAL_PLAYBACK_STATE, phase: 'reconnecting' }, 0);
    expect(said.detail).toBe('RE-ACQUIRING');
  });
});

// ---------------------------------------------------------------------------
// FIX 6 — the logbook
// ---------------------------------------------------------------------------

describe('the logbook records what was heard', () => {
  it('writes a line for a station', () => {
    const log = recordHeard([], station('a', 'Radio A'), 1_000);
    expect(log).toHaveLength(1);
    expect(log[0]!.station.id).toBe('a');
    expect(log[0]!.heardAt).toBe(1_000);
  });

  it('puts the newest at the top', () => {
    let log: LogEntry[] = [];
    log = recordHeard(log, station('a'), 1);
    log = recordHeard(log, station('b'), 2);
    log = recordHeard(log, station('c'), 3);
    expect(log.map((e) => e.station.id)).toEqual(['c', 'b', 'a']);
  });

  it('moves a re-heard station up instead of printing it twice', () => {
    let log: LogEntry[] = [];
    log = recordHeard(log, station('a'), 1);
    log = recordHeard(log, station('b'), 2);
    log = recordHeard(log, station('a'), 3);
    expect(log.map((e) => e.station.id)).toEqual(['a', 'b']);
    expect(log[0]!.heardAt).toBe(3);
  });

  it('does nothing at all while the same station keeps playing', () => {
    // The engine reports ten times a second; nine hundred writes a minute to
    // disk would be a defect of its own.
    const first = recordHeard([], station('a'), 1);
    expect(recordHeard(first, station('a'), 2)).toBe(first);
  });

  it('drops the oldest line past capacity', () => {
    let log: LogEntry[] = [];
    for (let i = 0; i < LOG_CAPACITY + 6; i++) log = recordHeard(log, station(`s${i}`), i);
    expect(log).toHaveLength(LOG_CAPACITY);
    expect(log[0]!.station.id).toBe(`s${LOG_CAPACITY + 5}`);
    expect(log.some((e) => e.station.id === 's0')).toBe(false);
  });

  it('repairs a log read back off disk', () => {
    const messy: LogEntry[] = [
      { station: station('a'), heardAt: 10 },
      { station: station('c'), heardAt: 30 },
      { station: station('a'), heardAt: 5 },
      { station: station('b'), heardAt: 20 },
    ];
    const clean = normaliseLog(messy);
    expect(clean.map((e) => e.station.id)).toEqual(['c', 'b', 'a']);
  });

  it('survives a missing or empty log', () => {
    expect(normaliseLog(undefined)).toEqual([]);
    expect(normaliseLog([])).toEqual([]);
  });
});
