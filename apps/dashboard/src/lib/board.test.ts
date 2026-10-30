import { describe, expect, it } from 'vitest';
import {
  buildBoard as buildWith,
  isPlanning,
  laneOrder,
  pipelineErrors,
  stageStates,
  type BoardPipeline,
} from './board';
import { demoData } from './fixtures';
import type { PipelineView, PullRequest, Question, Rigor, TreeProject, TreeSession } from './schemas';

const NOW = new Date('2026-10-18T12:00:00.000Z');
// The demo's pipeline is the built-in one: tests, review, QA.
const PIPELINE = demoData(NOW).pipeline;
const buildBoard = (
  tree: TreeProject[],
  prs: PullRequest[],
  pending: Question[],
  view: BoardPipeline = PIPELINE,
) => buildWith(tree, prs, pending, view);

const session = (id: number, projectId: number, extra: Partial<TreeSession> = {}): TreeSession => ({
  id,
  projectId,
  title: `session ${id}`,
  status: 'active',
  pauseReason: null,
  provider: 'claude',
  model: 'opus',
  effort: null,
  branch: `loop/s${id}`,
  source: 'runner',
  rigor: 'standard',
  rigorSource: 'default',
  rigorReason: null,
  models: {},
  modelsReason: null,
  // Planned unless a test says otherwise: most tests are about building.
  plan: 'Goal: the task.',
  plannedAt: '2026-10-18T10:05:00.000Z',
  latestRequestAt: '2026-10-18T10:00:00.000Z',
  createdAt: '2026-10-18T10:00:00.000Z',
  endedAt: null,
  pendingQuestions: 0,
  subagents: [],
  ...extra,
});

const project = (id: number, sessions: TreeSession[], kind: 'git' | 'folder' = 'git'): TreeProject => ({
  id,
  name: `p${id}`,
  kind,
  folderPath: kind === 'folder' ? `/Users/me/p${id}` : null,
  repos: kind === 'git' ? [{ name: 'web' }] : [],
  autoMerge: false,
  createdAt: '2026-10-01T00:00:00.000Z',
  sessions,
});

const pr = (
  id: number,
  sessionId: number | null,
  stage: string,
  extra: Partial<PullRequest> = {},
): PullRequest => ({
  id,
  projectId: 1,
  sessionId,
  requestId: null,
  repo: 'web',
  number: 100 + id,
  url: `https://github.com/me/web/pull/${100 + id}`,
  stage,
  round: 1,
  outcome: null,
  loopState: {},
  createdAt: '2026-10-18T10:00:00.000Z',
  updatedAt: `2026-10-18T11:${String(10 + id).padStart(2, '0')}:00.000Z`,
  request: null,
  metrics: { prId: id, costUsd: 0, tokensIn: 0, tokensOut: 0, rounds: 1, failures: 0 },
  ...extra,
});

const question = (id: number, sessionId: number, createdAt = '2026-10-18T11:55:00.000Z'): Question => ({
  id,
  sessionId,
  subagentId: null,
  text: `question ${id}`,
  context: null,
  options: ['A', 'B'],
  recommendedOption: 'A',
  status: 'pending',
  answer: null,
  answeredVia: null,
  createdAt,
  deadline: '2026-10-18T12:10:00.000Z',
  answeredAt: null,
});

// The default pipeline's lane, in order. "deployed" is past the last node: every node done.
const LANE = ['tests', 'review', 'qa', 'awaiting_approval', 'merge', 'deploying'];

describe('stageStates', () => {
  it('marks nodes before the stage done, the stage current, the rest not yet', () => {
    expect(stageStates('qa', null, LANE)).toEqual(['done', 'done', 'current', 'todo', 'todo', 'todo']);
    expect(stageStates('tests', null, LANE)[0]).toBe('current');
  });

  it('is all done once deployed, fails Deploy when reverted and when escalated, and stops on close', () => {
    expect(stageStates('deployed', null, LANE)).toEqual(LANE.map(() => 'done'));
    expect(stageStates('reverted', null, LANE)).toEqual(['done', 'done', 'done', 'done', 'done', 'failed']);
    // The escalation ends red on Deploy; the stages the loop reached stay stopped.
    expect(stageStates('escalated', null, LANE)).toEqual([
      'halted',
      'halted',
      'halted',
      'halted',
      'halted',
      'failed',
    ]);
    expect(stageStates('canary_check', null, LANE)).toEqual(LANE.map(() => 'halted'));
  });
});

