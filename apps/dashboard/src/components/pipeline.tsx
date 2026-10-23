import type { CSSProperties, ReactNode } from 'react';
import { type Lane, type NodeStage, type NodeState, type Row, type StageNode } from '../lib/board';
import { formatPrMetrics, humanize, pauseLabel, roundLabel, sessionRuntime } from '../lib/format';
import type { PullRequest, Question, TreeSession } from '../lib/schemas';
import { EndSessionButton } from './end-session-button';
import { QuestionCard } from './question-card';
import {
  DetailsButton,
  DoubleClickTerminal,
  FeedbackButton,
  MessageButton,
  SessionRowShell,
  TerminalButton,
  type TerminalTarget,
} from './session-controls';

/* Inline 24px stroke icons (no icon library), one per node kind. */
const ICON_PATHS: Record<NodeStage | 'session' | 'builder' | 'end', ReactNode> = {
  session: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="m7 9 3 3-3 3M12.5 15H17" />
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
};

function Icon({ kind }: { kind: keyof typeof ICON_PATHS }) {
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
      {ICON_PATHS[kind]}
    </svg>
  );
}

const NODE_TITLES: Record<NodeStage, string> = {
  review: 'CR',
  tests: 'Tests',
  qa: 'QA',
  awaiting_approval: 'Approval',
  merge: 'Merge',
  deploying: 'Deploy',
  guardian: 'Guardian',
};

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
  items: string[];
  sentAt: string | null;
}

/** The comments/bugs each drawn lane's stage sent back to the builder (and no fix pushed yet). */
const laneFeedbacks = (lanes: Lane[]): LaneFeedback[] =>
  lanes.flatMap((lane): LaneFeedback[] => {
    const f = lane.pr?.loopState.feedback;
    return lane.pr && f ? [{ pr: lane.pr, kind: f.kind, items: f.items, sentAt: f.sentAt }] : [];
  });

/** The lane node each kind of send-back comes from (a CI failure or a conflict surfaces at Merge). */
const FEEDBACK_ORIGIN: Record<string, NodeStage> = {
  review: 'review',
  tests: 'tests',
  qa: 'qa',
  ci: 'merge',
  conflict: 'merge',
};

/** Lane tiles are 88px wide with 16px edges between them (see .lane .node and .lane .edge in globals.css). */
const TILE_W = 88;
const TILE_PITCH = TILE_W + 16;

/**
 * The way back: a dashed amber line under the lane, from the stage that sent work back to the
 * Builder, ending in an arrow at the lane's start. Its pill (how many items) opens the details.
 */
