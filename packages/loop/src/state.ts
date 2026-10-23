import type { PullRequest } from '@loop-engineering/core';

/** Why the builder got feedback: review comments, failing tests/QA/CI, or a merge conflict. */
export type FeedbackKind = 'review' | 'tests' | 'qa' | 'ci' | 'conflict';

export interface Feedback {
  kind: FeedbackKind;
  items: string[];
  /** PR head the feedback is about; a push past it means the builder answered. */
  sha: string;
  /** When it reached the builder session; null until it did (the session may be paused). */
  sentAt: string | null;
}

export type QuestionKind = 'approval' | 'escalation' | 'deploy_timeout' | 'revert_failed';

/**
 * Where a PR is inside its stage (PullRequest.stage says which stage), persisted in
 * PullRequest.loopState after every transition so a restarted server carries on. Every field is
 * optional: a fresh row has {}. A type alias, not an interface, so it fits loopState's Record type.
 */
export type LoopState = {
  /** The PR's head branch. */
  branch?: string;
  /**
   * Heads that passed each gate. A merge needs the current head to equal all of them (and the
   * human's approvedSha when auto-merge is off); any other head goes back to review.
   */
  reviewedSha?: string;
  /** The CLI whose review approved reviewedSha; an OpenCode approval needs the human to merge. */
  reviewedBy?: 'claude' | 'opencode';
  testedSha?: string;
  /** Set by the tester; when true, qaSha must match too. */
  qaNeeded?: boolean;
  qaSha?: string;
  /** The head the human answered Merge for. */
  approvedSha?: string;
  /** PR head at merge time; cleanup deletes branches only while they still point at (or under) it. */
  mergedHeadSha?: string;
  /** The loop pushed tests the tester wrote, in some round. */
  testsAdded?: boolean;
  /** Waiting for the builder to push a fix. */
  feedback?: Feedback;
  /** Blocking items of the last review round, so the next reviewer checks they were fixed. */
  previous?: string[];
  /** Pending question to the human; `sha` is the head it was asked about. */
  question?: { kind: QuestionKind; id: number; sha?: string };
  /** Keys of PR comments the loop has posted, so a rerun never posts one twice. */
  posted?: string[];
  /** Review rounds allowed before escalating (5, plus 5 per "Continue"). */
  maxRounds?: number;
  /** Consecutive failed attempts of the current step (job crash, bad verdict, merge refused); reset on progress. */
  attempts?: number;
  lastError?: string;
  /** The head the loop's conflict fixer already tried; the builder gets the conflict after that. */
  conflictTriedSha?: string;
  /** Every model was at a limit: the job is not retried before this time (not a failed attempt). */
  retryAfter?: string;
  /** Consecutive waits for model limits; after LIMIT_WAITS_MIN runs out the human is asked. */
  limitWaits?: number;
  /** Consecutive waits for network errors (retryAfter holds the next try); cleared by the next success. */
  networkWaits?: number;
  /** infra: a job, merge or push kept failing; its error is not something the builder can fix. */
  escalation?: { reason: string; items: string[]; infra: boolean };
  /** The tester's reason for manual QA. */
  qaReason?: string;
  /** When the human answered Hold; the approval question is asked again after a while. */
  heldAt?: string;
  deployStartedAt?: string;
  deployFailure?: { summary: string };
  /** Set right before `gh pr revert`; with no revertPrNumber after a crash, the human is asked first. */
  revertRequested?: boolean;
  /** The revert PR the loop opened; the only PR it will merge as the revert. */
  revertPrNumber?: number;
  /** On a revert PR's row: the PR it reverts. The original's steps drive it. */
  revertOf?: number;
  /** The "[loop] Fix deploy failure" request created after a revert; a PR from its session gets fixesPrId. */
  fixRequestId?: number;
  cleanup?: {
    remoteBranch?: 'deleted' | 'gone' | 'moved' | 'kept';
    /** none: no session; kept: another PR of the session is still in the loop; paused: the PR was closed. */
    session?: 'ended' | 'stopped' | 'paused' | 'kept' | 'none';
    /** Per repo: what happened to the local branch. */
    localBranch?: Record<string, string>;
  };
  /**
   * The Production Guardian's latest run for this PR's deploy, mirrored here for the dashboard. Written
   * only once `done` is set, when the loop itself no longer touches the row.
   */
  guardian?: { runId: number; status: string; critical: boolean; summary: string; questionId?: number };
  /** Nothing left to do for this PR. */
  done?: boolean;
};

export const loopState = (pr: PullRequest): LoopState => pr.loopState;

/** Applies a patch; keys set to undefined are removed. */
export function patchState(state: LoopState, patch: Partial<LoopState>): LoopState {
  const next: Record<string, unknown> = { ...state, ...patch };
  for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
  return next;
}

/** Whether `head` passed review, tests and (when needed) QA. */
export function verifiedAt(s: LoopState, head: string): boolean {
  return s.reviewedSha === head && s.testedSha === head && (!s.qaNeeded || s.qaSha === head);
}