describe('buildBoard', () => {
  it('draws one lane per open PR, or the newest finished one, or an empty lane', () => {
    const tree = [project(1, [session(1, 1), session(2, 1), session(3, 1)])];
    const prs = [
      pr(1, 1, 'qa'),
      pr(2, 1, 'review'),
      pr(3, 2, 'deployed', { outcome: 'merged' }),
      pr(4, 2, 'reverted', { outcome: 'reverted', updatedAt: '2026-10-18T09:00:00.000Z' }),
    ];
    const [board] = buildBoard(tree, prs, []).projects;
    const row = (id: number) => board!.rows.find((r) => r.session.id === id)!;

    expect(row(1).lanes.map((l) => l.pr?.id)).toEqual([1, 2]); // oldest first: lanes keep their place
    expect(row(2).lanes.map((l) => l.pr?.id)).toEqual([3]);
    expect(row(2).lanes[0]!.end).toMatchObject({ state: 'done', label: 'Deployed' });
    expect(row(2).olderPrs.map((p) => p.id)).toEqual([4]);
    expect(row(3).lanes).toHaveLength(1);
    expect(row(3).lanes[0]).toMatchObject({ pr: null, end: { label: 'Shipped', state: 'todo' } });
    expect(row(3).lanes[0]!.nodes.every((n) => n.state === 'todo')).toBe(true);
  });

  it('gives a folder session no lanes (no PRs)', () => {
    const [board] = buildBoard([project(1, [session(1, 1, { branch: '' })], 'folder')], [], []).projects;
    expect(board!.rows[0]!.lanes).toEqual([]);
  });

  it("puts an agent's question on Builder and a loop question on its PR's node", () => {
    const tree = [project(1, [session(1, 1)])];
    const approval = pr(1, 1, 'awaiting_approval', { loopState: { question: { kind: 'approval', id: 11 } } });
    const escalated = pr(2, 1, 'escalated', { loopState: { question: { kind: 'escalation', id: 12 } } });
    // The loop marks a PR merged as it starts deploying: still a live lane.
    const deploying = pr(3, 1, 'deploying', {
      outcome: 'merged',
      loopState: { question: { kind: 'deploy_timeout', id: 13 } },
    });
    const pending = [question(10, 1), question(11, 1), question(12, 1), question(13, 1)];
    const { projects, unplaced } = buildBoard(tree, [approval, escalated, deploying], pending);
    const row = projects[0]!.rows[0]!;
    const lane = (id: number) => row.lanes.find((l) => l.pr?.id === id)!;

    expect(row.builder.questions.map((q) => q.id)).toEqual([10]);
    expect(
      lane(1)
        .nodes.find((n) => n.stage === 'awaiting_approval')!
        .questions.map((q) => q.id),
    ).toEqual([11]);
    expect(lane(2).end).toMatchObject({ state: 'failed', label: 'Escalated' });
    expect(lane(2).end.questions.map((q) => q.id)).toEqual([12]);
    expect(
      lane(3)
        .nodes.find((n) => n.stage === 'deploying')!
        .questions.map((q) => q.id),
    ).toEqual([13]);
    expect(row.pending).toBe(4);
    expect(projects[0]!.pending).toBe(4);
    expect(unplaced).toEqual([]);
  });

  it('adds a Guardian node after Deploy that follows the latest production check', () => {
    const tree = [project(1, [session(1, 1), session(2, 1), session(3, 1)])];
    const guardian = (status: string, critical = false) => ({
      guardian: { runId: 1, status, critical, summary: '' },
    });
    const prs = [
      pr(1, 1, 'deployed', { outcome: 'merged' }),
      pr(2, 2, 'deployed', { outcome: 'merged', loopState: guardian('passed') }),
      pr(3, 3, 'deployed', { outcome: 'merged', loopState: guardian('failed', true) }),
    ];
    const nodeOf = (id: number) =>
      buildBoard(tree, prs, [])
        .projects[0]!.rows.find((r) => r.session.id === id)!
        .lanes[0]!.nodes.at(-1)!;

    expect(nodeOf(1)).toMatchObject({ stage: 'guardian', state: 'todo' }); // not checked (yet)
    expect(nodeOf(2)).toMatchObject({ stage: 'guardian', state: 'done' });
    expect(nodeOf(3)).toMatchObject({ stage: 'guardian', state: 'failed' });
  });

  it('puts the critical-failure alert on the Guardian node, or in the unplaced list without a PR', () => {
    const tree = [project(1, [session(1, 1)])];
    const checked = pr(1, 1, 'deployed', {
      outcome: 'merged',
      loopState: { guardian: { runId: 1, status: 'failed', critical: true, summary: '', questionId: 20 } },
    });
    const daily = { ...question(21, 99), text: 'Production Guardian: web is failing critical checks.' };
    const { projects, unplaced } = buildBoard(tree, [checked], [question(20, 1), daily]);
    const lane = projects[0]!.rows[0]!.lanes[0]!;

    expect(lane.nodes.find((n) => n.stage === 'guardian')!.questions.map((q) => q.id)).toEqual([20]);
    expect(unplaced.map((u) => [u.question.id, u.asker])).toEqual([[21, 'Production Guardian']]);
  });

  it('ignores a loop question id that is no longer pending', () => {
    const tree = [project(1, [session(1, 1)])];
    const answered = pr(1, 1, 'awaiting_approval', { loopState: { question: { kind: 'approval', id: 99 } } });
    const row = buildBoard(tree, [answered], [question(10, 1)]).projects[0]!.rows[0]!;
    expect(row.lanes[0]!.nodes.every((n) => n.questions.length === 0)).toBe(true);
    expect(row.builder.questions.map((q) => q.id)).toEqual([10]);
  });

  it('keeps an ended session live while its PR is in the loop; finished ones are listed apart', () => {
    const tree = [
      project(1, [
        session(1, 1, { status: 'ended', endedAt: '2026-10-18T11:00:00.000Z' }),
        session(2, 1, { status: 'ended', endedAt: '2026-10-18T10:30:00.000Z' }),
        session(3, 1, { status: 'ended', endedAt: '2026-10-18T11:30:00.000Z' }),
      ]),
    ];
    const [board] = buildBoard(tree, [pr(1, 1, 'tests')], []).projects;
    expect(board!.rows.map((r) => r.session.id)).toEqual([1]);
    expect(board!.rows[0]!.builder.state).toBe('done');
    expect(board!.finished.map((s) => s.id)).toEqual([3, 2]);
  });

  it('shows the builder working until its PR opens, and again only while it fixes feedback', () => {
    const tree = [project(1, [session(1, 1), session(2, 1), session(3, 1)])];
    const prs = [
      pr(1, 1, 'tests'),
      pr(2, 2, 'review', { loopState: { feedback: { kind: 'review', items: ['fix x'], sentAt: null } } }),
    ];
    const [board] = buildBoard(tree, prs, []).projects;
    const state = (id: number) => board!.rows.find((r) => r.session.id === id)!.builder.state;
    expect([state(1), state(2), state(3)]).toEqual(['done', 'working', 'working']);
  });

  it("hides the loop's own session and lists questions no row shows, with who asked", () => {
    const loop = session(9, 1, { title: '[loop] PR loop', status: 'ended', branch: 'loop/pr-loop' });
    const orphan = pr(1, null, 'awaiting_approval', {
      loopState: { question: { kind: 'approval', id: 21 } },
    });
    const { projects, unplaced } = buildBoard(
      [project(1, [loop])],
      [orphan],
      [question(21, 9), question(22, 500)],
    );
    expect(projects[0]!.rows).toEqual([]);
    expect(projects[0]!.finished).toEqual([]);
    expect(unplaced.map((u) => [u.question.id, u.asker])).toEqual([
      [21, 'p1 › web#101'],
      [22, 'Router'],
    ]);
  });

  it('orders rows and projects: waiting on you, then working, then paused, then the rest', () => {
    const tree = [
      project(1, [session(1, 1, { status: 'ended', endedAt: '2026-10-18T11:00:00.000Z' })]),
      project(2, [session(2, 2, { status: 'paused' }), session(3, 2), session(4, 2)]),
      project(3, [session(5, 3)]),
    ];
    const { projects } = buildBoard(tree, [], [question(1, 4)]);
    expect(projects.map((p) => p.project.id)).toEqual([2, 3, 1]);
    expect(projects[0]!.rows.map((r) => r.session.id)).toEqual([4, 3, 2]);
  });

  it('places every pending question of the demo data somewhere, and one session still plans', () => {
    const data = demoData(NOW);
    const pending = data.questions.filter((q) => q.status === 'pending');
    const { projects, unplaced } = buildBoard(data.tree, data.pullRequests, pending);
    expect(unplaced).toEqual([]);
    expect(projects.reduce((n, p) => n + p.pending, 0)).toBe(pending.length);
    const shop = projects.find((p) => p.project.name === 'shop')!;
    const search = shop.rows.find((r) => r.session.title === 'Search relevance')!;
    expect(search.lanes[0]!.nodes.find((n) => n.stage === 'awaiting_approval')!.questions).toHaveLength(1);
    const rows = projects.flatMap((p) => p.rows);
    const planning = rows.filter((r) => r.planner.state !== 'planned');
    expect(planning.map((r) => [r.session.title, r.planner.questions.length])).toEqual([
      ['Update resume for the Acme role', 1],
    ]);
    expect(rows.filter((r) => r.session.plan).length).toBeGreaterThanOrEqual(4);
  });
});

