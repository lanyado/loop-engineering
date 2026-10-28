import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
// The actions tree pulls in Next's server-only guard; outside Next it is a no-op.
vi.mock('server-only', () => ({}));
import { buildBoard } from '../lib/board';
import { demoData } from '../lib/fixtures';
import { modelDefaults } from '../lib/models';
import { PipelineRow } from './pipeline';

/*
 * The send-back display: a stage sent work back to the builder, so its lane draws a dashed line
 * back with a pill (kind · count). Rendered here to string; the click-through is in the e2e demo.
 */

const board = (prs = demoData(new Date()).pullRequests, pending: Parameters<typeof buildBoard>[2] = []) =>
  buildBoard(demoData(new Date()).tree, prs, pending, demoData(new Date()).pipeline);

// The lane tiles are 88px wide with 16px edges: tile i centre = i * 104 + 44 (see pipeline.tsx).
const models = modelDefaults(demoData(new Date()).settings);
const renderRow = (sessionId: number, board_ = board(), props: Record<string, unknown> = {}) => {
  const row = board_.projects.flatMap((p) => p.rows).find((r) => r.session.id === sessionId);
  if (!row) throw new Error(`no row for session ${sessionId}`);
  return renderToStaticMarkup(
    createElement(PipelineRow, { row, folder: false, readOnly: false, now: 0, ...props }),
  );
};

describe('the lane draws the way back to the builder', () => {
  it('a QA send-back draws the return line and the pill under the lane', () => {
    const prs = demoData(new Date()).pullRequests.filter((p) => p.sessionId === 101);
    const html = renderRow(101, board(prs));
    // The lane carries the extra room and the line, with the pill on it (clickable in the browser).
    expect(html).toContain('lane has-return');
    expect(html).toContain('lane-return"');
    expect(html).toContain('data-testid="return-path"');
    expect(html).toContain('data-testid="return-path-toggle"');
    // QA is the third tile: the line reaches its centre, and the pill counts the two bugs.
    expect(html).toContain('--ret-x:252px');
    expect(html).toContain('QA · 2 back');
  });

  it('a CI send-back surfaces at Merge and counts one item even with an empty list', () => {
    const data = demoData(new Date());
    const atMerge = data.pullRequests.find((p) => p.stage === 'merge' && !p.loopState.feedback);
    if (!atMerge) throw new Error('no merge-stage fixture PR');
    const pr = {
      ...atMerge,
      loopState: { ...atMerge.loopState, feedback: { kind: 'ci', items: [], sentAt: null } },
    };
    const html = renderRow(pr.sessionId!, board([pr]));
    expect(html).toContain('lane has-return');
    // Its project auto-merges with a review in the pipeline, so there is no Approval tile: Merge is the
    // fourth tile. An empty feedback list still says "1 back".
    expect(html).toContain('--ret-x:356px');
    expect(html).toContain('CI · 1 back');
  });

  it('a lane whose stage sent nothing back draws no return line', () => {
    const data = demoData(new Date());
    const noFeedback = data.pullRequests.filter((p) => p.sessionId === 101 && !p.loopState.feedback);
    if (noFeedback.length === 0) throw new Error('expected a fixture PR without feedback');
    const html = renderRow(101, board(noFeedback));
    expect(html).not.toContain('lane has-return');
    expect(html).not.toContain('lane-return');
  });
});

describe('a custom stage (stage file)', () => {
  it('draws its node with its label and names it on the way back', () => {
    const data = demoData(new Date());
    const atMerge = data.pullRequests.find((p) => p.stage === 'merge' && p.outcome === null)!;
    const pr = {
      ...atMerge,
      stage: 'check',
      loopState: {
        ...atMerge.loopState,
        check: 'security',
        feedback: { kind: 'check', stage: 'security', items: ['a key is committed'], sentAt: null },
      },
    };
    const view = {
      pipeline: { checks: ['tests', 'security', 'review'], deploy: true, guardian: true },
      stages: [
        ...data.pipeline.stages,
        {
          id: 'security',
          title: 'Security review',
          label: 'Security',
          icon: 'shield',
          access: 'read',
          runs: 'always',
          prompt: 'x',
          builtin: false,
          overridden: false,
        },
      ],
    };
    const html = renderRow(pr.sessionId!, buildBoard(data.tree, [pr], [], view));
    expect(html).toContain('data-stage="security"');
    expect(html).toContain('title="Security">Security<');
    // Its tile is the second: the line comes back from its centre, and the pill names it.
    expect(html).toContain('--ret-x:148px');
    expect(html).toContain('Security · 1 back');
    expect(html).toContain('1 feedback · Security');
  });
});

describe('the model captions on the agent nodes', () => {
  const captions = (html: string) =>
    [
      ...html.matchAll(
        /data-stage="([a-z-]+)"[^>]*>(?:(?!data-testid="node(?:-planner|-end)?")[\s\S])*?node-model-name"[^>]*>([^<]*)</g,
      ),
    ].map((m) => `${m[1]}:${m[2]}`);

  it("names the Planner's picks on the builder and the checks, with a button to change each", () => {
    const html = renderRow(101, board(), { models });
    expect([...new Set(captions(html))]).toEqual(['builder:opus', 'tests:haiku', 'review:opus', 'qa:sonnet']);
    expect(html).toContain('aria-label="Model for Builder: opus. Change"');
    expect(html).toContain('aria-label="Model for Tests: haiku. Change"');
    expect(html).toContain('title="haiku (chosen by the Planner)"');
    expect(html.match(/data-testid="node-model-button"/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it("marks the human's pick and draws the default on an agent without one", () => {
    const html = renderRow(102, board(), { models });
    expect(html).toContain('data-source="human"');
    expect(html).toContain('title="opus (set by you)"');
    expect(html).toContain('data-source="planner"');
    // No pick for Tests: the session model, as the default.
    expect(html).toContain('title="opus (the default)"');
  });

  it('is plain text in demo mode and in the editor, and left out without settings', () => {
    const demo = renderRow(101, board(), { models, readOnly: true });
    expect(demo).toContain('data-testid="node-model"');
    expect(demo).not.toContain('node-model-button');
    expect(demo).toContain('title="opus (chosen by the Planner)"');
    expect(renderRow(101, board())).not.toContain('node-model');
  });

  it("an OpenCode session's captions show the fallback model and cannot be changed", () => {
    const html = renderRow(201, board(), { models });
    expect(html).toContain('opencode/glm-5.3-flash-free');
    expect(html).not.toContain('node-model-button');
  });
});
