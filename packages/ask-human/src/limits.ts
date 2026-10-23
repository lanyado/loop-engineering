/**
 * Size caps that bound what an agent can send a human. They do not make a question fit one
 * Telegram message (4096 characters): question + context + options can exceed it, and splitting or
 * truncating for display is the channel's job (M4). QuestionService enforces the caps for every
 * caller; the tool schema and the REST API advertise them.
 */
export const QUESTION_LIMITS = {
  question: 3000,
  option: 200,
  options: 10,
  context: 2000,
  answer: 2000,
} as const;

/** Header the runner sets on each session's MCP connection (Claude `.mcp.json`, OpenCode config). */
export const SESSION_HEADER = 'X-Loop-Session-Id';

export type SessionIdResolution = { sessionId: number } | { error: string };

/**
 * Picks the session a question belongs to: the X-Loop-Session-Id header the runner sets on every
 * session's MCP connection (agents are not told their id). It is required; a `sessionId` argument
 * may only confirm it.
 */
export function resolveSessionId(header: string | null | undefined, input?: number): SessionIdResolution {
  const raw = header?.trim();
  if (raw) {
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
      return { error: `the ${SESSION_HEADER} header must be a positive integer, got "${raw}"` };
    }
    const fromHeader = Number(raw);
    if (input !== undefined && input !== fromHeader) {
      return {
        error: `sessionId ${input} does not match this connection's ${SESSION_HEADER} (${fromHeader}); omit sessionId`,
      };
    }
    return { sessionId: fromHeader };
  }
  return {
    error: `this MCP connection has no ${SESSION_HEADER} header, so the question has no session; the runner sets it in the session's MCP config`,
  };
}
