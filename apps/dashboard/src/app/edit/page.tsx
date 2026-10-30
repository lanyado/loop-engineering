import { Editor, type EditorTab } from '../../components/editor';
import { backendFailure, ServerUnavailable } from '../../components/server-unavailable';
import { BackendError } from '../../lib/backend';
import { editorExample } from '../../lib/fixtures';
import { requestTime } from '../../lib/server/clock';
import { backendForViewer } from '../../lib/server/session';

// Live data on every request; nothing here may be prerendered at build time.
export const dynamic = 'force-dynamic';

const unavailable = (error: BackendError, path: string) => (
  <main className="content">
    <ServerUnavailable error={error} path={path} />
  </main>
);

/**
 * The pencil's editor: a tab for the shared pipeline and one for each project (?project=<id>), each
 * drawn on an example session and applied to the PR loop only on Save.
 */
export default async function EditPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string | string[] }>;
}) {
  const backend = await backendForViewer();
  const now = requestTime();
  const raw = (await searchParams).project;
  const wanted = typeof raw === 'string' && /^[1-9]\d{0,9}$/.test(raw) ? Number(raw) : null;
  const loaded = await Promise.all([backend.tree(), backend.pipeline()]).catch(backendFailure);
  if (loaded instanceof BackendError) return unavailable(loaded, '/edit');
  const [tree, shared] = loaded;
  const own = shared.projects ?? {};
  const tabs: EditorTab[] = [
    { id: null, name: 'Shared', kind: 'git', own: true },
    ...tree.map((p) => ({
      id: p.id,
      name: p.name,
      kind: p.kind,
      own: String(p.id) in own,
    })),
  ];
  // An unknown project (deleted meanwhile, or a typo) shows the shared tab.
  const tab = tabs.find((t) => t.id === wanted) ?? tabs[0]!;
  const view = tab.id === null ? shared : await backend.pipeline(tab.id).catch(backendFailure);
  if (view instanceof BackendError) return unavailable(view, `/edit?project=${tab.id}`);
  return (
    <Editor
      // A new tab is a new draft: nothing carries over from the last one.
      key={tab.id ?? 'shared'}
      view={view}
      tabs={tabs}
      tab={tab.id === null ? tab : { ...tab, own: view.project?.own ?? tab.own }}
      sharedBy={tabs.flatMap((t) => (t.id !== null && !t.own ? [t.name] : []))}
      example={editorExample(new Date(now), tab.kind)}
      now={now}
      readOnly={backend.demo}
    />
  );
}
