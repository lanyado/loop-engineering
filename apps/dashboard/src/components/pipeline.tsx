import type { CSSProperties, ReactNode } from 'react';
import {
  PLANNER_NODE,
  type Lane,
  type NodeStage,
  type NodeState,
  type Row,
  type StageNode,
} from '../lib/board';
import { formatAgo, formatPrMetrics, humanize, pauseLabel, roundLabel, sessionRuntime } from '../lib/format';
import { shows, type RowDetail } from '../lib/layout';
import { agentModel, type ModelDefaults } from '../lib/models';
import type { PullRequest, Question, TreeSession } from '../lib/schemas';
import { EndSessionButton } from './end-session-button';
import { ModelTag } from './model-tag';
import { QuestionCard } from './question-card';
import { RigorDial } from './rigor-dial';
import { SkipCheck, SkipDetail, SkipState } from './skip-check';
import {
  DetailsButton,
  DoubleClickTerminal,
  FeedbackButton,
  MessageButton,
  SessionRowShell,
  TerminalButton,
  type TerminalTarget,
} from './session-controls';

/* Inline 24px stroke icons (no icon library): one per fixed node, and the set a stage file picks from. */
const ICON_PATHS: Record<string, ReactNode> = {
  planner: (
    <>
      <path d="M9 4H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2" />
      <rect x="9" y="2.5" width="6" height="3.5" rx="1" />
      <path d="M9 11h6M9 15h4" />
    </>
  ),
  builder: (
    <>
      <path d="m8 7-5 5 5 5M16 7l5 5-5 5M13.5 4l-3 16" />
    </>
  ),
  review: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="m20 20-4.5-4.5M8.5 11l1.8 1.8 3.2-3.6" />
    </>
  ),
  tests: (
    <>
      <path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3" />
      <path d="M7.5 15h9" />
    </>
  ),
  qa: (
    <>
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 21h8M12 17v4M8 10.5l2.5 2.5L16 8" />
    </>
  ),
  awaiting_approval: (
    <>
      <circle cx="10" cy="8" r="4" />
      <path d="M3 20a7 7 0 0 1 11-5.7M15 18l2 2 4-4" />
    </>
  ),
  merge: (
    <>
      <circle cx="6" cy="5" r="2.2" />
      <circle cx="6" cy="19" r="2.2" />
      <circle cx="18" cy="12" r="2.2" />
      <path d="M6 7.2v9.6M6 7.2c0 3 3 4.8 9.8 4.8" />
    </>
  ),
  deploying: (
    <>
      <path d="M12 15c-2 0-3-1-3-3 0-4 3-8 7-9 0 4-1 8-4 12ZM9 12l-3 1-2 3 4 1M12 15l-1 3-3 2-1-4" />
    </>
  ),
  guardian: (
    <>
      <path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  end: (
    <>
      <path d="M5 21V4M5 4h11l-2 4 2 4H5" />
    </>
  ),
  // The icons a custom stage may pick (the server's list).
  shield: (
    <>
      <path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Z" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  bug: (
    <>
      <rect x="7" y="8" width="10" height="12" rx="5" />
      <path d="M12 12v8M3 13h4M17 13h4M4 7l3 2M20 7l-3 2M4 19l3-2M20 19l-3-2M9 5l1.5 2M15 5l-1.5 2" />
    </>
  ),
  book: (
    <>
      <path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5Z" />
      <path d="M4 19a2 2 0 0 1 2-2h13" />
    </>
  ),
  gauge: (
    <>
      <path d="M3.5 17a9 9 0 1 1 17 0" />
      <path d="m12 14 4-5" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9Z" />
    </>
  ),
  sparkle: (
    <>
      <path d="M12 3c.6 4.2 2.8 6.4 7 7-4.2.6-6.4 2.8-7 7-.6-4.2-2.8-6.4-7-7 4.2-.6 6.4-2.8 7-7ZM19 17l.5 2 2 .5-2 .5-.5 2-.5-2-2-.5 2-.5.5-2Z" />
    </>
  ),
  check: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
};

