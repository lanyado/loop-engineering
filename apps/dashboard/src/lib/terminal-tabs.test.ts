import { describe, expect, it } from 'vitest';
import { buildBoard } from './board';
import { demoData } from './fixtures';
import { terminalTabs } from './terminal-tabs';

const d = demoData(new Date());
const rows = buildBoard(d.tree, d.pullRequests, [], d.pipeline).projects.flatMap((p) => p.rows);

describe('terminalTabs', () => {
  it('lists the live Builder first, then only the stages that have run, each with a stable id', () => {
    const withTabs = rows.map((row) => ({ row, tabs: terminalTabs(row) })).filter((r) => r.tabs.length > 1);
    expect(withTabs.length).toBeGreaterThan(0);
    for (const { row, tabs } of withTabs) {
      const active = row.session.status === 'active';
      if (active) expect(tabs[0]).toMatchObject({ live: true });
      for (const t of active ? tabs.slice(1) : tabs) {
        expect(t.live).toBe(false);
        expect(t.target.kind).toBe('stage');
        expect(t.id).toMatch(/^pr\d+-/);
      }
      expect(new Set(tabs.map((t) => t.id)).size).toBe(tabs.length);
    }
  });

  it('has no Builder tab for a session that is not running', () => {
    for (const row of rows.filter((r) => r.session.status !== 'active'))
      expect(terminalTabs(row).some((t) => t.live)).toBe(false);
  });
});
