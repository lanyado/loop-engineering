import { describe, expect, it } from 'vitest';
import { arrangeProjects, DEFAULT_LAYOUT, insert, move, parseLayout, withGhosts } from './layout';

const project = (id: number, pending = 0) => ({ project: { id }, pending });

describe('parseLayout', () => {
  it('is the default for nothing, junk or a broken part, keeping the good parts', () => {
    expect(parseLayout(undefined)).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout('x')).toEqual(DEFAULT_LAYOUT);
    // One unknown item is dropped, not the whole list; duplicates once.
    expect(parseLayout({ projectOrder: [2, 'x', 1], hiddenProjects: [3, 3, -1] })).toEqual({
      projectOrder: [2, 1],
      hiddenProjects: [3],
    });
  });

  it("drops what older dashboards saved there: the top bar's items and hidden row details", () => {
    expect(parseLayout({ topbar: ['weekly'], hiddenDetails: ['prMetrics'], projectOrder: [4] })).toEqual({
      projectOrder: [4],
      hiddenProjects: [],
    });
  });
});

describe('move', () => {
  it('keeps every item and ignores moves off the ends', () => {
    expect(move(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(move(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    expect(move(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
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

describe('withGhosts', () => {
  const shown = (entries: { item: string; ghost: boolean }[]) =>
    entries.map((e) => (e.ghost ? `+${e.item}` : e.item)).join(' ');

  it('puts a removed item back where it was, and adding it there restores the order', () => {
    const entries = withGhosts(['a', 'c', 'd'], ['b'], ['a', 'b', 'c', 'd']);
    expect(shown(entries)).toBe('a +b c d');
    const b = entries.find((e) => e.ghost)!;
    expect(insert(['a', 'c', 'd'], 'b', b.at)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('follows the order the user gave the shown items', () => {
    expect(shown(withGhosts(['d', 'a', 'c'], ['b'], ['a', 'b', 'c', 'd']))).toBe('d a +b c');
    expect(shown(withGhosts(['c'], ['a', 'b'], ['a', 'b', 'c']))).toBe('+a +b c');
  });

  it('puts what the reference lacks last', () => {
    expect(shown(withGhosts(['a'], ['x', 'b'], ['a', 'b']))).toBe('a +b +x');
    expect(shown(withGhosts([], ['x'], []))).toBe('+x');
  });
});