export function Icon({ kind }: { kind: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICON_PATHS[kind] ?? ICON_PATHS.check}
    </svg>
  );
}

// Completed stages show no word at all: the green tile already says it.
const STATE_WORDS: Record<NodeState, string> = {
  todo: 'not yet',
  current: 'running',
  done: '',
  failed: 'failed',
  halted: 'stopped',
};

const questionAnchor = (q: Question) => `q-${q.id}`;

/** What the loop calls each kind of send-back, in the feedback panel. */
const FEEDBACK_LABELS: Record<string, string> = {
  review: 'review comments',
  tests: 'test failures',
  qa: 'QA failures',
  ci: 'CI failures',
  conflict: 'merge conflict',
};

/** The same, abbreviated, for the Builder node's chip. */
const FEEDBACK_SHORT: Record<string, string> = {
  review: 'CR',
  tests: 'Tests',
  qa: 'QA',
  ci: 'CI',
  conflict: 'Merge',
};

interface LaneFeedback {
  pr: PullRequest;
  kind: string;
  /** What sent it, for the panel and the chip: a custom stage's label, else the kind's name. */
  label: string;
  short: string;
  items: string[];
  sentAt: string | null;
}

/** The lane node each kind of send-back comes from (a CI failure or a conflict surfaces at Merge). */
const FEEDBACK_ORIGIN: Record<string, NodeStage> = {
  review: 'review',
  tests: 'tests',
  qa: 'qa',
  ci: 'merge',
  conflict: 'merge',
};
const feedbackOrigin = (f: { kind: string; stage?: string | undefined }) =>
  f.kind === 'check' ? (f.stage ?? '') : FEEDBACK_ORIGIN[f.kind];

/** The comments/bugs each drawn lane's stage sent back to the builder (and no fix pushed yet). */
const laneFeedbacks = (lanes: Lane[]): LaneFeedback[] =>
  lanes.flatMap((lane): LaneFeedback[] => {
    const f = lane.pr?.loopState.feedback;
    if (!lane.pr || !f) return [];
    const custom = f.kind === 'check' ? lane.nodes.find((n) => n.stage === f.stage)?.label : undefined;
    return [
      {
        pr: lane.pr,
        kind: f.kind,
        label: custom ? `${custom} failures` : (FEEDBACK_LABELS[f.kind] ?? f.kind),
        short: custom ?? FEEDBACK_SHORT[f.kind] ?? f.kind,
        items: f.items,
        sentAt: f.sentAt,
      },
    ];
  });

/** Lane tiles are 88px wide with 16px edges between them (see .lane .node and .lane .edge in globals.css). */
const TILE_W = 88;
const TILE_PITCH = TILE_W + 16;

/**
 * The way back: a dashed amber line under the lane, from the stage that sent work back to the
 * Builder, ending in an arrow at the lane's start. Its pill (how many items) opens the details.
 */
function ReturnPath({ short, count, from }: { short: string; count: number; from: number }) {
  const label = `${short} · ${count} back`;
  return (
    <span
      className="lane-return"
      style={{ '--ret-x': `${from * TILE_PITCH + TILE_W / 2}px` } as CSSProperties}
      data-testid="return-path"
    >
      <FeedbackButton label={label} className="node-feedback return-pill" testId="return-path-toggle" />
    </span>
  );
}

/** "1 question" chip; the questions themselves are right under the row. */
function AskBadge({ questions }: { questions: Question[] }) {
  if (questions.length === 0) return null;
  return (
    <span className="node-ask" data-testid="node-ask">
      {questions.length} question{questions.length === 1 ? '' : 's'}
    </span>
  );
}

