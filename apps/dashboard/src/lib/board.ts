import { newestFinishedFirst } from './format';
import type { PipelineView, PullRequest, Question, Rigor, TreeProject, TreeSession } from './schemas';

/** What the board draws lanes from: the pipeline, its stages, and the checks each rigor level runs. */
export type BoardPipeline = Pick<PipelineView, 'pipeline' | 'stages' | 'rigor'>;

/** The checks a session at `rigor` runs: the server's answer, else (an older server) the whole pipeline. */
export const rigorRuns = (view: BoardPipeline, rigor: Rigor): string[] =>
  view.rigor?.[rigor] ?? view.pipeline.checks;

/*
 * The one-screen board: every project, and in it every live session as a pipeline read left to right
 * (n8n style): Session → Builder → one lane per PR: the pipeline's checks in order (built-in: Tests →
 * CR → QA; custom stage files too) → Approval → Merge → Deploy, and the Deploy node also shows where
 * the lane ended (shipped/merged/…). Pure functions, unit tested; the page only renders what
 * buildBoard returns.
 */

/** The node after Deploy: the Production Guardian's check of the live site. It has no PR stage of its own. */
export const GUARDIAN_NODE = 'guardian';
/** A node's id: a check's stage id (tests, review, qa or a custom stage), or one of the fixed nodes. */
export type NodeStage = string;
/** Names of the fixed nodes; a check's name is its stage file's label. */
const FIXED_LABELS: Record<string, string> = {
  awaiting_approval: 'Approval',
  merge: 'Merge',
  deploying: 'Deploy',
  [GUARDIAN_NODE]: 'Guardian',
};

export type NodeState = 'todo' | 'current' | 'done' | 'failed' | 'halted';

export interface StageNode {
  stage: NodeStage;
  /** The node's name (a check's label, e.g. "CR") and icon. */
  label: string;
  icon: string;
  /** A custom stage (a stage file), not one of the built-in ones. */
  custom: boolean;
  /** A check whose stage file is missing or broken: the loop holds PRs here until it is fixed. */
  problem?: string;
  /** One of the pipeline's checks (not Approval, Merge, Deploy or Guardian). */
  check: boolean;
  /** The human skipped this check for the lane's PR. */
  skipped: boolean;
  /** The session's rigor does not run this check (the dial above the pipeline). */
  off: boolean;
  /** A check of a PR still in its checks: the human may skip it, or bring it back. */
  skippable: boolean;
  state: NodeState;
  questions: Question[];
}

/** Where a lane ended up, shown on the Deploy node. */
export interface LaneEnd {
  state: NodeState;
  label: string;
  questions: Question[];
}

export interface Lane {
  /** null: the placeholder lane of a git session that has not opened a PR yet. */
  pr: PullRequest | null;
  nodes: StageNode[];
  end: LaneEnd;
}

export type BuilderState = 'working' | 'paused' | 'done';

export interface Row {
  session: TreeSession;
  builder: { state: BuilderState; questions: Question[] };
  /** Open PRs, else the newest finished one, else (git projects) one empty placeholder lane. */
  lanes: Lane[];
  /** Finished PRs not drawn as a lane. */
  olderPrs: PullRequest[];
  pending: number;
}

export interface ProjectBoard {
  project: TreeProject;
  /** Live: a session that has not ended, or one whose PR is still in the loop or still asks. */
  rows: Row[];
  finished: TreeSession[];
  pending: number;
}

export interface Board {
  projects: ProjectBoard[];
  /** Pending questions no visible row shows (routing questions, a PR with no session), with who asked. */
  unplaced: { question: Question; asker: string }[];
}

/** The PR loop's own sessions ([loop] PR loop) only hold its questions: never a row of their own. */
export const LOOP_SESSION_TITLE = '[loop] PR loop';
const LOOP_SESSION_BRANCH = 'loop/pr-loop';
/** A daily-run alert belongs to no PR: it starts with this, so the unplaced list can name who asked. */
const GUARDIAN_QUESTION = 'Production Guardian';

