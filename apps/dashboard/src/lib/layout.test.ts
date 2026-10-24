import { describe, expect, it } from 'vitest';
import { arrangeProjects, DEFAULT_LAYOUT, move, parseLayout, toggle } from './layout';

const project = (id: number, pending = 0) => ({ project: { id }, pending });

describe('parseLayout', () => {
  it('is the default for nothing, junk or a broken part, keeping the good parts', () => {
    expect(parseLayout(undefined)).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout('x')).toEqual(DEFAULT_LAYOUT);
    expect(DEFAULT_LAYOUT.topbar).toEqual(['brand', 'claude', 'fiveHour', 'weekly']);
    expect(parseLayout({ topbar: ['weekly', 'nope'], hiddenProjects: [3] })).toEqual({
      ...DEFAULT_LAYOUT,
      hiddenProjects: [3],
    });
    expect(parseLayout({ topbar: ['weekly', 'weekly', 'brand'] }).topbar).toEqual(['weekly', 'brand']);
    expect(parseLayout({ topbar: [] }).topbar).toEqual([]); // everything hidden is a choice
  });
});

describe('move and toggle', () => {
  it('move keeps every item and ignores moves off the ends', () => {
    expect(move(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(move(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    expect(move(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
  });

  it('toggle adds or takes out', () => {
    expect(toggle([1, 2], 2)).toEqual([1]);
    expect(toggle([1], 2)).toEqual([1, 2]);
  });
});

describe('arrangeProjects', () => {
  it("keeps the board's order until the user orders projects, then follows theirs", () => {
    const projects = [project(4, 2), project(1), project(2), project(3)];
    expect(arrangeProjects(projects, DEFAULT_LAYOUT).shown.map((p) => p.project.id)).toEqual([4, 1, 2, 3]);
    const { shown } = arrangeProjects(projects, { ...DEFAULT_LAYOUT, projectOrder: [3, 2, 4] });
    expect(shown.map((p) => p.project.id)).toEqual([3, 2, 4, 1]); // 1 is not in the order: last
  });

  it('hides hidden projects, unless they wait on you', () => {
    const projects = [project(1), project(2, 1), project(3)];
    const { shown, hidden } = arrangeProjects(projects, { ...DEFAULT_LAYOUT, hiddenProjects: [1, 2] });
    expect(shown.map((p) => p.project.id)).toEqual([2, 3]);
    expect(hidden.map((p) => p.project.id)).toEqual([1]);
  });
});