describe('the Planner node', () => {
  const unplanned = { plan: null, plannedAt: null };

  it('plans while open with no plan, or with a plan older than the newest task', () => {
    expect(isPlanning(session(1, 1, unplanned), false)).toBe(true);
    expect(isPlanning(session(1, 1), false)).toBe(false);
    expect(isPlanning(session(1, 1, { latestRequestAt: '2026-10-18T11:00:00.000Z' }), true)).toBe(true);
    expect(isPlanning(session(1, 1, { latestRequestAt: null }), false)).toBe(false);
    // Ended: nothing left to plan. Started before the Planner existed and opened a PR: past it.
    expect(isPlanning(session(1, 1, { ...unplanned, status: 'ended' }), false)).toBe(false);
    expect(isPlanning(session(1, 1, unplanned), true)).toBe(false);
    // Subagents running: the builder is clearly working. A folder session has no PR to show it.
    const sub = {
      id: 1,
      sessionId: 1,
      title: 't',
      model: 'm',
      effort: 'high',
      status: 'running',
      createdAt: 't',
    };
    expect(isPlanning(session(1, 1, { ...unplanned, subagents: [sub] }), false)).toBe(false);
    expect(isPlanning(session(1, 1, unplanned), false, true)).toBe(false);
    expect(isPlanning(session(1, 1, { ...unplanned, pendingQuestions: 1 }), false, true)).toBe(true);
  });

  it('while planning, the Planner has every question and the Builder has not started', () => {
    const tree = [project(1, [session(1, 1, unplanned), session(2, 1, { ...unplanned, status: 'paused' })])];
    const [board] = buildBoard(tree, [], [question(11, 1), question(12, 2)]).projects;
    const row = (id: number) => board!.rows.find((r) => r.session.id === id)!;
    expect(row(1).planner).toEqual({ state: 'planning', questions: [expect.objectContaining({ id: 11 })] });
    expect(row(1).builder).toEqual({ state: 'todo', questions: [] });
    expect(row(2).planner.state).toBe('paused');
    expect(row(2).builder.state).toBe('todo');
    expect(row(1).pending).toBe(1);
  });

  it('once planned, questions asked before the plan stay on the Planner and later ones go to the Builder', () => {
    const tree = [project(1, [session(1, 1)])];
    const before = question(11, 1, '2026-10-18T10:03:00.000Z');
    const after = question(12, 1, '2026-10-18T10:30:00.000Z');
    const [board] = buildBoard(tree, [], [before, after]).projects;
    const row = board!.rows[0]!;
    expect(row.planner).toEqual({ state: 'planned', questions: [before] });
    expect(row.builder).toEqual({ state: 'working', questions: [after] });
    expect(row.pending).toBe(2);
  });

  it('a new task after the plan sends it back to planning; questions from before that task stay on the Builder', () => {
    const tree = [project(1, [session(1, 1, { latestRequestAt: '2026-10-18T11:50:00.000Z' })])];
    const prs = [pr(1, 1, 'review')];
    const earlier = question(10, 1, '2026-10-18T11:00:00.000Z');
    const [board] = buildBoard(tree, prs, [earlier, question(11, 1)]).projects;
    const row = board!.rows[0]!;
    expect(row.planner).toEqual({ state: 'planning', questions: [expect.objectContaining({ id: 11 })] });
    // Its earlier PR stays in the loop; the builder's part of it is done.
    expect(row.builder).toEqual({ state: 'done', questions: [earlier] });
  });
});

