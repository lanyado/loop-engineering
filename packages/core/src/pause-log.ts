import { PAUSE_REASONS, type PauseReason } from './types.js';

/*
 * Every time a session is paused or resumed, SessionRepo.update writes one `decision` history
 * entry in these words. The sessions table keeps only the current pause, so these entries are the
 * only record of when a session was paused, why, and for how long (`loop retro` adds them up).
 */

/** The entry for a session that was paused, or whose pause reason changed while paused. */
export const pausedText = (sessionId: number, reason: PauseReason, was?: PauseReason): string =>
  `Session ${sessionId} paused (${reason})${was ? `, was ${was}` : ''}.`;

/** The entry for a paused session that ends without running again. */
export const endedPausedText = (sessionId: number, reason: PauseReason): string =>
  `Session ${sessionId} ended during a pause (${reason}).`;

/** The entry for a paused session that runs again. */
export const resumedText = (sessionId: number, reason: PauseReason): string =>
  `Session ${sessionId} resumed after a pause (${reason}).`;

const REASONS = PAUSE_REASONS.join('|');
const PAUSED = new RegExp(`^Session (\\d+) paused \\((${REASONS})\\)`);
const RESUMED = new RegExp(`^Session (\\d+) (?:resumed after|ended during) a pause \\((${REASONS})\\)`);

export type PauseLogEvent =
  | { kind: 'paused'; sessionId: number; reason: PauseReason }
  | { kind: 'resumed'; sessionId: number; reason: PauseReason };

/** Reads a pause log entry back (an end during a pause closes it like a resume); null for any other text. */
export function parsePauseLog(text: string): PauseLogEvent | null {
  const paused = PAUSED.exec(text);
  if (paused) return { kind: 'paused', sessionId: Number(paused[1]), reason: paused[2] as PauseReason };
  const resumed = RESUMED.exec(text);
  if (resumed) return { kind: 'resumed', sessionId: Number(resumed[1]), reason: resumed[2] as PauseReason };
  return null;
}
