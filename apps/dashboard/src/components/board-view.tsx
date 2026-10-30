import type { ReactNode } from 'react';
import type { Board, ProjectBoard } from '../lib/board';
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
 * The board: questions no row shows, then each project with its pipelines, from the server's data.
 */
export function BoardView({
  board,
  pipelineErrors,
  projects,
  now,
  readOnly,
  settings,
  models,
}: {
  board: Board;
  /** A pipeline.json that cannot be read, the shared one or a project's: the PR loop waits for those PRs. */
  pipelineErrors: string[];
  /** board.projects in the layout's order, without the hidden ones. */
  projects: ProjectBoard[];
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
      {pipelineErrors.map((error) => (
        <p key={error} className="offline-banner" data-testid="pipeline-error">
          The PR loop waits until this is fixed: {error}.
        </p>
      ))}
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
          rowCount={p.rows.length}
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
                  readOnly={readOnly}
                  now={now}
                  models={models}
                />
              ))}
            </ul>
          )}
          {p.finished.length > 0 && <FinishedGroup sessions={p.finished} now={now} />}
        </ProjectShell>
      ))}
    </>
  );
}