describe('the pipeline (stage files) shapes every lane', () => {
  const security = {
    id: 'security',
    title: 'Security review',
    label: 'Security',
    icon: 'shield',
    access: 'read',
    runs: 'always',
    prompt: 'x',
    builtin: false,
    overridden: false,
  };
  const view = (
    pipeline: Partial<PipelineView['pipeline']>,
    extra: PipelineView['stages'] = [security],
  ): BoardPipeline => ({
    pipeline: { ...PIPELINE.pipeline, ...pipeline },
    stages: [...PIPELINE.stages, ...extra],
  });
  const lane = (v: BoardPipeline, prs: PullRequest[], autoMerge = false) => {
    const tree = [{ ...project(1, [session(1, 1)]), autoMerge }];
    return buildBoard(tree, prs, [], v).projects[0]!.rows[0]!.lanes[0]!;
  };

  it('draws the checks in the pipeline order, with a custom stage under its label and icon', () => {
    const l = lane(view({ checks: ['security', 'review', 'tests'] }), [
      pr(1, 1, 'check', { loopState: { check: 'security' } }),
    ]);
    expect(l.nodes.map((n) => n.stage)).toEqual([
      'security',
      'review',
      'tests',
      'awaiting_approval',
      'merge',
      'deploying',
      'guardian',
    ]);
    expect(l.nodes[0]).toMatchObject({ label: 'Security', icon: 'shield', custom: true, state: 'current' });
    expect(l.nodes[1]).toMatchObject({ label: 'CR', custom: false, state: 'todo' });
  });

  it('marks the checks before the current one done, in the pipeline order', () => {
    const l = lane(view({ checks: ['review', 'tests'] }), [pr(1, 1, 'tests')]);
    expect(l.nodes.slice(0, 3).map((n) => [n.stage, n.state])).toEqual([
      ['review', 'done'],
      ['tests', 'current'],
      ['awaiting_approval', 'todo'],
    ]);
  });

  it('leaves out Deploy and Guardian when the pipeline turns them off', () => {
    const l = lane(view({ deploy: false, guardian: false }), [pr(1, 1, 'tests')]);
    expect(l.nodes.map((n) => n.stage)).toEqual(['tests', 'review', 'qa', 'awaiting_approval', 'merge']);
  });

  it('shows Approval in an auto-merge project only when the pipeline has no review, or a PR waits there', () => {
    const p = { autoMerge: true };
    expect(laneOrder(p, PIPELINE, null)).not.toContain('awaiting_approval');
    expect(laneOrder(p, view({ checks: ['tests'] }), null)).toContain('awaiting_approval');
    expect(laneOrder(p, PIPELINE, pr(1, 1, 'awaiting_approval'))).toContain('awaiting_approval');
  });

  it('keeps a check whose stage file is gone: the PR waits there', () => {
    const l = lane(view({ checks: ['tests', 'ghost'] }, []), [
      pr(1, 1, 'check', { loopState: { check: 'ghost' } }),
    ]);
    expect(l.nodes[1]).toMatchObject({
      stage: 'ghost',
      label: 'ghost',
      state: 'current',
      problem: 'no stage file',
    });
    const broken = lane(view({ checks: ['tests', 'scan'] }, [{ ...security, id: 'scan', error: 'bad' }]), []);
    expect(broken.nodes[1]).toMatchObject({ label: 'Security', problem: 'file broken' });
  });

  it('a skipped review brings Approval back in an auto-merge project; only checks of open PRs are skippable', () => {
    const skipped = pr(1, 1, 'tests', { loopState: { skip: ['review'] } });
    expect(laneOrder({ autoMerge: true }, PIPELINE, skipped)).toContain('awaiting_approval');
    const l = lane(view({}), [skipped], true);
    expect(l.nodes.find((n) => n.stage === 'review')).toMatchObject({ skipped: true, skippable: true });
    expect(l.nodes.find((n) => n.stage === 'merge')).toMatchObject({ skippable: false });
    const merged = lane(view({}), [pr(2, 1, 'merge', { outcome: 'merged' })]);
    expect(merged.nodes.every((n) => !n.skippable)).toBe(true);
    const escalated = lane(view({}), [pr(3, 1, 'escalated')]);
    expect(escalated.nodes.every((n) => !n.skippable)).toBe(true);
  });
});

