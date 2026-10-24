'use client';

import { saveProjectOrder, setProjectHidden } from '../app/actions';
import { move } from '../lib/layout';
import { useAction } from './settings-controls';

/** Up, down and Hide for one project, in its settings panel. Saved in the dashboard's layout. */
export function ProjectPlacement({
  projectId,
  shownIds,
  hidden,
  readOnly,
}: {
  projectId: number;
  /** The projects on the board, in order. */
  shownIds: number[];
  /** Hidden, yet on the board because it waits on you. */
  hidden: boolean;
  readOnly: boolean;
}) {
  const { pending, run, message } = useAction();
  const at = shownIds.indexOf(projectId);
  // The whole order of what is shown, so the saved order matches the board.
  const shift = (by: -1 | 1) => run(() => saveProjectOrder(move(shownIds, at, at + by)));
  const disabled = pending || readOnly;
  return (
    <div className="placement" data-testid="project-placement">
      <span className="grow">
        Place on the board
        {hidden && <span className="muted small block">Hidden; shown while it waits on you.</span>}
      </span>
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
        onClick={() => run(() => setProjectHidden(projectId, !hidden))}
        data-testid="hide-project"
      >
        {hidden ? 'Show' : 'Hide'}
      </button>
      {message}
    </div>
  );
}

/** "2 hidden projects": each one with Show, under the board. */
export function HiddenProjects({
  projects,
  readOnly,
}: {
  projects: { id: number; name: string }[];
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
              onClick={() => run(() => setProjectHidden(p.id, false))}
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
