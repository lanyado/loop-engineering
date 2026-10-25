/** ISO-8601 UTC timestamp, e.g. "2026-10-18T09:00:00.000Z". */
export type Iso = string;

export const SESSION_STATUSES = ['active', 'paused', 'ended'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** agent_exited: the agent process or its tmux window went away without the runner stopping it. */
export const PAUSE_REASONS = ['manual', 'usage_limit', 'agent_exited'] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];

/** runner: started by the session runner. import: a past Claude Code conversation imported as ended. */
export const SESSION_SOURCES = ['runner', 'import'] as const;
export type SessionSource = (typeof SESSION_SOURCES)[number];

export const PROVIDERS = ['claude', 'opencode'] as const;
export type Provider = (typeof PROVIDERS)[number];

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

/**
 * Claude Code permission modes (`claude --help`, --permission-mode). "manual" asks before every edit
 * or command; "auto" lets Claude's safety classifier approve routine actions. bypassPermissions is
 * never a default: a project has to select it explicitly.
 */
export const PERMISSION_MODES = [
  'auto',
  'manual',
  'acceptEdits',
  'plan',
  'dontAsk',
  'bypassPermissions',
] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];
/** Default for new projects; pending a human decision, so it is kept in this one place. */
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'auto';

/**
 * git: one or more repos; every session gets its own branch and worktree per repo, and its PRs go
 * through the PR loop. folder: one plain folder (no git needed); the agent edits it in place, one
 * session at a time, with no branch, worktree or PR.
 */
export const PROJECT_KINDS = ['git', 'folder'] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number];

export const SUBAGENT_STATUSES = ['running', 'waiting', 'done', 'failed'] as const;
export type SubagentStatus = (typeof SUBAGENT_STATUSES)[number];

export const QUESTION_STATUSES = ['pending', 'answered', 'defaulted'] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

export const ANSWER_CHANNELS = ['telegram', 'dashboard', 'email', 'timeout'] as const;
export type AnswerChannel = (typeof ANSWER_CHANNELS)[number];
/** Channels a human can answer through; "timeout" is set only by the store. */
export type HumanChannel = Exclude<AnswerChannel, 'timeout'>;

export const REQUEST_SOURCES = ['telegram', 'dashboard', 'email'] as const;
export type RequestSource = (typeof REQUEST_SOURCES)[number];

/**
 * Where a PR is in the loop. check: a custom stage from a stage file (loopState.check names it).
 * awaiting_approval: every check passed, auto-merge is off, waiting for the human. merge: merging now.
 * deploying: merged, watching the Vercel deploy. reverted/escalated mirror the terminal outcomes so
 * the pipeline view can show them in place.
 */
export const PR_STAGES = [
  'review',
  'tests',
  'qa',
  'check',
  'awaiting_approval',
  'merge',
  'deploying',
  'deployed',
  'reverted',
  'escalated',
] as const;
export type PrStage = (typeof PR_STAGES)[number];

export const PR_OUTCOMES = ['merged', 'reverted', 'escalated', 'closed'] as const;
export type PrOutcome = (typeof PR_OUTCOMES)[number];

export const HISTORY_KINDS = ['transcript', 'decision'] as const;
export type HistoryKind = (typeof HISTORY_KINDS)[number];

/** A question with no human answer by its deadline falls back to its recommended option. */
export const QUESTION_TIMEOUT_MS = 15 * 60 * 1000;

export interface Settings {
  /** Model main sessions run on (the strongest); a Claude alias or full model name. */
  sessionModel: string;
  /** Model used when Claude usage runs out. */
  fallbackModel: string;
  /**
   * OpenCode models to move to, in order, when an OpenCode session hits a limit, errors or hangs on
   * its current one (after the last, back to fallbackModel).
   */
  opencodeBackupModels: string[];
  /** Telegram user IDs allowed to talk to the bot besides the owner (TELEGRAM_OWNER_ID). */
  telegramAllowlist: number[];
  /** Agent CLIs the loop may use; at least one is on. Both on: Claude, with OpenCode as the fallback. */
  claudeEnabled: boolean;
  opencodeEnabled: boolean;
  /** The dashboard's layout (its top bar, row details, project order). The dashboard defines what is in it. */
  dashboardLayout: Record<string, unknown>;
}

/**
 * The provider to use when `wanted` is preferred: `wanted` if it is switched on, else the other one.
 * Claude is the default preference (OpenCode is the fallback).
 */
export function enabledProvider(
  settings: Pick<Settings, 'claudeEnabled' | 'opencodeEnabled'>,
  wanted: 'claude' | 'opencode' = 'claude',
): 'claude' | 'opencode' {
  const on = { claude: settings.claudeEnabled, opencode: settings.opencodeEnabled };
  return on[wanted] ? wanted : wanted === 'claude' ? 'opencode' : 'claude';
}

