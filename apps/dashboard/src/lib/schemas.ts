import * as z from 'zod';

/*
 * Wire types for the always-on server's /api (apps/server). The dashboard is deployed on its own
 * (Vercel uploads only apps/dashboard), so it cannot import @loop-engineering/core; instead every
 * response is parsed with these schemas. http-backend.test.ts runs them against the real server, so
 * drift fails a test. Enum-like fields that later milestones may extend (pause reasons, stages) are
 * plain strings here: an unknown value is shown as-is instead of breaking the page.
 */

const iso = z.string();

export const questionSchema = z.object({
  id: z.number(),
  sessionId: z.number(),
  subagentId: z.number().nullable(),
  text: z.string(),
  context: z.string().nullable(),
  options: z.array(z.string()),
  recommendedOption: z.string(),
  status: z.string(),
  answer: z.string().nullable(),
  answeredVia: z.string().nullable(),
  createdAt: iso,
  deadline: iso,
  answeredAt: iso.nullable(),
});
export type Question = z.infer<typeof questionSchema>;

export const answerResultSchema = z.object({ accepted: z.boolean(), question: questionSchema });
export type AnswerResult = z.infer<typeof answerResultSchema>;

export const projectSchema = z.object({
  id: z.number(),
  name: z.string(),
  // Defaults keep older servers (before folder projects) readable.
  kind: z.enum(['git', 'folder']).default('git'),
  folderPath: z.string().nullable().default(null),
  repos: z.array(z.object({ name: z.string() })),
  autoMerge: z.boolean(),
  markedForDirectInput: z.boolean(),
  permissionMode: z.string(),
  createdAt: iso,
});
export type Project = z.infer<typeof projectSchema>;

export const subagentSchema = z.object({
  id: z.number(),
  sessionId: z.number(),
  title: z.string(),
  model: z.string(),
  effort: z.string(),
  status: z.string(),
  createdAt: iso,
});
export type Subagent = z.infer<typeof subagentSchema>;

export const transcriptSchema = z.object({ createdAt: iso, text: z.string() });
export type Transcript = z.infer<typeof transcriptSchema>;

export const treeSessionSchema = z.object({
  id: z.number(),
  projectId: z.number(),
  title: z.string(),
  status: z.string(),
  pauseReason: z.string().nullable(),
  provider: z.string(),
  model: z.string(),
  effort: z.string().nullable(),
  branch: z.string(),
  // "import": a past Claude Code conversation brought in by the importer. Older servers send none.
  source: z.string().default('runner'),
  createdAt: iso,
  endedAt: iso.nullable(),
  pendingQuestions: z.number(),
  subagents: z.array(subagentSchema),
});
export type TreeSession = z.infer<typeof treeSessionSchema>;

export const treeProjectSchema = projectSchema.extend({ sessions: z.array(treeSessionSchema) });
export type TreeProject = z.infer<typeof treeProjectSchema>;

export const requestSchema = z.object({
  id: z.number(),
  projectId: z.number().nullable(),
  sessionId: z.number().nullable(),
  targetSessionId: z.number().nullable().default(null),
  text: z.string(),
  source: z.string(),
  createdAt: iso,
});
export type TaskRequest = z.infer<typeof requestSchema>;

export const metricsSchema = z.object({
  prId: z.number(),
  costUsd: z.number(),
  tokensIn: z.number(),
  tokensOut: z.number(),
  rounds: z.number(),
  failures: z.number(),
});
export type Metrics = z.infer<typeof metricsSchema>;

export const pullRequestSchema = z.object({
  id: z.number(),
  projectId: z.number(),
  sessionId: z.number().nullable(),
  requestId: z.number().nullable(),
  repo: z.string(),
  number: z.number(),
  url: z.string(),
  stage: z.string(),
  round: z.number(),
  outcome: z.string().nullable(),
  /**
   * The loop's own state (packages/loop). Only the pending question (to show it on the right node)
   * and whether the builder has feedback to fix are read; anything unexpected reads as absent.
   */
  loopState: z
    .object({
      question: z.object({ kind: z.string(), id: z.number() }).optional().catch(undefined),
      /**
       * Problems a stage sent back to the builder (packages/loop's Feedback): the kind says which
       * step sent them, items are its comments/bugs, sentAt when they reached the builder session.
       * Older data (and .catch) may carry only the kind.
       */
      /**
       * The Production Guardian's latest run for this PR's deploy (packages/loop): status is
       * running, passed, failed, error or skipped (offline); questionId is the critical-failure alert, if one was raised.
       */
      guardian: z
        .object({
          runId: z.number(),
          status: z.string(),
          critical: z.boolean().catch(false),
          summary: z.string().catch(''),
          questionId: z.number().optional().catch(undefined),
        })
        .optional()
        .catch(undefined),
      feedback: z
        .object({
          kind: z.string(),
          items: z.array(z.string()).catch([]),
          sentAt: z.string().nullable().catch(null),
        })
        .optional()
        .catch(undefined),
    })
    .catch({})
    .default({}),
  createdAt: iso,
  updatedAt: iso,
  request: requestSchema.nullable(),
  metrics: metricsSchema,
});
export type PullRequest = z.infer<typeof pullRequestSchema>;

