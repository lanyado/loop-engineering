import type { RouteChoice } from './types.js';

export const sameChoice = (a: RouteChoice, b: RouteChoice): boolean =>
  a.projectId === b.projectId &&
  a.target.kind === b.target.kind &&
  (a.target.kind === 'new' || (b.target.kind === 'session' && a.target.sessionId === b.target.sessionId));

/**
 * Pulls the JSON object out of a model's text answer: the whole text, or the span from the first
 * "{" to the last "}" (models sometimes wrap JSON in prose or a code fence). Undefined if none parses.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  for (const candidate of [trimmed, trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1)]) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}