export interface Repo {
  /** Unique within the project; sessions, env files and PRs refer to the repo by this name. */
  name: string;
  /** Local checkout path on the Mac. */
  path: string;
  /** Git remote URL. */
  remote: string;
  defaultBranch: string;
  vercelProject?: string;
  /**
   * The live site the Production Guardian checks after each deploy and once a day. Without it the
   * repo is not guarded: the guardian never guesses a URL to test.
   */
  productionUrl?: string;
}

/** A local env file copied into a session's worktree of `repo`. */
export interface EnvFile {
  repo: string;
  /** Absolute path of the file on the Mac. */
  source: string;
  /** Path relative to the worktree root, e.g. ".env.local". */
  target: string;
}

export interface Project {
  id: number;
  name: string;
  kind: ProjectKind;
  /** Absolute, symlink-free path of a folder project's folder; null for git projects. */
  folderPath: string | null;
  /** Always empty for a folder project. */
  repos: Repo[];
  /** Always empty for a folder project. */
  envFiles: EnvFile[];
  /** Meaningless for a folder project (it has no PRs); stored as given. */
  autoMerge: boolean;
  markedForDirectInput: boolean;
  /** Permission mode the project's agents are launched with. */
  permissionMode: PermissionMode;
  createdAt: Iso;
}

export interface Worktree {
  repo: string;
  path: string;
}

export interface Session {
  id: number;
  projectId: number;
  title: string;
  status: SessionStatus;
  /** Set exactly when status is "paused", so automatic resumes only touch sessions they paused. */
  pauseReason: PauseReason | null;
  provider: Provider;
  model: string;
  /** Claude --effort the session was started with; reused on resume. */
  effort: Effort | null;
  /** tmux target ("session:window.pane") while running. */
  tmuxTarget: string | null;
  /** Claude Code / OpenCode conversation id, for resuming (`claude --resume`). */
  agentSessionId: string | null;
  /** One branch name, used in every repo's worktree. Empty for a folder project's session. */
  branch: string;
  /** Empty for a folder project's session: its agent works in Project.folderPath. */
  worktrees: Worktree[];
  /** "import" for a past conversation brought in by the session importer (always ended). */
  source: SessionSource;
  createdAt: Iso;
  endedAt: Iso | null;
}

export interface Subagent {
  id: number;
  sessionId: number;
  /** The agent CLI's own id when the runner found it there (OpenCode child sessions); else null. */
  externalId: string | null;
  title: string;
  model: string;
  effort: Effort;
  status: SubagentStatus;
  createdAt: Iso;
}

export interface Question {
  id: number;
  sessionId: number;
  /** Null when the session itself asks. */
  subagentId: number | null;
  text: string;
  /** Background the asker gave to help the human answer; null when none. */
  context: string | null;
  options: string[];
  /** One of `options`; becomes the answer when the deadline passes. */
  recommendedOption: string;
  status: QuestionStatus;
  answer: string | null;
  answeredVia: AnswerChannel | null;
  createdAt: Iso;
  deadline: Iso;
  answeredAt: Iso | null;
  /** When the outcome was handed to the asking agent; null while pending or if it never was. */
  deliveredAt: Iso | null;
  /** The request a routing question is about (the router's questions); null for agent questions. */
  requestId: number | null;
}

/**
 * Where a part's own task ends in its request text (the rest is the whole request, for context).
 * Reviewers and testers judge a part's PR on the text before it.
 */
export const REQUEST_PART_MARKER = '\n\n---\nThis is part ';

/** A part's own task: its request text up to REQUEST_PART_MARKER (the whole text for any other request). */
export function ownTask(text: string): string {
  const at = text.indexOf(REQUEST_PART_MARKER);
  return at < 0 ? text : text.slice(0, at);
}

/** A task the human sent (Telegram, dashboard or email). The reviewer checks PRs against its text. */
export interface Request {
  id: number;
  /** Project the router picked; null until routed (a Telegram task arrives without one). */
  projectId: number | null;
  /** Session the router delivered it to; null until routed. */
  sessionId: number | null;
  /** Session the human addressed it to (dashboard "+" on a session); the router delivers it there. */
  targetSessionId: number | null;
  /** The request this one is a part of (the router split it); null for the human's own requests. */
  parentRequestId: number | null;
  text: string;
  source: RequestSource;
  createdAt: Iso;
}