describe("each project's own pipeline", () => {
  const tree = [project(1, [session(1, 1)]), project(2, [session(2, 2)])];
  const prs = [pr(1, 1, 'review'), pr(2, 2, 'review')];
  const own: BoardPipeline = {
    ...PIPELINE,
    projects: {
      1: { pipeline: { ...PIPELINE.pipeline, checks: ['review'], guardian: false }, stages: PIPELINE.stages },
    },
  };
  const stagesOf = (board: ReturnType<typeof buildBoard>, id: number) =>
    board.projects.find((p) => p.project.id === id)!.rows[0]!.lanes[0]!.nodes.map((n) => n.stage);

  it('draws a project with its own pipeline from it, and the others from the shared one', () => {
    const board = buildBoard(tree, prs, [], own);
    expect(stagesOf(board, 1)).toEqual(['review', 'awaiting_approval', 'merge', 'deploying']);
    expect(stagesOf(board, 2)).toEqual([
      'tests',
      'review',
      'qa',
      'awaiting_approval',
      'merge',
      'deploying',
      'guardian',
    ]);
  });

  it('names a project whose own pipeline.json is broken, and the shared one only while a project runs it', () => {
    const broken = (view: BoardPipeline, error: string): BoardPipeline => ({
      ...view,
      pipeline: { ...view.pipeline, error },
    });
    const both: BoardPipeline = {
      ...broken(PIPELINE, 'pipeline.json: not valid JSON'),
      projects: { 1: broken(PIPELINE, 'pipeline.json: unknown setting "x"') },
    };
    expect(pipelineErrors(buildBoard(tree, prs, [], both), both)).toEqual([
      'p1\'s pipeline.json: unknown setting "x"',
      'pipeline.json: not valid JSON',
    ]);
    const onlyOwn = buildBoard([tree[0]!], [prs[0]!], [], both);
    expect(pipelineErrors(onlyOwn, both)).toEqual(['p1\'s pipeline.json: unknown setting "x"']);
    expect(pipelineErrors(buildBoard(tree, prs, [], PIPELINE), PIPELINE)).toEqual([]);
  });
});