/**
 * State of each node of `order` for a PR at `stage` (for a custom stage: its id, not "check"). The
 * loop runs the nodes in this order, so the ones before the current node are done.
 */
export function stageStates(
  stage: string,
  outcome: string | null = null,
  order: readonly string[],
): NodeState[] {
  const last = order.length - 1;
  // Merged where nothing deploys: the PR stays at "merge", which is done.
  if (stage === 'merge' && outcome === 'merged')
    return order.map((s) => (s === 'deploying' ? 'todo' : 'done'));
  // Closed by the human: the loop stopped wherever it was.
  if (outcome === 'closed') return order.map(() => 'halted');
  if (stage === 'deployed') return order.map(() => 'done');
  // Reverted PRs had merged and deployed: the deploy failed.
  if (stage === 'reverted') return order.map((_, i) => (i === last ? 'failed' : 'done'));
  // Escalated: the loop gave up on this PR. The stages it reached stay stopped, and the lane ends
  // red: its Deploy node carries the escalation, like a reverted lane's failure does.
  if (stage === 'escalated' || outcome === 'escalated')
    return order.map((_, i) => (i === last ? 'failed' : 'halted'));
  const index = order.indexOf(stage);
  // An unknown stage (one removed from the pipeline, which the loop moves past on its next step).
  if (index < 0) return order.map(() => 'halted');
  return order.map((_, i) => (i < index ? 'done' : i === index ? 'current' : 'todo'));
}

/** The node a PR is at: a custom stage's id for stage "check". */
const nodeOf = (pr: PullRequest) => (pr.stage === 'check' ? (pr.loopState.check ?? 'check') : pr.stage);

/**
 * A lane's nodes before Guardian: the pipeline's checks, Approval (not in auto-merge projects whose
 * PRs get a code review or run at rigor Fast, unless a PR waits there anyway), Merge, and Deploy (when
 * the pipeline watches deploys, or the PR got that far before it stopped). Checks the session's rigor
 * does not run stay in, drawn off.
 */
export function laneOrder(
  project: { autoMerge: boolean },
  view: BoardPipeline,
  pr: PullRequest | null,
  rigor: Rigor = 'standard',
): string[] {
  // A check with no stage file stays in: the loop holds PRs there until the file is back.
  const { checks } = view.pipeline;
  const reviewed = rigorRuns(view, rigor).includes('review') && !pr?.loopState.skip?.includes('review');
  // At Fast the human chose to merge on CI alone: only auto-merge being off asks them.
  const approval =
    !(project.autoMerge && (reviewed || rigor === 'fast')) || pr?.stage === 'awaiting_approval';
  const deployed = pr !== null && ['deploying', 'deployed', 'reverted'].includes(pr.stage);
  return [
    ...checks,
    ...(approval ? ['awaiting_approval'] : []),
    'merge',
    ...(view.pipeline.deploy || deployed ? ['deploying'] : []),
  ];
}

/**
 * The Guardian node: waits for a deploy, then follows the guardian's latest run for the PR (the loop
 * mirrors it into loopState.guardian). A run that could not execute reads as stopped, not as a failure.
 */
function guardianState(pr: PullRequest | null): NodeState {
  const run = pr?.loopState.guardian;
  if (!run) return 'todo';
  if (run.status === 'running') return 'current';
  if (run.status === 'passed') return 'done';
  if (run.status === 'failed') return 'failed';
  return 'halted';
}

function laneEnd(pr: PullRequest | null): Omit<LaneEnd, 'questions'> {
  if (!pr) return { state: 'todo', label: 'Shipped' };
  if (pr.stage === 'deployed') return { state: 'done', label: 'Deployed' };
  if (pr.stage === 'reverted') return { state: 'failed', label: 'Reverted' };
  if (pr.stage === 'escalated' || pr.outcome === 'escalated') return { state: 'failed', label: 'Escalated' };
  if (pr.outcome === 'closed') return { state: 'failed', label: 'Closed' };
  if (pr.outcome === 'merged') return { state: 'done', label: 'Merged' };
  return { state: 'todo', label: 'Shipped' };
}