function Node({
  kind,
  state,
  title,
  detail,
  questions = [],
  chip,
  testId = 'node',
  stage,
  notRun = false,
  model,
  children,
}: {
  kind: keyof typeof ICON_PATHS;
  state: NodeState | 'waiting';
  title: string;
  detail?: ReactNode;
  questions?: Question[];
  /** A control on its own line under the detail (the feedback chip), never beside the actions. */
  chip?: ReactNode;
  testId?: string;
  stage?: string;
  /** The check never ran at the merged head: drawn dimmed. */
  notRun?: boolean;
  /** The model caption on the node's top edge (an agent's node). */
  model?: ReactNode;
  children?: ReactNode;
}) {
  const shown = questions.length > 0 ? 'waiting' : state;
  return (
    <div
      className={`node node-${shown} node-${kind}${notRun ? ' node-not-run' : ''}`}
      data-testid={testId}
      data-stage={stage ?? kind}
      data-state={shown}
      data-not-run={notRun || undefined}
    >
      {model}
      <span className="node-icon">
        <Icon kind={kind} />
      </span>
      <span className="node-body">
        <span className="node-title" title={title}>
          {title}
        </span>
        {/* A word gets its span here; an element (SkipDetail) draws its own, or nothing. */}
        {typeof detail === 'string' ? detail && <span className="node-detail">{detail}</span> : detail}
        <AskBadge questions={questions} />
        {chip}
      </span>
      {children}
    </div>
  );
}

function Edge({ state }: { state: NodeState }) {
  return <span className={`edge edge-${state}`} aria-hidden="true" />;
}

/** The edge into a node is lit when the node has started. */
const edgeInto = (state: NodeState): NodeState =>
  state === 'todo' ? 'todo' : state === 'halted' ? 'halted' : 'done';

/** What a lane node shows in its detail: who it waits on, else the plain state word. */
const nodeDetail = (node: StageNode): string =>
  node.questions.length > 0
    ? 'waiting on you'
    : node.notRun
      ? 'not run'
      : (node.problem ?? (node.skipped ? 'skipped' : STATE_WORDS[node.state]));

/** The deploy node also carries where the lane ended: shipped, merged, or how it stopped. */
function deployDetail(node: StageNode, lane: Lane): string {
  if (node.questions.length > 0) return 'waiting on you';
  if (node.state === 'current') return nodeDetail(node);
  const pr = lane.pr;
  if (lane.end.state === 'failed') return lane.end.label.toLowerCase(); // reverted/escalated/closed
  if (pr?.stage === 'deployed') return 'shipped';
  if (pr?.outcome === 'merged') return 'merged';
  return nodeDetail(node);
}

/** The Guardian node says what the last production check found, else the plain state word. */
function guardianDetail(node: StageNode, lane: Lane): string {
  if (node.questions.length > 0) return 'waiting on you';
  const run = lane.pr?.loopState.guardian;
  if (run?.status === 'passed') return 'healthy';
  if (run?.status === 'failed') return run.critical ? 'critical' : 'failing';
  if (run?.status === 'error') return 'could not run';
  if (run?.status === 'skipped') return 'skipped: offline';
  return nodeDetail(node);
}

/**
 * Stages whose agent job has a terminal (its log): review, tests, QA and custom stages, once they have
 * run.
 */
const JOB_STAGES = new Set<NodeStage>(['review', 'tests', 'qa']);
function stageTerminal(lane: Lane, node: StageNode): TerminalTarget | null {
  if (!lane.pr || !(node.custom || JOB_STAGES.has(node.stage)) || node.state === 'todo') return null;
  return { kind: 'stage', prId: lane.pr.id, stage: node.stage };
}

/** A node that opens its terminal on double-click, with a ">_" button for it. */
function WithTerminal({
  target,
  readOnly,
  children,
}: {
  target: TerminalTarget | null;
  readOnly: boolean;
  children: (button: ReactNode) => ReactNode;
}) {
  if (!target) return <>{children(null)}</>;
  return (
    <DoubleClickTerminal target={target} readOnly={readOnly}>
      {children(
        <span className="node-actions">
          <TerminalButton target={target} readOnly={readOnly} />
        </span>,
      )}
    </DoubleClickTerminal>
  );
}

/** One step of a lane as drawn: a node, or (in the editor) something to add. */
export interface LaneStep {
  key: string;
  /** Lights the edge into it. */
  state: NodeState;
  content: ReactNode;
}

