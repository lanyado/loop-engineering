import { BoardView } from '../../components/board-view';
import { ServerUnavailable } from '../../components/server-unavailable';
import { BackendError } from '../../lib/backend';
import { HiddenProjects, ProjectPlacement } from '../../components/project-placement';
import { ProjectSettings } from '../../components/settings-controls';
import { buildBoard } from '../../lib/board';
import { arrangeProjects, parseLayout } from '../../lib/layout';
import { requestTime } from '../../lib/server/clock';
import { backendForViewer } from '../../lib/server/session';

export default async function BoardPage() {
  const backend = await backendForViewer();
  const loaded = await Promise.all([
    backend.tree(),
    backend.pullRequests(),
    backend.pendingQuestions(),
    backend.pipeline(),
    // The default layout when the settings cannot be read: the board itself still shows.
    backend.settings().catch(() => null),
  ]).catch((error: unknown) => {
    if (error instanceof BackendError) return error;
    throw error;
  });
  if (loaded instanceof BackendError) return <ServerUnavailable message={loaded.message} />;
  const [tree, prs, pending, pipeline, settings] = loaded;
  const board = buildBoard(tree, prs, pending, pipeline);
  const layout = parseLayout(settings?.dashboardLayout);
  const { shown, hidden } = arrangeProjects(board.projects, layout);
  const readOnly = backend.demo;
  const shownIds = shown.map((p) => p.project.id);
  return (
    <>
      <BoardView
        board={board}
        pipelineError={pipeline.pipeline.error}
        projects={shown}
        layout={layout}
        now={requestTime()}
        readOnly={readOnly}
        settings={(p) => (
          <>
            <ProjectSettings project={p.project} readOnly={readOnly} />
            <ProjectPlacement
              projectId={p.project.id}
              shownIds={shownIds}
              layout={layout}
              readOnly={readOnly}
            />
          </>
        )}
      />
      {hidden.length > 0 && (
        <HiddenProjects
          projects={hidden.map((p) => ({ id: p.project.id, name: p.project.name }))}
          layout={layout}
          readOnly={readOnly}
        />
      )}
    </>
  );
}
