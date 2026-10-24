'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { applyEdits } from '../app/actions';
import { buildBoard } from '../lib/board';
import {
  toggle,
  TOPBAR_ITEMS,
  TOPBAR_LABELS,
  type Layout,
  type TopbarItem as TopbarItemName,
} from '../lib/layout';
import type {
  ClaudeUsage,
  PipelineUpdate,
  PipelineView,
  PullRequest,
  Question,
  Stage,
  TreeProject,
} from '../lib/schemas';
import { BoardView } from './board-view';
import { AddSheet, Chip, CloseDialog, EditableRow, Wiggle } from './editor-parts';
import { fieldsOf, StageSheet, type StageFields } from './stage-sheet';
import { TopbarItem } from './topbar-items';

/*
 * The pencil's editor, like iOS's Control Center: everything wiggles, "−" removes, dragging (or the
 * arrows) reorders, "+" adds back. It edits a draft of the user's own top bar, row details and
 * pipeline, drawn on the demo board; ✕ asks to Discard or Approve, and only Approve changes their
 * dashboard. Project order and hiding are on the real board, not here.
 */

interface Draft {
  layout: Pick<Layout, 'topbar' | 'hiddenDetails'>;
  pipeline: PipelineView['pipeline'];
  /** Stage files to write; null deletes a custom stage or resets a built-in one. */
  edits: Record<string, StageFields | null>;
}

const BLANK_STAGE: Stage = {
  id: '',
  title: '',
  label: '',
  icon: 'check',
  access: 'read',
  runs: 'always',
  prompt: '',
  builtin: false,
  overridden: false,
};

