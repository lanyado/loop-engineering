import type { Lane, NodeState, Row, StageNode } from './board';

/** What an embedded terminal shows: a session's live agent, or the job log of one of a PR's stages. */
export type TerminalTarget =
  { kind: 'session'; sessionId: number } | { kind: 'stage'; prId: number; stage: string };

export interface TerminalTab {
  /** Stable across refreshes, so the chosen tab stays chosen. */
  id: string;
  label: string;
  /** The PR it belongs to (only when the session has several lanes), else null. */
  group: string | null;
  state: NodeState;
  /** The Builder's terminal is live and typeable; a stage's follows its log. */
  live: boolean;
  target: TerminalTarget;
}

/** Stages whose agent job has a log: review, tests, QA and custom stages, once they have run. */
export const JOB_STAGES = new Set<string>(['review', 'tests', 'qa']);
export function stageTarget(lane: Lane, node: StageNode): TerminalTarget | null {
  if (!lane.pr || !(node.custom || JOB_STAGES.has(node.stage)) || node.state === 'todo') return null;
  return { kind: 'stage', prId: lane.pr.id, stage: node.stage };
}

/** The terminals of one pipeline, Builder first, then each lane's stages that have run. */
export function terminalTabs(row: Row): TerminalTab[] {
  const tabs: TerminalTab[] = [];
  if (row.session.status === 'active') {
    tabs.push({
      // A new window is a new tab, so the dock asks for its terminal again.
      id: `builder-${row.session.tmuxTarget ?? ''}`,
      label: 'Builder',
      group: null,
      state: row.builder.state === 'working' || row.planner.state === 'planning' ? 'current' : 'done',
      live: true,
      target: { kind: 'session', sessionId: row.session.id },
    });
  }
  for (const lane of row.lanes) {
    const group = row.lanes.length > 1 && lane.pr ? `${lane.pr.repo}#${lane.pr.number}` : null;
    for (const node of lane.nodes) {
      const target = stageTarget(lane, node);
      if (!target || target.kind !== 'stage') continue;
      tabs.push({
        id: `pr${target.prId}-${target.stage}`,
        label: node.label,
        group,
        state: node.state,
        live: false,
        target,
      });
    }
  }
  return tabs;
}
