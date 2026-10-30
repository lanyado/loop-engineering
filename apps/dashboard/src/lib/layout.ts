import * as z from 'zod';

/*
 * The dashboard's layout: the order and hiding of projects. Saved on the server as
 * Settings.dashboardLayout; the dashboard alone defines what is in it, so an unknown or broken value
 * reads as the default. Older dashboards also saved the top bar's items and hidden row details
 * there; those are no longer settings (everything shows), so they are ignored and dropped on the
 * next save.
 */

/** The layout as saved: every field strict (what the actions accept as a patch). */
export const layoutInput = z.object({
  /** Projects listed here come in this order, the rest after them. */
  projectOrder: z.array(z.number().int().positive()).max(500),
  hiddenProjects: z.array(z.number().int().positive()).max(500),
});
export type Layout = z.infer<typeof layoutInput>;
export const layoutPatch = layoutInput.partial();
export type LayoutPatch = z.infer<typeof layoutPatch>;

export const DEFAULT_LAYOUT: Layout = { projectOrder: [], hiddenProjects: [] };

/** The values of `list` that `ok` accepts, each once: an unknown one is dropped, not the whole list. */
const known = <T>(list: unknown, ok: (v: unknown) => v is T): T[] | undefined =>
  Array.isArray(list) ? [...new Set(list.filter(ok))] : undefined;
const isId = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;

/** The saved layout, read leniently: what is missing or unknown is the default. */
export function parseLayout(raw: unknown): Layout {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    projectOrder: known(o.projectOrder, isId) ?? [],
    hiddenProjects: known(o.hiddenProjects, isId) ?? [],
  };
}

/** `list` with the item at `from` moved to `to`. */
export function move<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  if (from < 0 || from >= next.length || to < 0 || to >= next.length) return next;
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

/**
 * `items` with the `missing` ones put back where `reference` has them (after the shown items that
 * come before them there; ones it lacks go last). `at` is where adding an entry inserts it.
 */
export function withGhosts<T>(
  items: readonly T[],
  missing: readonly T[],
  reference: readonly T[],
): { item: T; ghost: boolean; at: number }[] {
  const rank = (x: T) => {
    const i = reference.indexOf(x);
    return i < 0 ? reference.length : i;
  };
  const ghosts = [...missing]
    .sort((a, b) => rank(a) - rank(b))
    .map((item) => {
      const before = items.flatMap((x, i) => (rank(x) < rank(item) ? [i + 1] : []));
      return {
        item,
        ghost: true,
        at: rank(item) === reference.length ? items.length : Math.max(0, ...before),
      };
    });
  return [
    ...items.flatMap((item, i) => [...ghosts.filter((g) => g.at === i), { item, ghost: false, at: i }]),
    ...ghosts.filter((g) => g.at === items.length),
  ];
}

/** `list` with `item` inserted at `at`. */
export const insert = <T>(list: readonly T[], item: T, at: number): T[] => [
  ...list.slice(0, at),
  item,
  ...list.slice(at),
];

/**
 * Projects as the board puts them (waiting on you first, then live, then idle) until the user
 * orders them; then in their order, new projects last. Hidden ones are left out unless they wait
 * on you.
 */
export function arrangeProjects<P extends { project: { id: number }; pending: number }>(
  projects: P[],
  layout: Layout,
): { shown: P[]; hidden: P[] } {
  const at = (p: P) => {
    const i = layout.projectOrder.indexOf(p.project.id);
    return i < 0 ? layout.projectOrder.length : i;
  };
  // A stable sort: projects the order does not name keep the board's order among themselves.
  const sorted = [...projects].sort((a, b) => at(a) - at(b));
  const isHidden = (p: P) => layout.hiddenProjects.includes(p.project.id) && p.pending === 0;
  return { shown: sorted.filter((p) => !isHidden(p)), hidden: sorted.filter(isHidden) };
}
