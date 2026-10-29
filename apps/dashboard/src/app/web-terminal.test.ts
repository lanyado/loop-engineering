import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Backend } from '../lib/backend';
import { buildBoard } from '../lib/board';
import { demoData } from '../lib/fixtures';
import { terminalTabs } from '../lib/terminal-tabs';
import { TerminalDock } from '../components/terminal-dock';
import { PipelineRow, type RowEdit } from '../components/pipeline';

/*
 * The web-terminal action and the dock it feeds. The existing tests cover the server endpoints and
 * the tab list; these cover the dashboard glue: the action's routing/validation, the dock's static
 * render, and its place under a pipeline row. The dock is interactive (effects decide what loads),
 * so only its server-rendered shell is asserted here; the click-through is in the e2e demo.
 */

// The actions tree pulls in Next's server-only guard; outside Next it is a no-op.
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ refresh: () => undefined }));
vi.mock('next/navigation', () => ({ redirect: () => undefined }));
vi.mock('next/headers', () => ({
  cookies: () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
  headers: () => new Map<string, string>(),
}));

let backend: Backend | null = null;
vi.mock('../lib/server/session', () => ({
  backendForViewer: () => {
    if (!backend) throw new Error('no backend in test');
    return Promise.resolve(backend);
  },
  requireLogin: () => Promise.resolve(),
}));

const { webTerminalUrl } = await import('./actions');

let webSpy: ReturnType<typeof vi.fn>;
const fakeBackend = (url: string): Backend => {
  webSpy = vi.fn(() => Promise.resolve(url));
  return { webTerminal: webSpy } as unknown as Backend;
};

const fixtures = demoData(new Date());
const rows = buildBoard(fixtures.tree, fixtures.pullRequests, [], fixtures.pipeline).projects.flatMap(
  (p) => p.rows,
);

describe('webTerminalUrl action', () => {
  it('sends a session to the session endpoint and returns the url as the message', async () => {
    backend = fakeBackend('http://localhost:7700');
    const r = await webTerminalUrl({ kind: 'session', sessionId: 101 });
    expect(r).toEqual({ ok: true, message: 'http://localhost:7700' });
    expect(webSpy).toHaveBeenCalledWith({ sessionId: 101 });
  });

  it('sends a stage to the stage endpoint', async () => {
    backend = fakeBackend('http://localhost:7701');
    const r = await webTerminalUrl({ kind: 'stage', prId: 1, stage: 'qa' });
    expect(r).toEqual({ ok: true, message: 'http://localhost:7701' });
    // The action passes the stage target as-is (the kind included; the backend routes on sessionId's absence).
    expect(webSpy).toHaveBeenCalledWith({ kind: 'stage', prId: 1, stage: 'qa' });
  });

  it('rejects a bad stage without reaching the backend', async () => {
    backend = fakeBackend('http://localhost:7702');
    const r = await webTerminalUrl({ kind: 'stage', prId: 1, stage: '' });
    expect(r.ok).toBe(false);
    expect((r as { ok: false; error: string }).error.length).toBeGreaterThan(0);
    expect(webSpy).not.toHaveBeenCalled();
  });
});

describe('the TerminalDock shell', () => {
  const withTabs = rows.find((r) => terminalTabs(r).length > 0);
  if (!withTabs) throw new Error('no fixture row with terminal tabs');

  it('renders collapsed with the count of tabs under a pipeline row', () => {
    const row = createElement(TerminalDock, { tabs: terminalTabs(withTabs), readOnly: false });
    const html = renderToStaticMarkup(row);
    expect(html).toContain('data-testid="terminal-dock"');
    expect(html).toContain('data-testid="terminal-dock-toggle"');
    expect(html).toContain(`dock-count">${terminalTabs(withTabs).length}</span>`);
    // Collapsed: no terminal body or iframe until opened.
    expect(html).not.toContain('dock-frame');
    // Its toggle starts closed (aria-expanded).
    expect(html).toContain('aria-expanded="false"');
  });

  it('is absent in edit mode from the pipeline row itself', () => {
    // A minimal edit mode: every detail shows inline, the planner node as-is, no lane steps.
    const edit = {
      part: (_d: unknown, content: unknown) => content,
      planner: (n: unknown) => n,
      lane: () => [],
    };
    const html = renderToStaticMarkup(
      createElement(PipelineRow, {
        row: withTabs,
        folder: false,
        readOnly: false,
        now: 0,
        edit: edit as unknown as RowEdit,
      }),
    );
    expect(html).not.toContain('data-testid="terminal-dock"');
  });

  it('is present under a normal (non-edit) pipeline row', () => {
    const html = renderToStaticMarkup(
      createElement(PipelineRow, { row: withTabs, folder: false, readOnly: false, now: 0 }),
    );
    expect(html).toContain('data-testid="terminal-dock"');
  });
});
