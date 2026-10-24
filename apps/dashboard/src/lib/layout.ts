import * as z from 'zod';

/*
 * The dashboard's layout: what the top bar shows and in what order, which parts of a row are
 * hidden, and the order and hiding of projects. Saved on the server as Settings.dashboardLayout;
 * the dashboard alone defines what is in it, so an unknown or broken value reads as the default.
 */

export const TOPBAR_ITEMS = ['brand', 'claude', 'fiveHour', 'weekly'] as const;
export type TopbarItem = (typeof TOPBAR_ITEMS)[number];
export const TOPBAR_LABELS: Record<TopbarItem, string> = {
  brand: 'Loop logo',
  claude: 'Claude mark',
  fiveHour: '5-hour limit',
  weekly: 'Weekly limit',
};

export const ROW_DETAILS = ['runtime', 'subagents', 'prMetrics', 'earlierPrs', 'finished'] as const;
export type RowDetail = (typeof ROW_DETAILS)[number];
export const ROW_DETAIL_LABELS: Record<RowDetail, string> = {
  runtime: 'How long a session has run',
  subagents: 'Subagent count',
  prMetrics: 'PR cost and tokens',
  earlierPrs: 'Earlier PRs',
  finished: 'Finished sessions',
};

/** The layout as saved: every field strict (what the actions accept as a patch). */
export const layoutInput = z.object({
  /** Shown left to right; an item left out is hidden. */
  topbar: z.array(z.enum(TOPBAR_ITEMS)).max(TOPBAR_ITEMS.length),
  hiddenDetails: z.array(z.enum(ROW_DETAILS)).max(ROW_DETAILS.length),
  /** Projects listed here come in this order, the rest after them. */
  projectOrder: z.array(z.number().int().positive()).max(500),
  hiddenProjects: z.array(z.number().int().positive()).max(500),
});
export type Layout = z.infer<typeof layoutInput>;
export const layoutPatch = layoutInput.partial();
export type LayoutPatch = z.infer<typeof layoutPatch>;

export const DEFAULT_LAYOUT: Layout = {
  topbar: [...TOPBAR_ITEMS],
  hiddenDetails: [],
  projectOrder: [],
  hiddenProjects: [],
};

/** The values of `list` that `ok` accepts, each once: an unknown one is dropped, not the whole list. */
const known = <T>(list: unknown, ok: (v: unknown) => v is T): T[] | undefined =>
  Array.isArray(list) ? [...new Set(list.filter(ok))] : undefined;
const oneOf =
  <T extends string>(values: readonly T[]) =>
  (v: unknown): v is T =>
    (values as readonly unknown[]).includes(v);
const isId = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;

/** The saved layout, read leniently: what is missing or unknown is the default. */
export function parseLayout(raw: unknown): Layout {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    topbar: known(o.topbar, oneOf(TOPBAR_ITEMS)) ?? DEFAULT_LAYOUT.topbar,
    hiddenDetails: known(o.hiddenDetails, oneOf(ROW_DETAILS)) ?? [],
    projectOrder: known(o.projectOrder, isId) ?? [],
    hiddenProjects: known(o.hiddenProjects, isId) ?? [],
  };
}

export const shows = (hidden: readonly RowDetail[], detail: RowDetail) => !hidden.includes(detail);

/** `list` with the item at `from` moved to `to`. */
export function move<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  if (from < 0 || from >= next.length || to < 0 || to >= next.length) return next;
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

/** `list` with `item` taken out if it is in, added at the end if not. */
export const toggle = <T>(list: readonly T[], item: T): T[] =>
  list.includes(item) ? list.filter((x) => x !== item) : [...list, item];

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
