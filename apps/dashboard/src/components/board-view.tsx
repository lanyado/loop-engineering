import type { ReactNode } from 'react';
import type { Board, ProjectBoard } from '../lib/board';
import { shows, type Layout } from '../lib/layout';
import type { ModelDefaults } from '../lib/models';
import { FinishedGroup } from './finished-sessions';
import { PipelineRow } from './pipeline';
import { FolderPath, KindChip } from './project-kind';
import { QuestionCard } from './question-card';
import { ProjectButtons, ProjectShell } from './session-controls';

function ProjectHeader({ board }: { board: ProjectBoard }) {
  const { project } = board;
  return (
    <header className="project-head">
      <div className="project-title">
        <h2>{project.name}</h2>
        <KindChip project={project} />
        <span className="project-counts small">
          {board.pending > 0 && (
            <span className="count ask-count" data-testid="project-pending">
              {board.pending} waiting on you
            </span>
          )}
        </span>
      </div>
      <ProjectButtons projectName={project.name} />
      <FolderPath project={project} />
    </header>
  );
}

/**
 * The board: questions no row shows, then each project with its pipelines. The page renders it
 * from the server's data, the editor from demo data with the layout being edited.
 */
export function BoardView({
  board,
  pipelineError,
  projects,
  layout,
  now,
  readOnly,
  settings,
  models,
}: {
  board: Board;
  /** pipeline.json cannot be read: the PR loop waits. */
  pipelineError?: string | undefined;
  /** board.projects in the layout's order, without the hidden ones. */
  projects: ProjectBoard[];
  layout: Layout;
  now: number;
  readOnly: boolean;
  /** What a project's slider icon opens. */
  settings: (p: ProjectBoard) => ReactNode;
  /** The model captions' defaults and choices; none: the captions are left out. */
  models?: ModelDefaults | undefined;
}) {
  return (
    <>
      <h1 className="sr-only">Pipelines</h1>
      {pipelineError && (
        <p className="offline-banner" data-testid="pipeline-error">
          The PR loop waits until this is fixed: {pipelineError}.
        </p>
      )}
      {board.unplaced.length > 0 && (
        <section className="unplaced" data-testid="unplaced">
          <h2>Waiting on you</h2>
          <div className="row-questions">
            {board.unplaced.map(({ question, asker }) => (
              <QuestionCard key={question.id} question={question} asker={asker} readOnly={readOnly} />
            ))}
          </div>
        </section>
      )}
      {board.projects.length === 0 && <p className="empty">No projects yet.</p>}
      {projects.map((p) => (
        <ProjectShell
          key={p.project.id}
          projectId={p.project.id}
          projectName={p.project.name}
          readOnly={readOnly}
          header={<ProjectHeader board={p} />}
          settings={settings(p)}
        >
          {p.rows.length > 0 && (
            <ul className="rows">
              {p.rows.map((row) => (
                <PipelineRow
                  key={row.session.id}
                  row={row}
                  folder={p.project.kind === 'folder'}
                  hidden={layout.hiddenDetails}
                  readOnly={readOnly}
                  now={now}
                  models={models}
                />
              ))}
            </ul>
          )}
          {p.finished.length > 0 && shows(layout.hiddenDetails, 'finished') && (
            <FinishedGroup sessions={p.finished} now={now} />
          )}
        </ProjectShell>
      ))}
    </>
  );
}
