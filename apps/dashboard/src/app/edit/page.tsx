import { Editor } from '../../components/editor';
import { backendFailure, ServerUnavailable } from '../../components/server-unavailable';
import { BackendError } from '../../lib/backend';
import { demoData } from '../../lib/fixtures';
import { parseLayout } from '../../lib/layout';
import { requestTime } from '../../lib/server/clock';
import { backendForViewer } from '../../lib/server/session';

// Live data on every request; nothing here may be prerendered at build time.
export const dynamic = 'force-dynamic';

/**
 * The pencil's editor: the user's own layout and pipeline, drawn on the demo board (every node,
 * question and send-back shows there), applied to their dashboard only on Approve.
 */
export default async function EditPage() {
  const backend = await backendForViewer();
  const now = requestTime();
  const demo = demoData(new Date(now));
  const loaded = await Promise.all([
    backend.settings().catch(() => null),
    backend.pipeline(),
    backend.usage().catch(() => null),
  ]).catch(backendFailure);
  if (loaded instanceof BackendError)
    return (
      <main className="content">
        <ServerUnavailable error={loaded} path="/edit" />
      </main>
    );
  const [settings, view, usage] = loaded;
  return (
    <Editor
      layout={parseLayout(settings?.dashboardLayout)}
      view={view}
      demo={{ tree: demo.tree, pullRequests: demo.pullRequests, questions: demo.questions }}
      usage={usage ?? demo.usage}
      now={now}
      readOnly={backend.demo}
    />
  );
}
