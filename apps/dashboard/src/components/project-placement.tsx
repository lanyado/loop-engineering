'use client';

import { saveLayout } from '../app/actions';
import { move, toggle, type Layout } from '../lib/layout';
import { useAction } from './settings-controls';

/** Up, down and Hide for one project, in its settings panel. Saved in the dashboard's layout. */
export function ProjectPlacement({
  projectId,
  shownIds,
  layout,
  readOnly,
}: {
  projectId: number;
  /** The projects on the board, in order. */
  shownIds: number[];
  layout: Layout;
  readOnly: boolean;
}) {
  const { pending, run, message } = useAction();
  const at = shownIds.indexOf(projectId);
  const save = (next: Partial<Layout>) => run(() => saveLayout({ ...layout, ...next }));
  // The whole order of what is shown, so the saved order matches the board.
  const shift = (by: -1 | 1) => save({ projectOrder: move(shownIds, at, at + by) });
  const disabled = pending || readOnly;
  return (
    <div className="placement" data-testid="project-placement">
      <span className="grow">Place on the board</span>
      <button type="button" className="ghost small" disabled={disabled || at <= 0} onClick={() => shift(-1)}>
        Move up
      </button>
      <button
        type="button"
        className="ghost small"
        disabled={disabled || at < 0 || at >= shownIds.length - 1}
        onClick={() => shift(1)}
      >
        Move down
      </button>
      <button
        type="button"
        className="ghost small"
        disabled={disabled}
        onClick={() => save({ hiddenProjects: toggle(layout.hiddenProjects, projectId) })}
        data-testid="hide-project"
      >
        Hide
      </button>
      {message}
    </div>
  );
}

/** "2 hidden projects": each one with Show, under the board. A project that waits on you is never hidden. */
export function HiddenProjects({
  projects,
  layout,
  readOnly,
}: {
  projects: { id: number; name: string }[];
  layout: Layout;
  readOnly: boolean;
}) {
  const { pending, run, message } = useAction();
  return (
    <details className="hidden-projects" data-testid="hidden-projects">
      <summary className="muted small">
        {projects.length} hidden project{projects.length === 1 ? '' : 's'}
      </summary>
      <ul>
        {projects.map((p) => (
          <li key={p.id}>
            <span className="grow">{p.name}</span>
            <button
              type="button"
              className="ghost small"
              disabled={pending || readOnly}
              onClick={() =>
                run(() =>
                  saveLayout({
                    ...layout,
                    hiddenProjects: layout.hiddenProjects.filter((id) => id !== p.id),
                  }),
                )
              }
            >
              Show
            </button>
          </li>
        ))}
      </ul>
      {message}
    </details>
  );
}
