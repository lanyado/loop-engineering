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

const ids = z.array(z.number().int().positive()).catch([]);
export const layoutSchema = z.object({
  /** Shown left to right; an item left out is hidden. */
  topbar: z.array(z.enum(TOPBAR_ITEMS)).catch([...TOPBAR_ITEMS]),
  hiddenDetails: z.array(z.enum(ROW_DETAILS)).catch([]),
  /** Projects listed here come in this order, the rest after them as before. */
  projectOrder: ids,
  hiddenProjects: ids,
});
export type Layout = z.infer<typeof layoutSchema>;

export const DEFAULT_LAYOUT: Layout = layoutSchema.parse({});

export function parseLayout(raw: unknown): Layout {
  const parsed = layoutSchema.safeParse(raw ?? {});
  if (!parsed.success) return DEFAULT_LAYOUT;
  const layout = parsed.data;
  // The same item twice would render twice.
  return { ...layout, topbar: [...new Set(layout.topbar)] };
}

export const shows = (layout: Layout, detail: RowDetail) => !layout.hiddenDetails.includes(detail);

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
