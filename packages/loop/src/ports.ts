// Every external effect of the loop sits behind one of these interfaces; fakes.ts has a fake for each.
import type { QuestionService } from '@loop-engineering/ask-human';
import type { EnvFile, Provider, Repo, Request } from '@loop-engineering/core';
import type { HeadlessResult, SessionRunner } from '@loop-engineering/runner';

/** A repo as GitHub (`gh -R <slug>`) and the local checkout (`path`) know it. */
export interface RepoRef {
  /** "owner/name"; for a remote that is not on GitHub, the remote itself. */
  slug: string;
  /** Local checkout; gh and git run there. */
  path: string;
}

export interface GhPr {
  number: number;
  url: string;
  title: string;
  body: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  /** The head lives in a fork. The loop only accepts same-repo PRs. */
  isCrossRepository: boolean;
  /** Set once merged. */
  mergeCommitSha: string | null;
}

export interface GhComment {
  author: string;
  body: string;
  createdAt: string;
  /** Inline review comments only. */
  path?: string | null;
  line?: number | null;
}

/** `gh pr checks --json bucket` values. */
export type CheckBucket = 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel';

export interface GhCheck {
  name: string;
  bucket: CheckBucket;
  link?: string;
}

/** GitHub, through the `gh` CLI (GhCli). */
export interface GitHub {
  /** One cheap call to GitHub (`gh api rate_limit`); rejects with the network error while it is unreachable. */
  ping(): Promise<void>;
  /** The newest PR whose head is `branch`, preferring an open one; null when there is none. */
  findPrForBranch(repo: RepoRef, branch: string): Promise<GhPr | null>;
  getPr(repo: RepoRef, number: number): Promise<GhPr>;
  diff(repo: RepoRef, number: number): Promise<string>;
  /** Conversation comments, review bodies and inline review comments, oldest first. */
  listComments(repo: RepoRef, number: number): Promise<GhComment[]>;
  postComment(repo: RepoRef, number: number, body: string): Promise<void>;
  /** CI checks on the PR's head; empty when none are reported. */
  checks(repo: RepoRef, number: number): Promise<GhCheck[]>;
  /** Squash-merges, only if the head is still `headSha`. */
  mergeSquash(repo: RepoRef, number: number, headSha: string): Promise<void>;
  closePr(repo: RepoRef, number: number, comment: string): Promise<void>;
  /**
   * Opens a PR reverting merged PR `number` (`gh pr revert`). The loop records the number it gets back
   * and only ever merges that PR; it never looks a revert up by searching.
   */
  createRevertPr(repo: RepoRef, number: number, text: { title: string; body: string }): Promise<GhPr>;
}

export type DeployState = 'pending' | 'success' | 'failure' | 'not_found';

export interface DeployStatus {
  state: DeployState;
  /** Deployment page / logs, when the provider reports them. */
  url?: string | null;
  logUrl?: string | null;
  description?: string | null;
  environment?: string | null;
}

/** Status of the deploy of a commit (GhDeployments: Vercel's GitHub deployment statuses). */
export interface Deployments {
  status(repo: RepoRef, sha: string, vercelProject: string): Promise<DeployStatus>;
}

/** A custom stage's job (a stage file): "check-" plus the stage's id. */
export type CheckJobKind = `check-${string}`;
export type JobKind = 'review' | 'tests' | 'qa' | 'conflict' | 'guardian' | CheckJobKind;
/** The jobs of a PR's own stages; the Production Guardian's jobs belong to no PR. */
export type PrJobKind = Exclude<JobKind, 'guardian'>;
/** What chooses a job's CLI (LoopConfig.stageProviders): every custom stage shares "check". */
export type StageJobKind = 'review' | 'tests' | 'qa' | 'conflict' | 'check';
export const stageJobKind = (kind: PrJobKind): StageJobKind =>
  kind.startsWith('check-') ? 'check' : (kind as StageJobKind);