export function Editor({
  layout,
  view,
  demo,
  usage,
  now,
  readOnly,
}: {
  layout: Layout;
  view: PipelineView;
  demo: { tree: TreeProject[]; pullRequests: PullRequest[]; questions: Question[] };
  usage: ClaudeUsage;
  now: number;
  readOnly: boolean;
}) {
  const router = useRouter();
  const { checks: savedChecks, deploy, guardian, error: brokenPipeline } = view.pipeline;
  const initial: Draft = {
    layout: { topbar: layout.topbar, hiddenDetails: layout.hiddenDetails },
    pipeline: { checks: savedChecks, deploy, guardian },
    edits: {},
  };
  const [draft, setDraft] = useState<Draft>(initial);
  const [stages, setStages] = useState<Stage[]>(view.stages);
  const [sheet, setSheet] = useState<'add' | 'close' | { stage: Stage; isNew: boolean } | null>(null);
  const [saving, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const setLayout = (patch: Partial<Draft['layout']>) =>
    setDraft((d) => ({ ...d, layout: { ...d.layout, ...patch } }));
  const setPipeline = (patch: Partial<Draft['pipeline']>) =>
    setDraft((d) => ({ ...d, pipeline: { ...d.pipeline, ...patch } }));
  /** A stage file to write or delete; a stage made and dropped in this draft leaves no trace. */
  const setEdit = (id: string, edit: StageFields | null) =>
    setDraft((d) => {
      const rest = Object.fromEntries(Object.entries(d.edits).filter(([key]) => key !== id));
      const onServer = view.stages.some((s) => s.id === id);
      return { ...d, edits: edit === null && !onServer ? rest : { ...rest, [id]: edit } };
    });
  const { checks } = draft.pipeline;
  const stage = (id: string) => stages.find((s) => s.id === id);

  const board = useMemo(
    () =>
      buildBoard(
        demo.tree,
        demo.pullRequests,
        demo.questions.filter((q) => q.status === 'pending'),
        {
          pipeline: draft.pipeline,
          stages,
        },
      ),
    [demo, draft.pipeline, stages],
  );
  const changed = brokenPipeline !== undefined || JSON.stringify(draft) !== JSON.stringify(initial);
  /** Checks the loop would hold PRs at: their stage file is missing or broken. */
  const stuck = checks.filter((id) => !stage(id) || stage(id)?.error);

  const saveStage = (id: string, fields: StageFields) => {
    setSheet(null);
    const existing = stage(id);
    if (existing && JSON.stringify(fieldsOf(existing)) === JSON.stringify(fields) && !existing.error) return;
    setStages((all) =>
      existing
        ? all.map((s) => (s.id === id ? { ...s, ...fields, overridden: s.builtin, error: undefined } : s))
        : [...all, { id, ...fields, builtin: false, overridden: false }],
    );
    setEdit(id, fields);
    if (!checks.includes(id)) setPipeline({ checks: [...checks, id] });
  };
  /** A built-in's own prompt comes back from the server on Approve; until then the sheet says so. */
  const resetStage = (id: string) => {
    setSheet(null);
    const original = view.stages.find((s) => s.id === id);
    setStages((all) =>
      all.map((s) =>
        s.id !== id
          ? s
          : original && !original.overridden
            ? original
            : { ...s, prompt: '', overridden: false },
      ),
    );
    setEdit(id, null);
  };
  const deleteStage = (id: string) => {
    setSheet(null);
    setStages((all) => all.filter((s) => s.id !== id));
    setPipeline({ checks: checks.filter((c) => c !== id) });
    setEdit(id, null);
  };

  const approve = () =>
    start(async () => {
      setError(null);
      // An unreadable pipeline.json is replaced by what the editor shows.
      const pipelineChanged =
        brokenPipeline !== undefined ||
        JSON.stringify(draft.pipeline) !== JSON.stringify(initial.pipeline) ||
        Object.keys(draft.edits).length > 0;
      const pipeline: PipelineUpdate | undefined = pipelineChanged
        ? { pipeline: draft.pipeline, stages: draft.edits }
        : undefined;
      // Only what changed: settings that failed to load must not be written back as the defaults.
      const layoutChanges = Object.fromEntries(
        Object.entries(draft.layout).filter(
          ([key, value]) =>
            JSON.stringify(value) !== JSON.stringify(initial.layout[key as keyof Draft['layout']]),
        ),
      );
      const result = await applyEdits({ layout: layoutChanges, ...(pipeline ? { pipeline } : {}) });
      if (result.ok) router.push('/');
      else setError(result.error);
    });

  return (
    <div className="app editor" data-testid="editor">
      <header className="topbar editing">
        <div className="topbar-items" aria-label="Top bar">
          <EditableRow<TopbarItemName>
            items={draft.layout.topbar}
            label={(item) => TOPBAR_LABELS[item]}
            render={(item) => <TopbarItem item={item} usage={usage} now={now} preview />}
            onChange={(topbar) => setLayout({ topbar })}
          />
        </div>
        <div className="topbar-actions">
          <button type="button" className="small" onClick={() => setSheet('add')} data-testid="editor-add">
            + Add
          </button>
          <button
            type="button"
            className="ghost small icon-button"
            aria-label="Done editing"
            onClick={() => (changed ? setSheet('close') : router.push('/'))}
            data-testid="editor-close"
          >
            ✕
          </button>
        </div>
      </header>

      <section className="pipeline-editor" aria-label="Pipeline">
        <p className="muted small">
          Your pipeline, on demo projects. Drag or use the arrows to reorder, − to remove, tap a stage to edit
          what it checks. Approve applies it to your dashboard and the PR loop.
        </p>
        <div className="pipeline-strip">
          <Chip icon="session" label="Session" locked />
          <Chip icon="builder" label="Builder" locked />
          <EditableRow<string>
            items={checks}
            label={(id) => stage(id)?.title ?? id}
            render={(id) => <Chip icon={stage(id)?.icon ?? 'check'} label={stage(id)?.label ?? id} />}
            onChange={(next) => setPipeline({ checks: next })}
            onOpen={(id) =>
              setSheet({
                stage: stage(id) ?? { ...BLANK_STAGE, id, title: id, label: id.slice(0, 10) },
                isNew: false,
              })
            }
          />
          <Chip icon="awaiting_approval" label="Approval" locked />
          <Chip icon="merge" label="Merge" locked />
          {draft.pipeline.deploy && (
            <Wiggle item="deploy" label="Deploy" onRemove={() => setPipeline({ deploy: false })}>
              <Chip icon="deploying" label="Deploy" />
            </Wiggle>
          )}
          {draft.pipeline.guardian && (
            <Wiggle item="guardian" label="Guardian" onRemove={() => setPipeline({ guardian: false })}>
              <Chip icon="guardian" label="Guardian" />
            </Wiggle>
          )}
        </div>
        {brokenPipeline && (
          <p className="warning small" data-testid="pipeline-error">
            The PR loop waits: {brokenPipeline}. Approve writes the pipeline shown here.
          </p>
        )}
        {stuck.length > 0 && (
          <p className="warning small" data-testid="stuck-stages">
            PRs wait at {stuck.join(', ')}: its stage file is missing or broken. Tap it to fix it, or remove
            it.
          </p>
        )}
        {!checks.includes('review') && (
          <p className="warning small" data-testid="no-review-warning">
            Without Code review, every PR waits for your approval, even in projects with auto-merge on.
          </p>
        )}
        <p className="muted small">
          Approval follows each project&apos;s auto-merge switch. CI always gates the merge.
        </p>
      </section>

      {/* A preview: nothing on it can be clicked. */}
      <main className="content" inert>
        <BoardView
          board={board}
          projects={board.projects}
          layout={{ ...layout, ...draft.layout }}
          now={now}
          readOnly
          settings={() => null}
        />
      </main>

      {sheet === 'add' && (
        <AddSheet
          topbar={TOPBAR_ITEMS.filter((item) => !draft.layout.topbar.includes(item))}
          spare={stages.filter((s) => !checks.includes(s.id))}
          deploy={draft.pipeline.deploy}
          guardian={draft.pipeline.guardian}
          hiddenDetails={draft.layout.hiddenDetails}
          onAddTopbar={(item) => setLayout({ topbar: [...draft.layout.topbar, item] })}
          onAddStage={(id) => setPipeline({ checks: [...checks, id] })}
          onEditStage={(s) => setSheet({ stage: s, isNew: false })}
          onNewStage={() => setSheet({ stage: BLANK_STAGE, isNew: true })}
          onPipeline={setPipeline}
          onToggleDetail={(detail) =>
            setLayout({ hiddenDetails: toggle(draft.layout.hiddenDetails, detail) })
          }
          onClose={() => setSheet(null)}
        />
      )}

      {sheet !== null && typeof sheet === 'object' && (
        <StageSheet
          key={sheet.stage.id || 'new'}
          stage={sheet.stage}
          isNew={sheet.isNew}
          choices={view.choices}
          taken={(id) => stage(id) !== undefined}
          onSave={saveStage}
          onReset={resetStage}
          onDelete={deleteStage}
          onClose={() => setSheet(null)}
        />
      )}

      {sheet === 'close' && (
        <CloseDialog
          readOnly={readOnly}
          saving={saving}
          error={error}
          onApprove={approve}
          onDiscard={() => router.push('/')}
          onKeepEditing={() => {
            setError(null);
            setSheet(null);
          }}
        />
      )}
    </div>
  );
}
