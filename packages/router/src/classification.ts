import type { ClassifyInput, RouteChoice, RouteTarget } from './types.js';

export type Verdict =
  | { kind: 'confident'; choice: RouteChoice; confidence: number; reason: string | null }
  | {
      kind: 'unclear';
      /** Valid choices, most likely first (the classifier's own pick, then its candidates). */
      candidates: RouteChoice[];
      /** Why the router could not decide on its own; shown to the human as context. */
      why: string;
    };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

function parseTarget(v: unknown): RouteTarget | null {
  if (!isObject(v)) return null;
  if (v.kind === 'new') return { kind: 'new' };
  if (v.kind === 'session' && isId(v.sessionId)) return { kind: 'session', sessionId: v.sessionId };
  return null;
}

/** A choice naming an eligible project and, for a session target, one of that project's open sessions. */
function parseChoice(projectId: unknown, target: unknown, input: ClassifyInput): RouteChoice | null {
  const project = input.projects.find((p) => p.id === projectId);
  const parsed = parseTarget(target);
  if (!project || !parsed) return null;
  if (parsed.kind === 'session' && !project.sessions.some((s) => s.id === parsed.sessionId)) return null;
  return { projectId: project.id, target: parsed };
}

export const sameChoice = (a: RouteChoice, b: RouteChoice): boolean =>
  a.projectId === b.projectId &&
  a.target.kind === b.target.kind &&
  (a.target.kind === 'new' || (b.target.kind === 'session' && a.target.sessionId === b.target.sessionId));

/**
 * Checks a classifier's raw output against what it was shown. Defensive on purpose: the output comes
 * from a model, so anything that is not exactly the expected shape, or names a project or session
 * that is not eligible, counts as unclear rather than as a routing decision.
 */
export function validateClassification(raw: unknown, input: ClassifyInput, threshold: number): Verdict {
  if (!isObject(raw))
    return { kind: 'unclear', candidates: [], why: 'the classifier returned no JSON object' };
  const primary = parseChoice(raw.projectId, raw.target, input);
  const confidence =
    typeof raw.confidence === 'number' && raw.confidence >= 0 && raw.confidence <= 1 ? raw.confidence : null;
  const reason = typeof raw.reason === 'string' && raw.reason.trim() ? raw.reason.trim().slice(0, 300) : null;

  const ranked: { choice: RouteChoice; confidence: number }[] = [];
  if (Array.isArray(raw.candidates)) {
    for (const c of raw.candidates.slice(0, 20)) {
      if (!isObject(c)) continue;
      const choice = parseChoice(c.projectId, c.target, input);
      if (!choice) continue;
      const conf = typeof c.confidence === 'number' && Number.isFinite(c.confidence) ? c.confidence : 0;
      ranked.push({ choice, confidence: conf });
    }
  }
  ranked.sort((a, b) => b.confidence - a.confidence); // stable: ties keep the classifier's order
  const candidates: RouteChoice[] = [];
  for (const choice of [...(primary ? [primary] : []), ...ranked.map((r) => r.choice)]) {
    if (!candidates.some((c) => sameChoice(c, choice))) candidates.push(choice);
  }

  if (primary && confidence !== null && confidence >= threshold) {
    return { kind: 'confident', choice: primary, confidence, reason };
  }
  let why: string;
  if (raw.projectId === null) why = 'the classifier could not tell which project this is for';
  else if (!primary) why = 'the classifier named a project or session that is not open for direct input';
  else if (confidence === null) why = 'the classifier gave no valid confidence';
  else why = `the classifier is only ${Math.round(confidence * 100)}% sure`;
  return { kind: 'unclear', candidates, why: reason ? `${why} (${reason})` : why };
}

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
