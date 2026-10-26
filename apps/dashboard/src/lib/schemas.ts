import * as z from 'zod';
import { layoutInput, layoutPatch } from './layout';

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

/**
 * The rigor dial (core's RIGOR_LEVELS): how much checking the PR loop gives a session's PRs, from
 * fast and cheap to slow and safe. Which checks each level runs comes from the server (the pipeline
 * view's `rigor`), never from here.
 */
export const RIGOR_LEVELS = ['fast', 'light', 'standard', 'thorough'] as const;
export type Rigor = (typeof RIGOR_LEVELS)[number];

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
  // Older servers have no dial (and so run the pipeline as it is); an unknown level reads the same.
  rigor: z.enum(RIGOR_LEVELS).catch('standard').default('standard'),
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
      /** With stage "check": the custom stage (a stage file) the PR is at. */
      check: z.string().optional().catch(undefined),
      /** The heads each check passed at, and the head that was merged: which checks really ran. */
      testedSha: z.string().optional().catch(undefined),
      reviewedSha: z.string().optional().catch(undefined),
      qaSha: z.string().optional().catch(undefined),
      passed: z.record(z.string(), z.string()).optional().catch(undefined),
      mergedHeadSha: z.string().optional().catch(undefined),
      /** The PR's round budget (5, plus 5 per "Continue"); older data has none. */
      maxRounds: z.number().optional().catch(undefined),
      /** Checks the human skipped for this PR. */
      skip: z.array(z.string()).optional().catch(undefined),
      feedback: z
        .object({
          kind: z.string(),
          /** kind "check": the custom stage that sent it. */
          stage: z.string().optional().catch(undefined),
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
  /** The dashboard's own layout (lib/layout.ts parses it). */
  dashboardLayout: z.record(z.string(), z.unknown()).default({}),
});
export type Settings = z.infer<typeof settingsSchema>;

/** A stage of the PR loop (GET /api/pipeline): a stage file's settings and prompt. */
export const stageSchema = z.object({
  id: z.string(),
  title: z.string(),
  label: z.string(),
  icon: z.string(),
  access: z.string(),
  runs: z.string(),
  prompt: z.string(),
  builtin: z.boolean(),
  overridden: z.boolean(),
  /** The stage's file does not parse; the loop holds PRs at it. */
  error: z.string().optional(),
});
export type Stage = z.infer<typeof stageSchema>;
/** The checks before merge in the order the loop runs them, and whether it watches deploys and runs the Guardian. */
export const pipelineSchema = z.object({
  checks: z.array(z.string()),
  deploy: z.boolean(),
  guardian: z.boolean(),
  /** pipeline.json cannot be read; the loop merges nothing. */
  error: z.string().optional(),
});
export type Pipeline = z.infer<typeof pipelineSchema>;
/** The values a stage may take and the ids it may not (the server's lists, for the editor). */
export const stageChoicesSchema = z.object({
  icons: z.array(z.string()),
  access: z.array(z.string()),
  runs: z.array(z.string()),
  reserved: z.array(z.string()),
});
export type StageChoices = z.infer<typeof stageChoicesSchema>;
/** The checks of the pipeline each rigor level runs (the loop's policy, computed by the server). */
export const rigorMapSchema = z.object({
  fast: z.array(z.string()),
  light: z.array(z.string()),
  standard: z.array(z.string()),
  thorough: z.array(z.string()),
});
export type RigorMap = z.infer<typeof rigorMapSchema>;
export const pipelineViewSchema = z.object({
  pipeline: pipelineSchema,
  stages: z.array(stageSchema),
  /** The Production Guardian's instructions (guardian.md): only its prompt is edited. */
  guardian: stageSchema,
  choices: stageChoicesSchema,
  /** Absent from older servers: then every level draws the whole pipeline. */
  rigor: rigorMapSchema.optional(),
});
export type PipelineView = z.infer<typeof pipelineViewSchema>;

/** Response envelopes, keyed by the route that returns them. */
export const responses = {
  questions: z.object({ questions: z.array(questionSchema) }),
  terminal: z.object({ opened: z.literal(true) }),
  answer: answerResultSchema,
  tree: z.object({ projects: z.array(treeProjectSchema) }),
  project: z.object({ project: projectSchema }),
  prs: z.object({ pullRequests: z.array(pullRequestSchema) }),
  settings: z.object({ settings: settingsSchema }),
  pipeline: pipelineViewSchema,
  skipped: z.object({ pullRequest: z.object({ id: z.number() }) }),
  usage: z.object({ usage: usageSchema.nullable() }),
  loopStatus: loopStatusSchema,
  request: z.object({ request: requestSchema }),
  session: z.object({ session: z.object({ id: z.number(), status: z.string() }) }),
  rigor: z.object({ session: z.object({ id: z.number(), rigor: z.enum(RIGOR_LEVELS) }) }),
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
export const rigorInput = z.object({ sessionId: z.number().int().positive(), rigor: z.enum(RIGOR_LEVELS) });
export const skipCheckInput = z.object({
  prId: z.number().int().positive(),
  check: z.string().min(1).max(32),
  skip: z.boolean(),
});
export const stageTerminalInput = z.object({
  prId: z.number().int().positive(),
  /** review, tests, qa or a custom stage's id; the server checks which. */
  stage: z.string().min(1).max(32),
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
  .number({ message: 'A channel user ID is a number' })
  .int('A channel user ID is a whole number')
  .positive('A channel user ID is positive')
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
    dashboardLayout: layoutInput,
  })
  .partial();
export type SettingsPatch = z.infer<typeof settingsInput>;

/** A pipeline edit for PUT /api/pipeline; the server checks ids, sizes and every rule. */
const stageInput = z.object({
  title: z.string().max(60),
  label: z.string().max(10),
  icon: z.string().max(20),
  access: z.string().max(20),
  runs: z.string().max(20),
  prompt: z.string().max(4000),
});
export const pipelineUpdateInput = z.object({
  pipeline: z.object({
    checks: z.array(z.string().max(32)).max(12),
    deploy: z.boolean(),
    guardian: z.boolean(),
  }),
  stages: z.record(z.string().max(32), stageInput.nullable()).optional(),
});
export type PipelineUpdate = z.infer<typeof pipelineUpdateInput>;
/** What the editor's Save sends: the layout, and the pipeline when it changed. */
export const editsInput = z.object({ layout: layoutPatch, pipeline: pipelineUpdateInput.optional() });
export const hideProjectInput = z.object({ projectId: z.number().int().positive(), hidden: z.boolean() });
