/**
 * The words the panel says, as data.
 *
 * Every string here used to be built inline in `host.ts` and handed to
 * `setBrowse({ error })` — that is, posted onto the register's sheet, which is
 * behind a lid, is only displayed when the sheet has zero rows, and in the
 * Design D rebuild is not even the component the strings were written for. The
 * net effect was that pressing RADIO ON on a fresh profile produced a message
 * that rendered nowhere: a pixel diff over ten presses of the power dome came
 * back with zero changed pixels.
 *
 * Splitting them out is not tidying. These are the app's contract with a person
 * who has been using it for four seconds, and they have two hard rules that a
 * test can only enforce if the strings are reachable without a DOM:
 *
 *   1. They may only name controls that are on the current faceplate. The genre
 *      selector was cut in this design round and `BAND EMPTY — TURN THE GENRE
 *      SELECTOR` shipped anyway, sending a first-time user to look for a knob
 *      that does not exist.
 *   2. They must say what to do next, not merely what went wrong. Law 4: "a
 *      station that just never starts is a defect".
 *   3. They must call the door by the name printed on it. The key that opens
 *      the register is silkscreened STATIONS, because `REGISTER` reads as a
 *      settings screen to everyone who has not used the app before — three
 *      first-time users in a row walked past it. The register's *inside*
 *      vocabulary is untouched: index, term, entry, scope, band, CUT BAND are
 *      what the machine calls its own parts and the register teaches them. Only
 *      the door needs a name a stranger already knows.
 */

import type { StationRef } from '../../shared/contracts';
import type { PanelNotice } from '../ui/types';

/** A notice before it is stamped with a sequence number. */
export type NoticeSpec = Omit<PanelNotice, 'seq'>;

/** Longest station name that fits in the action line beside its instruction. */
const NAME_LIMIT = 24;