function ReturnPath({ kind, count, from }: { kind: string; count: number; from: number }) {
  const label = `${FEEDBACK_SHORT[kind] ?? kind} · ${count} back`;
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
  children?: ReactNode;
}) {
  const shown = questions.length > 0 ? 'waiting' : state;
  return (
    <div
      className={`node node-${shown} node-${kind}`}
      data-testid={testId}
      data-stage={stage ?? kind}
      data-state={shown}
    >
      <span className="node-icon">
        <Icon kind={kind} />
      </span>
      <span className="node-body">
        <span className="node-title" title={title}>
          {title}
        </span>
        {detail && <span className="node-detail">{detail}</span>}
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
  node.questions.length > 0 ? 'waiting on you' : STATE_WORDS[node.state];

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

/** Stages whose agent job has a terminal (its log): review, tests and QA, once they have run. */
const JOB_STAGES = new Set<NodeStage>(['review', 'tests', 'qa']);
function stageTerminal(lane: Lane, node: StageNode): TerminalTarget | null {
  if (!lane.pr || !JOB_STAGES.has(node.stage) || node.state === 'todo') return null;
  return { kind: 'stage', prId: lane.pr.id, stage: node.stage as 'review' | 'tests' | 'qa' };
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

function LaneView({ lane, autoMerge, readOnly }: { lane: Lane; autoMerge: boolean; readOnly: boolean }) {
  const pr = lane.pr;
  // Auto-merge projects approve on their own: their pipeline has no Approval node.
  const nodes = autoMerge ? lane.nodes.filter((n) => n.stage !== 'awaiting_approval') : lane.nodes;
  const feedback = pr?.loopState.feedback;
  const origin = feedback ? nodes.findIndex((n) => n.stage === FEEDBACK_ORIGIN[feedback.kind]) : -1;
  return (
    <li
      className={`lane${origin >= 0 ? ' has-return' : ''}`}
      data-testid="lane"
      data-pr-number={pr?.number ?? ''}
    >
      <span className="lane-label">
        {pr && (
          <>
            <a href={pr.url} target="_blank" rel="noreferrer" className="mono" data-testid="lane-pr">
              {pr.repo}#{pr.number}
            </a>
            {pr.outcome === null && <span className="muted">{roundLabel(pr.round)}</span>}
            <span className="muted lane-metrics" data-testid="pr-metrics">
              {formatPrMetrics(pr.metrics)}
            </span>
          </>
        )}
      </span>
      <span className="lane-flow">
        {feedback && origin >= 0 && (
          <ReturnPath kind={feedback.kind} count={Math.max(feedback.items.length, 1)} from={origin} />
        )}
        {nodes.map((node, i) => (
          <span key={node.stage} className="lane-step">
            {i > 0 && <Edge state={edgeInto(node.state)} />}
            <WithTerminal target={stageTerminal(lane, node)} readOnly={readOnly}>
              {(button) => (
                <Node
                  kind={node.stage}
                  stage={node.stage}
                  state={node.state}
                  title={NODE_TITLES[node.stage]}
                  detail={
                    node.stage === 'deploying'
                      ? deployDetail(node, lane)
                      : node.stage === 'guardian'
                        ? guardianDetail(node, lane)
                        : nodeDetail(node)
                  }
                  questions={
                    node.stage === 'deploying' ? [...node.questions, ...lane.end.questions] : node.questions
                  }
                >
                  {button}
                </Node>
              )}
            </WithTerminal>
          </span>
        ))}
      </span>
    </li>
  );
}

/** What runs the session, its subagents, and End session: opened by "⋯" on the session node. */
function SessionDetails({
  session,
  folder,
  readOnly,
}: {
  session: TreeSession;
  folder: boolean;
  readOnly: boolean;
}) {
  return (
    <div className="session-details" data-testid="session-details">
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
  if (row.builder.questions.includes(q)) {
    const sub = row.session.subagents.find((s) => s.id === q.subagentId);
    return ['Builder', sub?.title].filter(Boolean).join(' › ');
  }
  for (const lane of row.lanes) {
    const pr = lane.pr ? `${lane.pr.repo}#${lane.pr.number}` : '';
    const node = lane.nodes.find((n) => n.questions.includes(q));
    if (node) return `${NODE_TITLES[node.stage]} · ${pr}`;
    if (lane.end.questions.includes(q)) return `${lane.end.label} · ${pr}`;
  }
  return row.session.title;
}

export function PipelineRow({
  row,
  folder,
  autoMerge,
  readOnly,
  now,
}: {
  row: Row;
  folder: boolean;
  autoMerge: boolean;
  readOnly: boolean;
  now: number;
}) {
  const { session, builder } = row;
  const pause = pauseLabel(session.pauseReason);
  const open = session.status !== 'ended';
  const feedbacks = laneFeedbacks(row.lanes);
  const froms = [...new Set(feedbacks.map((f) => FEEDBACK_SHORT[f.kind] ?? f.kind))];
  const feedbackChip = `${feedbacks.length} feedback · ${froms.join(', ')}`;
  const questions = [
    ...builder.questions,
    ...row.lanes.flatMap((l) => [...l.nodes.flatMap((n) => n.questions), ...l.end.questions]),
  ];
  const running = sessionRuntime(session.createdAt, session.endedAt, now);
  return (
    <SessionRowShell
      sessionId={session.id}
      title={session.title}
      readOnly={readOnly}
      paused={session.status === 'paused'}
      details={<SessionDetails session={session} folder={folder} readOnly={readOnly} />}
      feedback={
        feedbacks.length > 0 ? (
          <div className="session-details" data-testid="session-feedback">
            {feedbacks.map((f) => (
              <div key={f.pr.id} className="feedback" data-testid="feedback-item">
                <p className="small">
                  <a className="mono" href={f.pr.url} target="_blank" rel="noreferrer">
                    {f.pr.repo}#{f.pr.number}
                  </a>{' '}
                  · {FEEDBACK_LABELS[f.kind] ?? f.kind} ({roundLabel(f.pr.round)}) ·{' '}
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
          <h3 className="session-title" data-testid="session-title">
            {session.title}
          </h3>
          <div className="session-meta">
            <span data-testid="session-header-status">
              {humanize(session.status)}
              {pause && ` · ${pause}`}
            </span>
            <span className="muted">{running}</span>
            {session.subagents.length > 0 && (
              <span className="muted" data-testid="subagent-count">
                {session.subagents.length} subagent{session.subagents.length === 1 ? '' : 's'}
              </span>
            )}
          </div>
        </div>
        <div className="flow">
          <Node
            kind="session"
            state={open ? 'current' : 'done'}
            title="Session"
            testId="session-node"
            detail={null}
          >
            <span className="node-actions">
              {open && <MessageButton />}
              {session.status === 'active' && (
                <TerminalButton target={{ kind: 'session', sessionId: session.id }} readOnly={readOnly} />
              )}
              <DetailsButton />
            </span>
          </Node>
          <Edge state="done" />
          <WithTerminal
            target={session.status === 'active' ? { kind: 'session', sessionId: session.id } : null}
            readOnly={readOnly}
          >
            {(button) => (
              <Node
                kind="builder"
                stage="builder"
                state={
                  builder.state === 'working' ? 'current' : builder.state === 'paused' ? 'halted' : 'done'
                }
                title="Builder"
                detail={builder.state === 'working' ? 'building' : builder.state === 'paused' ? 'paused' : ''}
                chip={feedbacks.length > 0 && <FeedbackButton label={feedbackChip} />}
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
                {row.lanes.map((lane) => (
                  <LaneView
                    key={lane.pr?.id ?? 'none'}
                    lane={lane}
                    autoMerge={autoMerge}
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
      {row.olderPrs.length > 0 && (
        <p className="muted small older-prs">
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
        </p>
      )}
      {questions.length > 0 && (
        <div className="row-questions">
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