/**
 * The editor's hooks into a row: the parts the layout can hide get their "−" (or "+" when hidden),
 * and it lays out each lane's steps itself, so the pipeline is edited where it is drawn.
 */
export interface RowEdit {
  part: (detail: RowDetail, content: ReactNode) => ReactNode;
  /** The Planner node: tapping it edits its instructions. */
  planner: (node: ReactNode) => ReactNode;
  /** `node` draws a node as the board does, without its buttons; `detail` replaces its state word. */
  lane: (lane: Lane, node: (node: StageNode, detail?: string) => ReactNode, first: boolean) => LaneStep[];
}

function LaneView({
  lane,
  first,
  session,
  models,
  part,
  edit,
  readOnly,
}: {
  lane: Lane;
  first: boolean;
  /** The session: its rigor (Light has its own round cap) and the models its agents use. */
  session: TreeSession;
  models: ModelDefaults | undefined;
  part: RowEdit['part'];
  edit: RowEdit | undefined;
  readOnly: boolean;
}) {
  const pr = lane.pr;
  const rigor = session.rigor;
  // The board already left out what this pipeline does not run (Approval in auto-merge projects, …).
  const nodes = lane.nodes;
  const feedback = pr?.loopState.feedback;
  // The way back is drawn by node position, which the editor's own steps would shift.
  const origin = feedback && !edit ? nodes.findIndex((n) => n.stage === feedbackOrigin(feedback)) : -1;
  const back = laneFeedbacks([lane])[0];
  const node = (node: StageNode, buttons: boolean, detail?: string) => {
    // Skip / Run again flips the node before the server answers (SkipState holds that until then).
    const skipFor = buttons && node.skippable ? pr : null;
    return (
      <WithTerminal target={buttons ? stageTerminal(lane, node) : null} readOnly={readOnly}>
        {(button) => {
          const drawn = (
            <Node
              kind={node.icon}
              stage={node.stage}
              state={node.state}
              notRun={node.notRun}
              model={
                models && (node.custom || JOB_STAGES.has(node.stage)) ? (
                  <ModelTag
                    sessionId={session.id}
                    agent={node.stage}
                    label={node.label}
                    view={agentModel(session, node.stage, models)}
                    allowed={models.allowed}
                    locked={readOnly || !buttons || session.status === 'ended'}
                  />
                ) : undefined
              }
              title={node.label}
              detail={
                detail ??
                (node.stage === 'deploying' ? (
                  deployDetail(node, lane)
                ) : node.stage === 'guardian' ? (
                  guardianDetail(node, lane)
                ) : skipFor ? (
                  <SkipDetail
                    skipped={nodeDetail({ ...node, skipped: true })}
                    unskipped={nodeDetail({ ...node, skipped: false })}
                  />
                ) : (
                  nodeDetail(node)
                ))
              }
              questions={
                node.stage === 'deploying' ? [...node.questions, ...lane.end.questions] : node.questions
              }
              chip={
                skipFor ? (
                  <SkipCheck
                    prId={skipFor.id}
                    pr={`${skipFor.repo}#${skipFor.number}`}
                    check={node.stage}
                    label={node.label}
                    readOnly={readOnly}
                  />
                ) : undefined
              }
            >
              {button}
            </Node>
          );
          return skipFor ? <SkipState skipped={node.skipped}>{drawn}</SkipState> : drawn;
        }}
      </WithTerminal>
    );
  };
  const steps: LaneStep[] = edit
    ? edit.lane(lane, (n, detail) => node(n, false, detail), first)
    : nodes.map((n) => ({ key: n.stage, state: n.state, content: node(n, true) }));
  return (
    <li
      className={`lane${origin >= 0 ? ' has-return' : ''}`}
      data-testid="lane"
      data-pr-number={pr?.number ?? ''}
    >
      <span className="lane-label">
        {pr && (
          <>
            <a
              href={pr.url}
              target="_blank"
              rel="noreferrer"
              className="mono"
              data-testid="lane-pr"
              inert={edit !== undefined}
            >
              {pr.repo}#{pr.number}
            </a>
            {pr.outcome === null && (
              <span className="muted">{roundLabel(pr.round, pr.loopState.maxRounds, rigor)}</span>
            )}
            {part(
              'prMetrics',
              <span className="muted lane-metrics" data-testid="pr-metrics">
                {formatPrMetrics(pr.metrics)}
              </span>,
            )}
          </>
        )}
      </span>
      <span className="lane-flow" data-sort-area={edit ? true : undefined}>
        {feedback && back && origin >= 0 && (
          <ReturnPath short={back.short} count={Math.max(feedback.items.length, 1)} from={origin} />
        )}
        {steps.map((step, i) => (
          <span key={step.key} className="lane-step">
            {i > 0 && <Edge state={edgeInto(step.state)} />}
            {step.content}
          </span>
        ))}
      </span>
    </li>
  );
}

