import { resolveSessionId } from '@loop-engineering/ask-human';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { RIGOR_LEVELS } from '@loop-engineering/core';
import * as z from 'zod';
import type { ServerModule } from '../context.js';

export const SUBMIT_PLAN_TOOL = 'submit_plan';
export const PLAN_MAX = 8_000;
export const RIGOR_REASON_MAX = 200;

const DESCRIPTION = `Record your plan for the current task, once it is ready and before you change anything: the goal, the approach, the files to change, the tests and the risks. The human sees it on the dashboard's Planner node. Also judge the rigor level for this work (fast, light, standard or thorough) and give one short sentence why; the human can override it any time. Submitting again replaces the plan (do so for each new task). Then build it.`;

const inputSchema = z.object({
  plan: z
    .string()
    .trim()
    .min(1)
    .max(PLAN_MAX)
    .describe(`The plan, in plain text or Markdown (${PLAN_MAX} characters at most).`),
  rigor: z
    .enum(RIGOR_LEVELS)
    .optional()
    .describe(
      'How much effort the pull request gets: fast, light, standard or thorough. Ignored when the human has chosen a level. Leave it out only to keep the current one.',
    ),
  rigorReason: z
    .string()
    .trim()
    .max(RIGOR_REASON_MAX)
    .optional()
    .describe(`One short sentence on why that level (${RIGOR_REASON_MAX} characters at most).`),
});

const errorResult = (text: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text }] });

/**
 * The submit_plan tool on /mcp: the session agent's Planner phase ends with it (its instructions say
 * so, see packages/runner/src/instructions.ts). The session comes only from the connection's
 * X-Loop-Session-Id, never from arguments, so an agent can only plan for itself.
 */
export function plannerModule(): ServerModule {
  return {
    name: 'planner',
    mcp(server, connection, ctx) {
      server.registerTool(
        SUBMIT_PLAN_TOOL,
        { title: 'Submit the plan', description: DESCRIPTION, inputSchema },
        ({ plan, rigor, rigorReason }): CallToolResult => {
          const resolved = resolveSessionId(connection.sessionHeader);
          if ('error' in resolved) return errorResult(resolved.error);
          // An ended session's token is refused before any tool runs.
          if (!ctx.store.sessions.get(resolved.sessionId))
            return errorResult(`session ${resolved.sessionId} does not exist`);
          const pick = rigor ? { rigor, reason: rigorReason ?? '' } : undefined;
          const session = ctx.store.sessions.setPlan(resolved.sessionId, plan, pick);
          ctx.bus.emit({ type: 'session.planned', session });
          const kept =
            pick && session.rigorSource === 'human'
              ? ` The human chose rigor ${session.rigor}; it stays.`
              : '';
          return { content: [{ type: 'text', text: `Plan recorded.${kept} Now build it.` }] };
        },
      );
    },
  };
}