/**
 * The node a loop question belongs on: an approval on Approval, a deploy problem on Deploy, an
 * escalation on the lane's end (the loop stopped and needs a decision).
 */
/** The node a loop question goes on, or "end" for the lane's end. */
function loopQuestionNode(kind: string, pr: PullRequest): string {
  if (kind === GUARDIAN_NODE) return GUARDIAN_NODE;
  if (kind === 'approval') return 'awaiting_approval';
  if (kind === 'deploy_timeout' || kind === 'revert_failed') return 'deploying';
  if (kind === 'escalation') return 'end';
  return nodeOf(pr);
}

function lane(
  project: TreeProject,
  view: BoardPipeline,
  rigor: Rigor,
  pr: PullRequest | null,
  loopQuestion?: Question,
): Lane {
  const order = laneOrder(project, view, pr, rigor);
  const runs = rigorRuns(view, rigor);
  const states = pr ? stageStates(nodeOf(pr), pr.outcome, order) : order.map((): NodeState => 'todo');
  const node = (stage: string, state: NodeState): StageNode => {
    const file = view.stages.find((s) => s.id === stage);
    const check = !(stage in FIXED_LABELS);
    const off = check && !runs.includes(stage);
    // A skipped or off check is not waited for, so its file's state does not matter to the PR.
    const skipped = check && (pr?.loopState.skip?.includes(stage) ?? false);
    const problem =
      !check || skipped || off ? undefined : !file ? 'no stage file' : file.error ? 'file broken' : undefined;
    return {
      stage,
      label: file?.label ?? FIXED_LABELS[stage] ?? stage,
      icon: file?.icon ?? stage,
      custom: file !== undefined && !file.builtin,
      ...(problem ? { problem } : {}),
      check,
      skipped,
      off,
      skippable: check && !off && pr !== null && pr.outcome === null && pr.stage !== 'escalated',
      state,
      questions: [],
    };
  };
  const nodes = order.map((stage, i) => node(stage, states[i]!));
  if (view.pipeline.guardian || pr?.loopState.guardian) nodes.push(node(GUARDIAN_NODE, guardianState(pr)));
  const end: LaneEnd = { ...laneEnd(pr), questions: [] };
  if (pr && loopQuestion) {
    const kind = pr.loopState.question?.id === loopQuestion.id ? pr.loopState.question.kind : GUARDIAN_NODE;
    const at = loopQuestionNode(kind, pr);
    // A node the lane does not draw (the pipeline changed under the PR): the lane's end carries it.
    (nodes.find((n) => n.stage === at) ?? end).questions.push(loopQuestion);
  }
  return { pr, nodes, end };
}

const laneQuestions = (l: Lane) => [...l.nodes.flatMap((n) => n.questions), ...l.end.questions];

/**
 * The builder works until it opens a PR, and again while it fixes the loop's feedback on an open PR.
 * Otherwise its part is done even though the session stays open for later messages.
 */
function builderState(status: string, open: PullRequest[]): BuilderState {
  if (status === 'ended') return 'done';
  if (status === 'paused') return 'paused';
  const prs = open.filter((pr) => pr.outcome === null);
  return prs.length === 0 || prs.some((pr) => pr.loopState.feedback) ? 'working' : 'done';
}

/** Still in the loop: no outcome yet, or merged and still deploying (the loop sets both at merge). */
const isOpen = (pr: PullRequest) => pr.outcome === null || pr.stage === 'deploying';