const usageWindowSchema = z.object({ usedPercentage: z.number(), resetsAt: iso });
export type UsageWindow = z.infer<typeof usageWindowSchema>;
/** Claude Code's 5-hour and weekly limits (GET /api/usage); null until the status line saved them. */
export const usageSchema = z.object({
  capturedAt: iso,
  fiveHour: usageWindowSchema.nullable(),
  sevenDay: usageWindowSchema.nullable(),
});
export type ClaudeUsage = z.infer<typeof usageSchema>;

/** GET /api/loop/status: only what the dashboard shows, the time GitHub became unreachable. */
const loopStatusSchema = z.object({ offlineSince: iso.nullable().default(null) });

export const settingsSchema = z.object({
  sessionModel: z.string(),
  fallbackModel: z.string(),
  telegramAllowlist: z.array(z.number()),
  claudeEnabled: z.boolean().default(true),
  opencodeEnabled: z.boolean().default(true),
  opencodeBackupModels: z.array(z.string()).default([]),
});
export type Settings = z.infer<typeof settingsSchema>;

/** Response envelopes, keyed by the route that returns them. */
export const responses = {
  questions: z.object({ questions: z.array(questionSchema) }),
  terminal: z.object({ opened: z.literal(true) }),
  answer: answerResultSchema,
  tree: z.object({ projects: z.array(treeProjectSchema) }),
  project: z.object({ project: projectSchema }),
  prs: z.object({ pullRequests: z.array(pullRequestSchema) }),
  settings: z.object({ settings: settingsSchema }),
  usage: z.object({ usage: usageSchema.nullable() }),
  loopStatus: loopStatusSchema,
  request: z.object({ request: requestSchema }),
  session: z.object({ session: z.object({ id: z.number(), status: z.string() }) }),
  transcript: z.object({ transcript: transcriptSchema.nullable() }),
  error: z.object({ error: z.string() }),
};

// Inputs the dashboard sends. The server validates again; these keep junk from leaving the page.
export const LIMITS = { answer: 2000, request: 4000, model: 200, allowlist: 200 } as const;

export const answerInput = z.object({
  questionId: z.number().int().positive(),
  answer: z.string().trim().min(1, 'Type an answer').max(LIMITS.answer),
});
export const projectToggleInput = z.object({
  projectId: z.number().int().positive(),
  field: z.enum(['autoMerge', 'markedForDirectInput']),
  value: z.boolean(),
});
/**
 * Core's PERMISSION_MODES minus bypassPermissions: that one can only be set locally, never from the
 * dashboard (the server refuses it too).
 */
export const SELECTABLE_PERMISSION_MODES = ['auto', 'manual', 'acceptEdits', 'plan', 'dontAsk'] as const;
export const permissionModeInput = z.object({
  projectId: z.number().int().positive(),
  permissionMode: z.enum(SELECTABLE_PERMISSION_MODES),
});
export const endSessionInput = z.object({ sessionId: z.number().int().positive() });
export const stageTerminalInput = z.object({
  prId: z.number().int().positive(),
  stage: z.enum(['review', 'tests', 'qa']),
});
export const newRequestInput = z.object({
  text: z.string().trim().min(1, 'Describe the task').max(LIMITS.request),
  projectId: z.number().int().positive().nullable(),
});
export const sessionMessageInput = z.object({
  sessionId: z.number().int().positive(),
  text: z.string().trim().min(1, 'Write a message').max(LIMITS.request),
});
export const telegramId = z.coerce
  .number({ message: 'A Telegram user ID is a number' })
  .int('A Telegram user ID is a whole number')
  .positive('A Telegram user ID is positive')
  .max(Number.MAX_SAFE_INTEGER);
export const settingsInput = z
  .object({
    sessionModel: z.string().trim().min(1, 'Name a model').max(LIMITS.model),
    fallbackModel: z.string().trim().min(1, 'Name a model').max(LIMITS.model),
    telegramAllowlist: z.array(telegramId).max(LIMITS.allowlist),
    claudeEnabled: z.boolean(),
    opencodeEnabled: z.boolean(),
    opencodeBackupModels: z
      .array(z.string().trim().min(1).max(LIMITS.model).regex(/^\S+$/, 'One model name per line'))
      .max(10),
  })
  .partial();
export type SettingsPatch = z.infer<typeof settingsInput>;