/** The Planner's plan for the newest task it planned, with when it came. */
function PlanSection({ session, planning, now }: { session: TreeSession; planning: boolean; now: number }) {
  return (
    <section className="plan" data-testid="session-plan" aria-label="Plan">
      <h4 className="plan-head">
        Plan
        {session.plannedAt && <span className="muted small"> · {formatAgo(session.plannedAt, now)}</span>}
        {planning && session.plan && <span className="muted small"> · a newer task is being planned</span>}
      </h4>
      {session.plan ? (
        <pre className="plan-text" data-testid="session-plan-text">
          {session.plan}
        </pre>
      ) : (
        <p className="muted small">
          {planning ? 'Planning: the plan shows here once it is ready.' : 'No plan was recorded.'}
        </p>
      )}
      {session.rigorSource !== 'default' && (
        <p className="muted small" data-testid="session-rigor-source">
          {session.rigorSource === 'human'
            ? 'Rigor set by you'
            : `Rigor set by the Planner${session.rigorReason ? `: ${session.rigorReason}` : ''}`}
        </p>
      )}
      <ModelsSource session={session} />
    </section>
  );
}

/** "Models": what the Planner picked, with its reason, and what you changed. */
function ModelsSource({ session }: { session: TreeSession }) {
  const entries = Object.entries(session.models);
  const list = (by: string) =>
    entries
      .filter(([, m]) => m.by === by)
      .map(([agent, m]) => `${agent} ${m.model}`)
      .join(', ');
  const planner = list('planner');
  const human = list('human');
  return (
    <>
      {planner && (
        <p className="muted small" data-testid="session-models-planner">
          Models picked by the Planner: {planner}
          {session.modelsReason ? `: ${session.modelsReason}` : ''}
        </p>
      )}
      {human && (
        <p className="muted small" data-testid="session-models-human">
          Models set by you: {human}
        </p>
      )}
    </>
  );
}

/** The plan, what runs the session, its subagents, and End session: opened by "⋯" on the Planner node. */
function SessionDetails({
  session,
  planning,
  folder,
  readOnly,
  now,
}: {
  session: TreeSession;
  planning: boolean;
  folder: boolean;
  readOnly: boolean;
  now: number;
}) {
  return (
    <div className="session-details" data-testid="session-details">
      {session.source !== 'import' && <PlanSection session={session} planning={planning} now={now} />}
      <p className="small">
        <span data-testid="session-provider">{session.provider}</span> · {session.model}
        {session.effort && ` · ${session.effort}`}
      </p>
      {/* Folder sessions have no branch: they edit the project folder in place. */}
      <p className="muted small mono">{session.branch || 'in place, no branch'}</p>
      {session.subagents.length > 0 && (
        <ul className="subagents" aria-label="Subagents">
          {session.subagents.map((s) => (
            <li key={s.id} data-testid="subagent">
              <span className={`dot status-${s.status}`} aria-hidden="true" />
              <span className="grow">{s.title}</span>
              <span className="muted small">
                {s.model} · {s.effort} · {s.status}
              </span>
            </li>
          ))}
        </ul>
      )}
      {session.status !== 'ended' && session.source !== 'import' && (
        <EndSessionButton sessionId={session.id} folder={folder} readOnly={readOnly} />
      )}
    </div>
  );
}

