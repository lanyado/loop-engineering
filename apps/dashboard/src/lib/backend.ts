import type {
  AnswerResult,
  ClaudeUsage,
  Project,
  PipelineView,
  PullRequest,
  Question,
  Settings,
  SettingsPatch,
  TaskRequest,
  Transcript,
  TreeProject,
} from './schemas';

/**
 * Everything the dashboard reads or changes. HttpBackend talks to the always-on server with
 * DASHBOARD_TOKEN; DemoBackend serves fixtures when no SERVER_URL is configured. Both run on the
 * dashboard's server only: the token never reaches the browser.
 */
export interface Backend {
  /** True for fixture data: every write is refused with ReadOnlyError. */
  readonly demo: boolean;
  pendingQuestions(): Promise<Question[]>;
  answer(questionId: number, answer: string): Promise<AnswerResult>;
  tree(): Promise<TreeProject[]>;
  updateProject(
    id: number,
    patch: Partial<Pick<Project, 'autoMerge' | 'markedForDirectInput' | 'permissionMode'>>,
  ): Promise<Project>;
  pullRequests(): Promise<PullRequest[]>;
  settings(): Promise<Settings>;
  updateSettings(patch: SettingsPatch): Promise<Settings>;
  createRequest(input: { text: string; projectId: number | null }): Promise<TaskRequest>;
  /** A message for one open session (the "+" on its node); the router delivers it there. */
  messageSession(sessionId: number, text: string): Promise<TaskRequest>;
  /** Claude Code's usage limits; null until the status line has saved them. */
  usage(): Promise<ClaudeUsage | null>;
  /** Since when the loop is paused because GitHub is unreachable (ISO); null while it is online. */
  offlineSince(): Promise<string | null>;
  /**
   * Ends a session through the server's runner: stops its agent and removes its worktrees (refused
   * while a git worktree has uncommitted changes). A folder session's files are never touched.
   */
  endSession(sessionId: number): Promise<{ id: number; status: string }>;
  /** Opens a terminal on the server's Mac showing the session's running agent. */
  openTerminal(sessionId: number): Promise<void>;
  /** Opens a terminal following a PR stage's job log (review, tests, QA or a custom stage). */
  openStageTerminal(prId: number, stage: string): Promise<void>;
  /** The PR loop's pipeline and its stages (stage files). */
  pipeline(): Promise<PipelineView>;
  /**
   * A finished session's stored transcript (its past conversation, redacted), or null when nothing
   * is stored yet.
   */
  sessionTranscript(sessionId: number): Promise<Transcript | null>;
  /** The server's SSE stream of question events, for the /api/events relay. */
  events(signal: AbortSignal): Promise<Response>;
}

export class ReadOnlyError extends Error {
  constructor() {
    super('Demo data is read-only. Connect a server (SERVER_URL) to make changes.');
    this.name = 'ReadOnlyError';
  }
}

/** The server answered with an error status; `message` is its error text when it sent one. */
export class BackendError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'BackendError';
  }
}