export function buildBoard(
  tree: TreeProject[],
  prs: PullRequest[],
  pending: Question[],
  view: BoardPipeline,
): Board {
  const pendingById = new Map(pending.map((q) => [q.id, q]));
  // A loop question names its PR (loopState.question); it goes on that PR's lane, not the builder.
  const loopQuestionOf = new Map<number, Question>();
  for (const pr of prs) {
    const id = pr.loopState.question?.id ?? pr.loopState.guardian?.questionId;
    const q = id === undefined ? undefined : pendingById.get(id);
    if (q) loopQuestionOf.set(pr.id, q);
  }
  const loopQuestionIds = new Set([...loopQuestionOf.values()].map((q) => q.id));
  const placed = new Set<number>();

  const projects = tree.map((project): ProjectBoard => {
    const projectPrs = prs.filter((pr) => pr.projectId === project.id);
    const rows: Row[] = [];
    const finished: TreeSession[] = [];
    for (const session of project.sessions) {
      if (session.title === LOOP_SESSION_TITLE && session.branch === LOOP_SESSION_BRANCH) continue;
      const sessionPrs = projectPrs
        .filter((pr) => pr.sessionId === session.id)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id - a.id);
      const asks = pending.filter((q) => q.sessionId === session.id && !loopQuestionIds.has(q.id));
      const open = sessionPrs.filter(isOpen);
      const live = session.status !== 'ended' || open.length > 0 || asks.length > 0;
      if (!live) {
        finished.push(session);
        continue;
      }
      // Oldest first, so lanes keep their place as their PRs move.
      const drawn = open.length > 0 ? [...open].sort((a, b) => a.id - b.id) : sessionPrs.slice(0, 1);
      const lanes = drawn.map((pr) => lane(project, view, session.rigor, pr, loopQuestionOf.get(pr.id)));
      if (lanes.length === 0 && project.kind === 'git') lanes.push(lane(project, view, session.rigor, null));
      const row: Row = {
        session,
        builder: {
          state: builderState(session.status, open),
          questions: asks,
        },
        lanes,
        olderPrs: sessionPrs.filter((pr) => !drawn.includes(pr)),
        pending: 0,
      };
      const questions = [...asks, ...lanes.flatMap(laneQuestions)];
      for (const q of questions) placed.add(q.id);
      row.pending = questions.length;
      rows.push(row);
    }
    // Rows that wait on you first, then working, then paused, then the rest; newest first within.
    const rank = (r: Row) =>
      r.pending > 0 ? 0 : r.builder.state === 'working' ? 1 : r.builder.state === 'paused' ? 2 : 3;
    rows.sort((a, b) => rank(a) - rank(b) || b.session.id - a.session.id);
    return {
      project,
      rows,
      finished: newestFinishedFirst(finished),
      pending: rows.reduce((n, r) => n + r.pending, 0),
    };
  });

  // Loop questions of PRs with no visible row (no session, or the loop's own session): own rows would
  // need a session, so they join the unplaced list with the routing questions.
  const unplaced = pending
    .filter((q) => !placed.has(q.id))
    .map((question) => {
      const pr = prs.find(
        (p) => p.loopState.question?.id === question.id || p.loopState.guardian?.questionId === question.id,
      );
      const project = tree.find((t) => t.id === pr?.projectId);
      const asker = pr
        ? `${project ? `${project.name} › ` : ''}${pr.repo}#${pr.number}`
        : question.text.startsWith(GUARDIAN_QUESTION)
          ? GUARDIAN_QUESTION
          : 'Router';
      return { question, asker };
    });
  // Projects that wait on you first, then ones with live work, then idle ones; else as listed.
  const rank = (p: ProjectBoard) => (p.pending > 0 ? 0 : p.rows.length > 0 ? 1 : 2);
  const order = new Map(projects.map((p, i) => [p.project.id, i]));
  projects.sort((a, b) => rank(a) - rank(b) || order.get(a.project.id)! - order.get(b.project.id)!);
  return { projects, unplaced };
}