/** The job a pipeline check runs: the built-ins have their own kind, a custom stage "check-<id>". */
export const checkJobKind = (check: string): PrJobKind =>
  check === 'tests' || check === 'review' || check === 'qa' ? check : `check-${check}`;

/** What a headless agent job may do. Mapped to Claude's tool flags and to OpenCode permissions alike. */
export interface JobRights {
  /** Edit and write files. */
  edit: boolean;
  /** Every shell command, or only commands starting with one of these prefixes ([] = no shell). */
  bash: 'all' | readonly string[];
  /** With bash "all": command prefixes that stay denied (gh, git push, deploy tools). */
  denyCommands?: readonly string[];
  /** The Playwright MCP server (headless browser) for QA. */
  playwright: boolean;
  web: boolean;
}

export interface AgentJob {
  kind: JobKind;
  provider: Provider;
  model: string;
  cwd: string;
  prompt: string;
  systemPrompt: string;
  rights: JobRights;
  /** Where the job's output is streamed as it runs, for the dashboard's stage terminal. */
  logFile?: string;
}

/** The agent's final answer and usage. */
export type AgentJobResult = HeadlessResult;

/** Runs one headless agent job to completion. Aborting `signal` kills it (the loop's job timeout). */
export interface AgentLauncher {
  run(job: AgentJob, signal: AbortSignal): Promise<AgentJobResult>;
}

export type RemoteBranchResult = 'deleted' | 'gone' | 'moved';
export type LocalBranchResult = 'deleted' | 'gone' | 'kept';
export type PushResult =
  { status: 'none' } | { status: 'rejected'; reason: string } | { status: 'pushed'; sha: string };

/** Git, as the loop itself (the user's credentials): job checkouts, the tester's commits, branch cleanup. */
export interface Workspace {
  /**
   * A fresh detached checkout of `sha` (fetched from the remote's `branch`; a ref that fetch updates,
   * like "refs/remotes/origin/<branch>", works too) at a folder named `name`,
   * with the project's env files for the repo copied in and kept out of git. Returns its path.
   */
  checkout(input: {
    repo: Repo;
    branch: string;
    sha: string;
    name: string;
    envFiles: EnvFile[];
  }): Promise<string>;
  remove(repo: Repo, path: string): Promise<void>;
  /** Whether commit `sha` is reachable from `ref` in the local repo (false when either is unknown). */
  isAncestor(repo: Repo, sha: string, ref: string): Promise<boolean>;
  /**
   * Commits whatever a job left in its checkout (as the loop) and pushes it to `branch`, only if the
   * remote branch is still at `baseSha` (--force-with-lease). "none" when nothing changed.
   */
  commitAndPush(
    repo: Repo,
    path: string,
    input: { branch: string; baseSha: string; message: string },
  ): Promise<PushResult>;
  /** Deletes the remote branch only while it still points at `expectedSha` (--force-with-lease). */
  deleteRemoteBranch(repo: Repo, branch: string, expectedSha: string): Promise<RemoteBranchResult>;
  /**
   * Deletes the local branch only if every commit on it is in `mergedHeadSha` (the PR head that was
   * merged) and no worktree has it checked out; otherwise keeps it.
   */
  deleteLocalBranch(repo: Repo, branch: string, mergedHeadSha: string): Promise<LocalBranchResult>;
}

/**
 * The runner methods the loop uses (the server's one SessionRunner). It never starts sessions: the
 * router does, from the requests the loop creates.
 */
export type LoopRunner = Pick<SessionRunner, 'deliverFile' | 'end' | 'stop' | 'pause'>;

/** The QuestionService method the loop uses, so questions reach Telegram and the dashboard. */
export type Asker = Pick<QuestionService, 'ask'>;

/** Records a new request (the deploy-fix task); the server passes its shared createRequest helper. */
export type CreateRequest = (input: { projectId: number; text: string }) => Request;