/** Which node asked: shown above each question card under the row. */
function askerLabel(q: Question, row: Row): string {
  for (const [name, node] of [
    ['Planner', row.planner],
    ['Builder', row.builder],
  ] as const) {
    if (!node.questions.includes(q)) continue;
    const sub = row.session.subagents.find((s) => s.id === q.subagentId);
    return [name, sub?.title].filter(Boolean).join(' › ');
  }
  for (const lane of row.lanes) {
    const pr = lane.pr ? `${lane.pr.repo}#${lane.pr.number}` : '';
    const node = lane.nodes.find((n) => n.questions.includes(q));
    if (node) return `${node.label} · ${pr}`;
    if (lane.end.questions.includes(q)) return `${lane.end.label} · ${pr}`;
  }
  return row.session.title;
}

export function PipelineRow({
  row,
  folder,
  hidden = [],
  readOnly,
  now,
  edit,
  models,
}: {
  row: Row;
  folder: boolean;
  /** Parts of the row the dashboard's layout hides. */
  hidden?: readonly RowDetail[];
  readOnly: boolean;
  now: number;
  /** In the editor: a preview whose parts and pipeline are edited in place. */
  edit?: RowEdit;
  /** The defaults and the choices of the model captions; none (settings unreadable): no captions. */
  models?: ModelDefaults;
}) {
  const part: RowEdit['part'] = (detail, content) =>
    edit ? edit.part(detail, content) : shows(hidden, detail) ? content : null;
  const { session, planner, builder } = row;
  const planning = planner.state !== 'planned';
  const builderNode: NodeState =
    builder.state === 'working'
      ? 'current'
      : builder.state === 'paused'
        ? 'halted'
        : builder.state === 'todo'
          ? 'todo'
          : 'done';
  const pause = pauseLabel(session.pauseReason);
  const open = session.status !== 'ended';
  const feedbacks = laneFeedbacks(row.lanes);
  const froms = [...new Set(feedbacks.map((f) => f.short))];
  const feedbackChip = `${feedbacks.length} feedback · ${froms.join(', ')}`;
  const questions = [
    ...planner.questions,
    ...builder.questions,
    ...row.lanes.flatMap((l) => [...l.nodes.flatMap((n) => n.questions), ...l.end.questions]),
  ];
  const running = sessionRuntime(session.createdAt, session.endedAt, now);
  const plannerNode = (
    <Node
      kind="planner"
      stage={PLANNER_NODE}
      state={planner.state === 'planning' ? 'current' : planner.state === 'paused' ? 'halted' : 'done'}
      title="Planner"
      testId="planner-node"
      detail={planner.state}
      questions={planner.questions}
    >
      {/* The terminal is the Builder's: planning and building are the same agent. */}
      {!edit && (
        <span className="node-actions">
          {open && <MessageButton />}
          <DetailsButton />
        </span>
      )}
    </Node>
  );
  return (
    <SessionRowShell
      sessionId={session.id}
      title={session.title}
      readOnly={readOnly}
      paused={session.status === 'paused'}
      details={
        <SessionDetails session={session} planning={planning} folder={folder} readOnly={readOnly} now={now} />
      }
      feedback={
        feedbacks.length > 0 ? (
          <div className="session-details" data-testid="session-feedback">
            {feedbacks.map((f) => (
              <div key={f.pr.id} className="feedback" data-testid="feedback-item">
                <p className="small">
                  <a className="mono" href={f.pr.url} target="_blank" rel="noreferrer">
                    {f.pr.repo}#{f.pr.number}
                  </a>{' '}
                  · {f.label} ({roundLabel(f.pr.round, f.pr.loopState.maxRounds, session.rigor)}) ·{' '}
                  {f.sentAt ? 'the builder is fixing it, nothing to do' : 'being sent to the builder'}
                </p>
                {f.items.length > 0 && (
                  <ul className="feedback-items" data-testid="feedback-items">
                    {f.items.map((item, i) => (
                      <li key={i}>{item}</li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        ) : null
      }
    >
      <div className="canvas" data-testid="pipeline" data-session-id={session.id}>
        <div className="session-header" data-testid="session-header">
          <div className="session-heading">
            <h3 className="session-title" data-testid="session-title">
              {session.title}
            </h3>
            <div className="session-meta">
              <span data-testid="session-header-status">
                {humanize(session.status)}
                {pause && ` · ${pause}`}
              </span>
              {part('runtime', <span className="muted">{running}</span>)}
              {session.subagents.length > 0 &&
                part(
                  'subagents',
                  <span className="muted" data-testid="subagent-count">
                    {session.subagents.length} subagent{session.subagents.length === 1 ? '' : 's'}
                  </span>,
                )}
            </div>
          </div>
          {/* Folder projects have no PRs, so nothing for the dial to set. */}
          {!folder && (
            <RigorDial
              sessionId={session.id}
              title={session.title}
              rigor={session.rigor}
              source={session.rigorSource}
              reason={session.rigorReason}
              readOnly={readOnly}
              preview={edit !== undefined}
            />
          )}
        </div>
        <div className="flow">
          {edit ? edit.planner(plannerNode) : plannerNode}
          <Edge state={edgeInto(builderNode)} />
          <WithTerminal
            target={session.status === 'active' && !edit ? { kind: 'session', sessionId: session.id } : null}
            readOnly={readOnly}
          >
            {(button) => (
              <Node
                kind="builder"
                stage="builder"
                state={builderNode}
                title="Builder"
                model={
                  models && (
                    <ModelTag
                      sessionId={session.id}
                      agent="builder"
                      label="Builder"
                      view={agentModel(session, 'builder', models)}
                      allowed={models.allowed}
                      locked={readOnly || edit !== undefined || session.status === 'ended'}
                    />
                  )
                }
                detail={
                  builder.state === 'working'
                    ? 'building'
                    : builder.state === 'paused'
                      ? 'paused'
                      : builder.state === 'todo'
                        ? STATE_WORDS.todo
                        : ''
                }
                chip={feedbacks.length > 0 && !edit && <FeedbackButton label={feedbackChip} />}
                questions={builder.questions}
              >
                {button}
              </Node>
            )}
          </WithTerminal>
          {row.lanes.length > 0 && (
            <>
              <Edge state={row.lanes.some((l) => l.pr) ? 'done' : 'todo'} />
              <ul className={`lanes${row.lanes.length > 1 ? ' split' : ''}`}>
                {row.lanes.map((lane, i) => (
                  <LaneView
                    key={lane.pr?.id ?? 'none'}
                    lane={lane}
                    first={i === 0}
                    session={session}
                    models={models}
                    part={part}
                    edit={edit}
                    readOnly={readOnly}
                  />
                ))}
              </ul>
            </>
          )}
          {folder && (
            <span className="flow-note muted small" data-testid="no-prs-note">
              Folder project: edits in place, no review loop
            </span>
          )}
        </div>
      </div>
      {row.olderPrs.length > 0 &&
        part(
          'earlierPrs',
          <p className="muted small older-prs" data-testid="earlier-prs">
            Earlier PRs:{' '}
            {row.olderPrs.map((pr, i) => (
              <span key={pr.id}>
                {i > 0 && ', '}
                <a href={pr.url} target="_blank" rel="noreferrer" className="mono">
                  {pr.repo}#{pr.number}
                </a>{' '}
                ({humanize(pr.outcome ?? pr.stage)})
              </span>
            ))}
          </p>,
        )}
      {questions.length > 0 && (
        <div className="row-questions" inert={edit !== undefined}>
          {questions.map((q) => (
            <div key={q.id} id={questionAnchor(q)} className="row-question">
              <QuestionCard question={q} asker={askerLabel(q, row)} readOnly={readOnly} />
            </div>
          ))}
        </div>
      )}
    </SessionRowShell>
  );
}
