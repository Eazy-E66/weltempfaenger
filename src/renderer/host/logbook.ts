/**
 * The operator's log.
 *
 * There was no history and no recents anywhere in the app. `memory.json` has
 * persisted `lastStation` since the beginning and nothing has ever shown it, so
 * a station heard once and tuned away from was gone: the only way back was to
 * remember what it was called and find it in the directory again. The three
 * preset keys do not cover this, because they only hold what you decided in
 * advance to keep, and the case that actually happens is deciding afterwards.
 *
 * Kept pure and separate from `host.ts` because the rules below are the whole
 * of the feature and each one is a thing that can be got wrong quietly:
 *
 *   · An entry is written from *observed* audio, never from a click (Law 2).
 *     The host calls this only from the engine's `playing` report, so a station
 *     that was tuned and never came up is not in the log claiming otherwise.
 *   · Re-hearing a station moves its line to the top rather than printing a
 *     second one. A log with the same call sign eleven times is not a log.
 *   · The newest line is at the top, always, including after a reload from disk
 *     where the file may have been edited by hand.
 */

import { LOG_CAPACITY, type LogEntry, type StationRef } from '../../shared/contracts';

/**
 * Write a line, or move the existing one for this station to the top.
 *
 * Returns the same array instance when nothing changed, so the caller can skip
 * a persist and a repaint on the ten-times-a-second engine tick that reports
 * the same station still playing.
 */
export function recordHeard(log: readonly LogEntry[], station: StationRef, at: number): LogEntry[] {
  const head = log[0];
  if (head && head.station.id === station.id) return log as LogEntry[];
  const rest = log.filter((entry) => entry.station.id !== station.id);
  return [{ station, heardAt: at }, ...rest].slice(0, LOG_CAPACITY);
}

/**
 * Put a log read off disk into a state the panel can trust: newest first, one
 * line per station, capped. The file is written by the app but it is still a
 * file, and a hand-edited one must not be able to produce a strip that lies
 * about the order things were heard in.
 */
export function normaliseLog(entries: readonly LogEntry[] | undefined): LogEntry[] {
  if (!entries?.length) return [];
  const seen = new Set<string>();
  const out: LogEntry[] = [];
  for (const entry of [...entries].sort((a, b) => b.heardAt - a.heardAt)) {
    if (!entry?.station?.id || seen.has(entry.station.id)) continue;
    seen.add(entry.station.id);
    out.push(entry);
    if (out.length >= LOG_CAPACITY) break;
  }
  return out;
}
