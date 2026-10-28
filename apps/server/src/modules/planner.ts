import { resolveSessionId } from '@loop-engineering/ask-human';
import type { CallToolResult } from '@modelcontextprotocol/server';
import {
  AGENT_ID,
  BUILDER_AGENT,
  effortFor,
  isModelName,
  MODEL_ALIASES,
  MODEL_NAME_MAX,
  RIGOR_LEVELS,
  type Session,
} from '@loop-engineering/core';
import type { StageLibrary } from '@loop-engineering/loop';
import * as z from 'zod';
import type { ServerModule } from '../context.js';

export const SUBMIT_PLAN_TOOL = 'submit_plan';
export const PLAN_MAX = 8_000;
export const RIGOR_REASON_MAX = 200;
export const MODELS_REASON_MAX = 200;
/** Time for submit_plan's answer to reach the agent before its builder is relaunched. */
const RELAUNCH_DELAY_MS = 3_000;

const DESCRIPTION = `Record your plan for the current task, once it is ready and before you change anything: the goal, the approach, the files to change, the tests and the risks. The human sees it on the dashboard's Planner node. Also judge the rigor level for this work (fast, light, standard or thorough) and give one short sentence why; the human can override it any time. Also choose the model of the builder and of each check (tests, review, qa, or a custom stage's id) in models, with one short sentence why in modelsReason: a stronger model for hard or risky work, a lighter one for trivial edits; a stronger reviewer where mistakes are costly or hard to spot; a lighter tester; the stronger model when unsure. Submitting again replaces the plan (do so for each new task). Then build it.`;

const modelName = z
  .string()
  .trim()
  .refine(
    isModelName,
    `a model name: letters, digits and . - _ / : (${MODEL_NAME_MAX} characters at most), not starting with a dash`,
  );

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
  models: z
    .record(z.string().regex(AGENT_ID), modelName)
    .optional()
    .describe(
      `The model per agent: builder, tests, review, qa, or a custom stage's id, each ${MODEL_ALIASES.join(', ')} or a full model name. Ignored for an agent whose model the human chose. Leave an agent out to keep the default.`,
    ),
  modelsReason: z
    .string()
    .trim()
    .max(MODELS_REASON_MAX)
    .optional()
    .describe(`One short sentence on why those models (${MODELS_REASON_MAX} characters at most).`),
});

export interface PlannerOptions {
  /** The pipeline: agent ids of checks that are not in it are ignored. Without it, any well-formed id is kept. */
  stages?: StageLibrary;
  relaunchDelayMs?: number;
  log?: (message: string) => void;
}

/** Whether the live builder runs differently from what the plan chose: its model or its effort. */
const builderChanged = (before: Session, after: Session): boolean =>
  after.provider === 'claude' &&
  ((after.models[BUILDER_AGENT]?.model ?? after.model) !==
    (before.models[BUILDER_AGENT]?.model ?? before.model) ||
    effortFor(before.rigor, before.effort) !== effortFor(after.rigor, after.effort));

const errorResult = (text: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text }] });

/**
 * The submit_plan tool on /mcp: the session agent's Planner phase ends with it (its instructions say
 * so, see packages/runner/src/instructions.ts). The session comes only from the connection's
 * X-Loop-Session-Id, never from arguments, so an agent can only plan for itself.
 */
export function plannerModule(options: PlannerOptions = {}): ServerModule {
  const log = options.log ?? ((m: string) => console.warn(`[planner] ${m}`));
  return {
    name: 'planner',
    mcp(server, connection, ctx) {
      server.registerTool(
        SUBMIT_PLAN_TOOL,
        { title: 'Submit the plan', description: DESCRIPTION, inputSchema },
        ({ plan, rigor, rigorReason, models, modelsReason }): CallToolResult => {
          const resolved = resolveSessionId(connection.sessionHeader);
          if ('error' in resolved) return errorResult(resolved.error);
          // An ended session's token is refused before any tool runs.
          if (!ctx.store.sessions.get(resolved.sessionId))
            return errorResult(`session ${resolved.sessionId} does not exist`);
          const pick = rigor ? { rigor, reason: rigorReason || null } : undefined;
          const before = ctx.store.sessions.require(resolved.sessionId);
          const known = options.stages
            ? new Set([BUILDER_AGENT, 'conflict', ...options.stages.pipeline().checks])
            : null;
          const picks = Object.entries(models ?? {}).filter(([agent]) => !known || known.has(agent));
          const unknown = Object.keys(models ?? {}).filter((agent) => known && !known.has(agent));
          const session = ctx.store.sessions.setPlan(
            resolved.sessionId,
            plan,
            pick,
            models ? { models: Object.fromEntries(picks), reason: modelsReason || null } : undefined,
          );
          if (pick && session.rigorSource === 'planner' && session.rigor !== before.rigor)
            ctx.store.history.add({
              projectId: session.projectId,
              sessionId: session.id,
              kind: 'decision',
              text: `Planner chose ${rigor}${pick.reason ? `: ${pick.reason}` : ''} for session ${session.id}'s rigor.`,
            });
          const chosen = picks.filter(([agent, model]) => session.models[agent]?.model === model);
          const humans = picks.filter(([agent]) => session.models[agent]?.by === 'human').map(([a]) => a);
          if (models && chosen.some(([agent]) => session.models[agent]?.by === 'planner'))
            ctx.store.history.add({
              projectId: session.projectId,
              sessionId: session.id,
              kind: 'decision',
              text: `Planner chose models for session ${session.id}: ${chosen
                .filter(([agent]) => session.models[agent]?.by === 'planner')
                .map(([agent, model]) => `${agent} ${model}`)
                .join(', ')}${session.modelsReason ? `: ${session.modelsReason}` : ''}.`,
            });
          ctx.bus.emit({ type: 'session.planned', session });
          // The model flag is fixed while a process runs: restart the builder so the plan's pick applies now.
          if (session.status === 'active' && ctx.runner && builderChanged(before, session)) {
            const runner = ctx.runner;
            ctx.timers.setTimeout(() => {
              runner
                .relaunch(
                  session.id,
                  'your plan set a new model or effort for you; continue building the plan',
                )
                .catch((err: unknown) => log(`relaunching session ${session.id} failed: ${String(err)}`));
            }, options.relaunchDelayMs ?? RELAUNCH_DELAY_MS);
          }
          const note = [
            pick && session.rigorSource === 'human'
              ? `The human chose rigor ${session.rigor}; it stays.`
              : '',
            humans.length > 0
              ? `The human chose the model for ${humans.join(', ')}; ${humans.length > 1 ? 'they stay' : 'it stays'}.`
              : '',
            unknown.length > 0 ? `Ignored agents not in the pipeline: ${unknown.join(', ')}.` : '',
          ].filter(Boolean);
          return {
            content: [{ type: 'text', text: ['Plan recorded.', ...note, 'Now build it.'].join(' ') }],
          };
        },
      );
    },
  };
}