describe('the rigor dial changes no lane', () => {
  const lane = (rigor: Rigor, prs: PullRequest[], autoMerge = false) => {
    const tree = [{ ...project(1, [session(1, 1, { rigor })]), autoMerge }];
    return buildBoard(tree, prs, [], PIPELINE).projects[0]!.rows[0]!.lanes[0]!;
  };

  it('draws the same nodes at every level, every check skippable', () => {
    const stages = (rigor: Rigor) => lane(rigor, [pr(1, 1, 'tests')], true).nodes.map((n) => n.stage);
    for (const rigor of ['fast', 'light', 'thorough'] as const)
      expect(stages(rigor)).toEqual(stages('standard'));
    const fast = lane('fast', [pr(1, 1, 'tests')]);
    for (const id of ['tests', 'review', 'qa'])
      expect(fast.nodes.find((n) => n.stage === id)).toMatchObject({ skippable: true });
  });

  it('marks what did not pass at the merged head as not run, whatever the level', () => {
    const head = 'abc';
    const merged = pr(2, 1, 'deployed', {
      outcome: 'merged',
      loopState: { mergedHeadSha: head, testedSha: head, reviewedSha: 'older', skip: ['qa'] },
    });
    const done = lane('fast', [merged]).nodes;
    expect(done.filter((n) => n.notRun).map((n) => n.stage)).toEqual(['review']);
    expect(done.find((n) => n.stage === 'qa')).toMatchObject({ skipped: true, notRun: false });
    expect(lane('standard', [pr(3, 1, 'qa')]).nodes.some((n) => n.notRun)).toBe(false);
  });

  it('asks for approval only when auto-merge is off or the PR gets no review, at every level', () => {
    for (const rigor of ['fast', 'light', 'standard', 'thorough'] as const) {
      expect(lane(rigor, [], true).nodes.map((n) => n.stage)).not.toContain('awaiting_approval');
      expect(lane(rigor, [], false).nodes.map((n) => n.stage)).toContain('awaiting_approval');
    }
  });
});
