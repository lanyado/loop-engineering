import { FinishedGroup } from '../../components/finished-sessions';
import { PipelineRow } from '../../components/pipeline';
import { FolderPath, KindChip } from '../../components/project-kind';
import { QuestionCard } from '../../components/question-card';
import { ProjectButtons, ProjectShell } from '../../components/session-controls';
import { ProjectSettings } from '../../components/settings-controls';
import { buildBoard, type ProjectBoard } from '../../lib/board';
import { DEFAULT_PIPELINE } from '../../lib/default-pipeline';
import { requestTime } from '../../lib/server/clock';
import { backendForViewer } from '../../lib/server/session';

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

export default async function BoardPage() {
  const backend = await backendForViewer();
  const [tree, prs, pending, pipeline] = await Promise.all([
    backend.tree(),
    backend.pullRequests(),
    backend.pendingQuestions(),
    // A server from before stage files: the built-in pipeline.
    backend.pipeline().catch(() => DEFAULT_PIPELINE),
  ]);
  const board = buildBoard(tree, prs, pending, pipeline);
  const now = requestTime();
  const readOnly = backend.demo;
  return (
    <>
      <h1 className="sr-only">Pipelines</h1>
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
      {board.projects.map((p) => (
        <ProjectShell
          key={p.project.id}
          projectId={p.project.id}
          projectName={p.project.name}
          readOnly={readOnly}
          header={<ProjectHeader board={p} />}
          settings={<ProjectSettings project={p.project} readOnly={readOnly} />}
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