function shout(name: string, limit = NAME_LIMIT): string {
  const clean = name.replace(/\s+/g, ' ').trim().toUpperCase();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

/**
 * RADIO ON pressed with nothing on the dial.
 *
 * The fresh-install case, and the one the entire first minute turns on. Two
 * genuinely different reasons, two different notices: a directory that could
 * not be reached is a fault the user cannot fix by choosing better, and an
 * empty dial on a working directory is simply a receiver waiting to be told
 * what to put on it.
 */
export function nothingToPlay(opts: {
  /** Text of the directory failure, if the directory is what is broken. */
  directoryFault?: string;
  /**
   * Whether the register's cards are on screen. Exactly "the lid is open": the
   * raised lid carries printing only, so this is the one state in which there
   * is anything to pick.
   */
  registerOpen: boolean;
}): NoticeSpec {
  if (opts.directoryFault) {
    return { headline: 'NO STATION LIST', action: opts.directoryFault, tone: 'fault' };
  }
  return {
    headline: 'NOTHING ON THE DIAL YET',
    action: opts.registerOpen
      ? 'IN THE REGISTER ABOVE: PICK A SUBJECT, THEN THROW CUT BAND.'
      : 'PRESS THE LIT STATIONS KEY, PICK A SUBJECT, THEN THROW CUT BAND.',
    tone: 'advice',
  };
}

/**
 * RECONNECT pressed with no station selected.
 *
 * The log strip is offered first when there is anything on it, because getting
 * back to something you have already heard is one press and needs no directory.
 * The register is the fallback, and it is described by where it actually is —
 * telling somebody to open a thing that is standing open is the same defect one
 * surface along.
 */
export function nothingTuned(mostRecent?: StationRef, registerOpen = false): NoticeSpec {
  const register = registerOpen
    ? 'OR PICK A SUBJECT IN THE REGISTER ABOVE'
    : 'OR PRESS STATIONS AND PICK A SUBJECT';
  return {
    headline: 'NOTHING TUNED',
    action: mostRecent
      ? `NOTHING IS SELECTED. PRESS ${shout(mostRecent.name)} ON THE LOG STRIP, ${register}.`
      : `NOTHING IS SELECTED. ${registerOpen ? 'PICK A SUBJECT IN THE REGISTER ABOVE' : 'PRESS STATIONS, PICK A SUBJECT'}, THEN THROW CUT BAND.`,
    tone: 'advice',
  };
}

/** RECONNECT pressed while the directory itself is the broken thing. */
export function repullingDirectory(directoryFault: string): NoticeSpec {
  return { headline: 'RE-PULLING THE STATION LIST', action: directoryFault, tone: 'fault' };
}

/**
 * RECONNECT pressed with a station to reconnect to.
 *
 * The press was previously *silent*. Measured: three presses on a permanently-404
 * station left `/test/state` unchanged and the panel byte-identical — a 240-frame
 * capture recorded no text change, no annunciator, no class change — while a
 * fault server logged a fresh request per press. So the work happened and the
 * panel denied it, which is the worst of the three possible outcomes: it teaches
 * that the control is dead.
 *
 * `press` is what makes the tenth press look different from the ninth, and it is
 * a count of presses on *this* station, so it reads as a record of what the
 * listener has actually tried rather than a session-wide tally.
 *
 * The two wordings are two different actions. A station that faulted gets the
 * next mount the resolver found; one that merely dropped gets the same mount
 * re-opened. Saying which is the difference between an acknowledgement and a
 * progress bar.
 */
export function reconnecting(station: StationRef, press: number, nextMount: boolean): NoticeSpec {
  const nth = press > 1 ? ` · PRESS ${press}` : '';
  return {
    headline: `RECONNECTING${nth}`,
    action: nextMount
      ? `TRYING THE NEXT MOUNT FOR ${shout(station.name)}. PRESS RECONNECT AGAIN TO WALK ON.`
      : `RE-OPENING THE STREAM FOR ${shout(station.name)}.`,
    tone: 'advice',
  };
}

/**
 * A station's attempt ended in a fault.
 *
 * Law 4: "a station that just never starts is a defect". The readout's own strip
 * prints `FAULT — <kind> — <sentence>`, which says what broke; this says what to
 * do, on the annunciator, beside the lamp that has just gone red. Nothing on the
 * panel used to name RECONNECT on any of the six fault paths, and it is a
 * physical button eight centimetres away.
 *
 * `again` is the honest half of RECONNECT: a re-attempt that failed the same way
 * has to say *the same way*, or the listener cannot tell a control that is
 * working-but-hopeless from one that is broken.
 */
export function stationFaulted(
  station: StationRef,
  detail: string,
  opts: { again?: number; canRetry?: boolean } = {},
): NoticeSpec {
  const said = detail.replace(/\s+/g, ' ').trim().toUpperCase();
  const what = said ? `${shout(station.name)} — ${said}` : `${shout(station.name)} FAILED`;
  if (opts.again && opts.again > 1) {
    return {
      headline: `SAME FAULT AFTER ${opts.again} TRIES`,
      action: `${what}. PICK ANOTHER STATION, OR PRESS STATIONS TO CUT A NEW BAND.`,
      tone: 'fault',
    };
  }
  // The resolver's own sentence sometimes already names RECONNECT ("that mount
  // is gone — try RECONNECT for another"); saying it twice in one line reads
  // as a stutter, not as emphasis.
  const retry = /RECONNECT/.test(said) ? '' : ' PRESS RECONNECT TO TRY AGAIN.';
  return {
    headline: 'STATION FAILED',
    action: opts.canRetry === false
      ? `${what}. PICK ANOTHER STATION FROM THE DIAL OR THE REGISTER.`
      : `${what}.${retry}`,
    tone: 'fault',
  };
}

/**
 * A hand on the flywheel, or on the drum, with nothing printed on it.
 *
 * Deliberately the same words as RADIO ON with an empty dial: it is the same
 * state and the same remedy, and a panel that describes one state two ways is a
 * panel with two states in it.
 */
export function dialLocked(registerOpen: boolean): NoticeSpec {
  return {
    headline: 'NOTHING ON THE DIAL TO TUNE',
    action: registerOpen
      ? 'IN THE REGISTER ABOVE: PICK A SUBJECT, THEN THROW CUT BAND.'
      : 'PRESS THE LIT STATIONS KEY, PICK A SUBJECT, THEN THROW CUT BAND.',
    tone: 'advice',
  };
}

/** The directory could not be pulled at all. */
export function noDirectory(directoryFault: string): NoticeSpec {
  return { headline: 'NO STATION LIST', action: directoryFault, tone: 'fault' };
}

/** The headline `nothingToPlay` prints when the dial is simply empty. */
export const NOTHING_ON_THE_DIAL = nothingToPlay({ registerOpen: false }).headline;

/** Headlines `loadIndex` is allowed to take back down once the pull succeeds. */
export const DIRECTORY_HEADLINES: readonly string[] = [
  noDirectory('').headline,
  repullingDirectory('').headline,
];

/** A C/B/P key clicked while it holds nothing. Previously a silent no-op. */
export function emptyPreset(slot: string, candidate?: StationRef): NoticeSpec {
  return {
    headline: `MEMORY ${slot} IS EMPTY`,
    action: candidate
      ? `HOLD ${slot} FOR ONE SECOND TO STORE ${shout(candidate.name)}.`
      : `TUNE A STATION FIRST, THEN HOLD ${slot} FOR ONE SECOND TO STORE IT.`,
    tone: 'advice',
  };
}

/** A key held down with nothing tuned to put in it. */
export function nothingToStore(slot: string): NoticeSpec {
  return {
    headline: `NOTHING TO STORE IN ${slot}`,
    action: 'TUNE A STATION FIRST, THEN HOLD THIS KEY AGAIN.',
    tone: 'advice',
  };
}

/** A store that worked, confirming itself in words as well as in light. */
export function stored(slot: string, station: StationRef): NoticeSpec {
  return {
    headline: 'STORED',
    action: `${shout(station.name, 28)} IS NOW ON MEMORY ${slot}.`,
    tone: 'advice',
  };
}

/**
 * RADIO ON pressed while the station list is still on its way.
 *
 * The difference between "there is nothing here" and "there is nothing here
 * YET", which the panel used to collapse into the first. A first-time user
 * presses the power dome within a couple of seconds of launch — measured, three
 * times — and the directory does not always answer that fast. Telling them the
 * dial is empty is true for one more second and then wrong, and the press it
 * answered is the one press the whole product depends on.
 *
 * The receiver holds the request and tunes when the list lands, so this says
 * what is happening and names the control that forces the issue if it does not.
 */
export function warmingUp(): NoticeSpec {
  return {
    headline: 'WARMING UP',
    action: 'THE STATION LIST IS STILL COMING IN. THE DIAL FILLS AND PLAY STARTS ON ITS OWN — OR PRESS RECONNECT.',
    tone: 'advice',
  };
}

/** The preload bridge never ran: nothing on the panel can work. */
export function bridgeMissing(): NoticeSpec {
  return {
    headline: 'RECEIVER NOT CONNECTED',
    action: 'THE APP BRIDGE IS MISSING. RESTART THE APP.',
    tone: 'fault',
  };
}

/** The panel is up but the audio engine never came with it. */
export function engineMissing(): NoticeSpec {
  return {
    headline: 'RECEIVER NOT READY',
    action: 'THE AUDIO ENGINE DID NOT START. RESTART THE APP.',
    tone: 'fault',
  };
}