export interface PullRequest {
  id: number;
  projectId: number;
  /** Session whose building agent owns the PR, if known. */
  sessionId: number | null;
  /** The request this PR implements, if known. */
  requestId: number | null;
  /** Repo name within the project. */
  repo: string;
  number: number;
  url: string;
  stage: PrStage;
  /** Review rounds so far (the loop escalates after 5). The only place rounds are counted. */
  round: number;
  /** Null while the PR is still in the loop. */
  outcome: PrOutcome | null;
  /** Set once merged; the deploy-failure revert reverts this commit. */
  mergeCommitSha: string | null;
  /** The PR that reverted this one after a failed deploy. */
  revertedByPrId: number | null;
  /** For a follow-up PR: the reverted PR whose change it redoes. */
  fixesPrId: number | null;
  /**
   * The PR loop's own progress inside the current stage (JSON object, owned by packages/loop). Empty
   * until the loop works on the PR.
   */
  loopState: Record<string, unknown>;
  createdAt: Iso;
  updatedAt: Iso;
}

export interface LoopMetrics {
  prId: number;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  /** Read from PullRequest.round; not stored separately. */
  rounds: number;
  /** Failed test or QA runs that sent the PR back to the building agent. */
  failures: number;
}

export interface HistoryEntry {
  id: number;
  projectId: number;
  sessionId: number | null;
  kind: HistoryKind;
  text: string;
  createdAt: Iso;
}

export interface HistorySearchHit extends HistoryEntry {
  /** Matching excerpt with hits wrapped in [ and ]. */
  snippet: string;
  /** bm25 score; lower is more relevant. Results come sorted by it. */
  rank: number;
}

/** What started a Production Guardian run: a PR's deploy finished, or the once-a-day regression run. */
export const GUARDIAN_TRIGGERS = ['deploy', 'daily'] as const;
export type GuardianTrigger = (typeof GUARDIAN_TRIGGERS)[number];

/** The four checks of a run: backend endpoints, critical user flows, speed and errors, external services. */
export const GUARDIAN_AREAS = ['api', 'ui', 'performance', 'integrations'] as const;
export type GuardianArea = (typeof GUARDIAN_AREAS)[number];

/**
 * error: the guardian itself could not run (agent crash, no checkout); says nothing about production.
 * skipped: the network was down; nothing was checked, and the run is repeated once it is back.
 */
export const GUARDIAN_STATUSES = ['running', 'passed', 'failed', 'error', 'skipped'] as const;
export type GuardianStatus = (typeof GUARDIAN_STATUSES)[number];

/** What one area found, after its single retry. */
export interface GuardianAreaResult {
  area: GuardianArea;
  passed: boolean;
  /** The failure takes down something users need (checkout, login, the site itself). */
  critical: boolean;
  /** Failures seen on the last attempt, one line each. */
  failures: string[];
  /** The area failed once and passed when retried: noise, not a failure. */
  flaky: boolean;
  /** The check could not run (agent crash, timeout): it says nothing about production. */
  errored: boolean;
  /** The network was down: nothing was checked, and the whole run is skipped. */
  offline?: boolean;
}

export interface GuardianRun {
  id: number;
  projectId: number;
  repo: string;
  trigger: GuardianTrigger;
  /** The PR whose deploy it verifies (trigger "deploy"); null for a daily run. */
  prId: number | null;
  status: GuardianStatus;
  /** Some failed area is critical. */
  critical: boolean;
  /** One line for the dashboard and the fix task. */
  summary: string;
  areas: GuardianAreaResult[];
  /** The AI's reading of the failures: probable cause and where to look. Empty when nothing failed. */
  diagnosis: string;
  /** Folder with the logs and screenshots collected on failure; null when none. */
  evidenceDir: string | null;
  /** The "[loop] Production Guardian" fix task created for the failure, if any. */
  requestId: number | null;
  createdAt: Iso;
  finishedAt: Iso | null;
}

/**
 * An email conversation with a requester (the email channel): clarifying the task, then, once the
 * plan was sent and its request created, building it (questions and release notes go to it).
 */
export const EMAIL_THREAD_STATES = ['clarifying', 'building'] as const;
export type EmailThreadState = (typeof EMAIL_THREAD_STATES)[number];

export interface EmailThread {
  id: number;
  /** The address that started it; every reply goes to it. */
  sender: string;
  subject: string;
  state: EmailThreadState;
  /** The request created from the plan; null while clarifying. */
  requestId: number | null;
  /** The mail provider's own thread id (Gmail's X-GM-THRID), when it has one. */
  mailThreadId: string | null;
  createdAt: Iso;
  updatedAt: Iso;
}

export interface EmailMessage {
  id: number;
  threadId: number;
  /** Its RFC 5322 Message-ID, as in a reply's In-Reply-To. */
  messageId: string;
  direction: 'in' | 'out';
  /** What it said (an incoming reply without the quoted mail). */
  text: string;
  /** An outgoing question. */
  questionId: number | null;
  /** An outgoing release note for this PR. */
  prId: number | null;
  createdAt: Iso;
}
