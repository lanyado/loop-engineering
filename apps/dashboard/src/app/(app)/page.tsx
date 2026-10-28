import { BoardView } from '../../components/board-view';
import { backendFailure, ServerUnavailable } from '../../components/server-unavailable';
import { BackendError } from '../../lib/backend';
import { HiddenProjects, ProjectPlacement } from '../../components/project-placement';
import { ProjectSettings } from '../../components/settings-controls';
import { buildBoard } from '../../lib/board';
import { arrangeProjects, parseLayout } from '../../lib/layout';
import { modelDefaults } from '../../lib/models';
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
  ]).catch(backendFailure);
  if (loaded instanceof BackendError) return <ServerUnavailable error={loaded} path="/" />;
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
        models={settings ? modelDefaults(settings) : undefined}
        settings={(p) => (
          <>
            <ProjectSettings project={p.project} readOnly={readOnly} />
            <ProjectPlacement
              projectId={p.project.id}
              shownIds={shownIds}
              hidden={layout.hiddenProjects.includes(p.project.id)}
              readOnly={readOnly}
            />
          </>
        )}
      />
      {hidden.length > 0 && (
        <HiddenProjects
          projects={hidden.map((p) => ({ id: p.project.id, name: p.project.name }))}
          readOnly={readOnly}
        />
      )}
    </>
  );
}
