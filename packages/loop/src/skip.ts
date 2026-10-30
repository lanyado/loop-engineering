import { ValidationError, type PullRequest, type Store } from '@loop-engineering/core';
import { stagesOf, type StageSource } from './stages.js';
import { loopState, patchState } from './state.js';

/**
 * The human skips a check of the pipeline for one PR, or takes the skip back. The loop counts a
 * skipped check as passed at every head of the PR (LoopState.skip); the engine drops a send-back of it
 * still waiting for the builder. A skipped code review still leaves the merge to the human. Only the
 * PR's row changes, so this works whether or not the loop runs; the loop acts on it next step.
 */
export function skipCheck(
  store: Store,
  source: StageSource,
  prId: number,
  check: string,
  skip: boolean,
): PullRequest {
  const pr = store.pullRequests.require(prId);
  const stages = stagesOf(source, store.projects.require(pr.projectId));
  if (pr.outcome !== null || pr.stage === 'escalated' || loopState(pr).revertOf !== undefined)
    throw new ValidationError(
      `PR ${pr.repo}#${pr.number} has left the loop's checks (merged, closed, escalated or a revert)`,
    );
  if (!stages.pipeline().checks.includes(check))
    throw new ValidationError(`"${check}" is not a check of the pipeline`);
  const s = loopState(pr);
  const others = (s.skip ?? []).filter((id) => id !== check);
  const updated = store.pullRequests.update(prId, {
    loopState: patchState(s, { skip: skip ? [...others, check] : others.length > 0 ? others : undefined }),
  });
  store.history.add({
    projectId: pr.projectId,
    sessionId: pr.sessionId,
    kind: 'decision',
    text: `PR ${pr.repo}#${pr.number}: the human ${skip ? 'skipped' : 'brought back'} ${stages.stage(check)?.title ?? check} (dashboard).`,
  });
  return updated;
}
