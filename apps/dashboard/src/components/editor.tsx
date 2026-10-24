'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition, type HTMLAttributes, type ReactNode } from 'react';
import { applyEdits } from '../app/actions';
import { buildBoard } from '../lib/board';
import {
  move,
  ROW_DETAIL_LABELS,
  ROW_DETAILS,
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
import { Icon } from './pipeline';
import { Switch } from './settings-controls';
import { StageSheet, type StageFields } from './stage-sheet';
import { TopbarItem } from './topbar-items';

/*
 * The pencil's editor, like iOS's Control Center: everything wiggles, "−" removes, dragging (or the
 * arrows) reorders, "+" adds back. It edits a draft of the user's own layout and pipeline, drawn
 * on the demo board; ✕ asks to Discard or Approve, and only Approve changes their dashboard.
 */

interface Draft {
  layout: Layout;
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

/** One item in edit mode: it wiggles, and "−" on its corner removes it. */
function Wiggle({
  item,
  label,
  onRemove,
  children,
  ...drag
}: {
  item: string;
  label: string;
  onRemove: () => void;
  children: ReactNode;
} & Pick<HTMLAttributes<HTMLSpanElement>, 'draggable' | 'onDragStart' | 'onDragOver' | 'onDrop'>) {
  return (
    <span className="wiggle" data-testid="editable-item" data-item={item} {...drag}>
      <button type="button" className="wiggle-remove" aria-label={`Remove ${label}`} onClick={onRemove}>
        −
      </button>
      {children}
    </span>
  );
}

/** A row of wiggling items: drag or the arrows reorder, "−" removes. */
function EditableRow<T extends string>({
  items,
  label,
  render,
  onChange,
  onOpen,
}: {
  items: T[];
  label: (item: T) => string;
  render: (item: T) => ReactNode;
  onChange: (items: T[]) => void;
  onOpen?: (item: T) => void;
}) {
  const [dragged, setDragged] = useState<number | null>(null);
  return (
    <>
      {items.map((item, i) => (
        <Wiggle
          key={item}
          item={item}
          label={label(item)}
          onRemove={() => onChange(items.filter((x) => x !== item))}
          draggable
          onDragStart={() => setDragged(i)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => {
            if (dragged !== null) onChange(move(items, dragged, i));
            setDragged(null);
          }}
        >
          {onOpen ? (
            <button
              type="button"
              className="wiggle-body"
              onClick={() => onOpen(item)}
              aria-label={`Edit ${label(item)}`}
            >
              {render(item)}
            </button>
          ) : (
            <span className="wiggle-body">{render(item)}</span>
          )}
          <span className="wiggle-move">
            <button
              type="button"
              aria-label={`Move ${label(item)} left`}
              disabled={i === 0}
              onClick={() => onChange(move(items, i, i - 1))}
            >
              ‹
            </button>
            <button
              type="button"
              aria-label={`Move ${label(item)} right`}
              disabled={i === items.length - 1}
              onClick={() => onChange(move(items, i, i + 1))}
            >
              ›
            </button>
          </span>
        </Wiggle>
      ))}
    </>
  );
}

function Chip({ icon, label, locked }: { icon: string; label: string; locked?: boolean }) {
  return (
    <span className={`stage-chip${locked ? ' locked' : ''}`}>
      <Icon kind={icon} />
      {label}
      {locked && <span className="sr-only"> (fixed)</span>}
    </span>
  );
}

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
  const initial: Draft = { layout, pipeline: { checks: savedChecks, deploy, guardian }, edits: {} };
  const [draft, setDraft] = useState<Draft>(initial);
  const [stages, setStages] = useState<Stage[]>(view.stages);
  const [sheet, setSheet] = useState<'add' | 'close' | { stage: Stage; isNew: boolean } | null>(null);
  const [saving, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const setLayout = (patch: Partial<Layout>) =>
    setDraft((d) => ({ ...d, layout: { ...d.layout, ...patch } }));
  const setPipeline = (patch: Partial<Draft['pipeline']>) =>
    setDraft((d) => ({ ...d, pipeline: { ...d.pipeline, ...patch } }));
  const { checks } = draft.pipeline;
  const stage = (id: string) => stages.find((s) => s.id === id);

  const board = useMemo(
    () =>
      buildBoard(
        demo.tree,
        demo.pullRequests,
        demo.questions.filter((q) => q.status === 'pending'),
        { pipeline: draft.pipeline, stages },
      ),
    [demo, draft.pipeline, stages],
  );
  const changed = brokenPipeline !== undefined || JSON.stringify(draft) !== JSON.stringify(initial);

  const saveStage = (id: string, fields: StageFields) => {
    const existing = stage(id);
    setStages((all) =>
      existing
        ? all.map((s) => (s.id === id ? { ...s, ...fields, overridden: s.builtin } : s))
        : [...all, { id, ...fields, builtin: false, overridden: false }],
    );
    setDraft((d) => ({
      ...d,
      edits: { ...d.edits, [id]: fields },
      pipeline: {
        ...d.pipeline,
        checks: d.pipeline.checks.includes(id) ? d.pipeline.checks : [...d.pipeline.checks, id],
      },
    }));
    setSheet(null);
  };
  const resetStage = (id: string) => {
    const s = stage(id);
    // A built-in's text comes back from the server on Approve; a custom stage is deleted.
    if (s && !s.builtin) setStages((all) => all.filter((x) => x.id !== id));
    else setStages((all) => all.map((x) => (x.id === id ? { ...x, overridden: false } : x)));
    setDraft((d) => ({ ...d, edits: { ...d.edits, [id]: null } }));
    setSheet(null);
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
      const result = await applyEdits({ layout: draft.layout, ...(pipeline ? { pipeline } : {}) });
      if (result.ok) router.push('/');
      else setError(result.error);
    });

  const hiddenTopbar = TOPBAR_ITEMS.filter((item) => !draft.layout.topbar.includes(item));
  const spare = stages.filter((s) => !checks.includes(s.id));

  return (
    <div className="app editor" data-testid="editor">
      <header className="topbar editing">
        <div className="topbar-items" aria-label="Top bar">
          <EditableRow<TopbarItemName>
            items={draft.layout.topbar}
            label={(item) => TOPBAR_LABELS[item]}
            render={(item) => <TopbarItem item={item} usage={usage} now={now} />}
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
            onOpen={(id) => {
              const s = stage(id);
              if (s) setSheet({ stage: s, isNew: false });
            }}
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
          layout={draft.layout}
          now={now}
          readOnly
          settings={() => null}
        />
      </main>

      {sheet === 'add' && (
        <div className="sheet-backdrop" role="dialog" aria-modal="true" aria-label="Add">
          <div className="editor-sheet stack" data-testid="add-sheet">
            <h2>Add</h2>
            <h3>Top bar</h3>
            {hiddenTopbar.length === 0 && <p className="muted small">Everything is in the top bar.</p>}
            <div className="add-grid">
              {hiddenTopbar.map((item) => (
                <button
                  key={item}
                  type="button"
                  className="ghost"
                  onClick={() => setLayout({ topbar: [...draft.layout.topbar, item] })}
                >
                  + {TOPBAR_LABELS[item]}
                </button>
              ))}
            </div>
            <h3>Pipeline</h3>
            <div className="add-grid">
              {spare.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="ghost"
                  onClick={() => setPipeline({ checks: [...checks, s.id] })}
                >
                  + <Chip icon={s.icon} label={s.title} />
                </button>
              ))}
              {!draft.pipeline.deploy && (
                <button type="button" className="ghost" onClick={() => setPipeline({ deploy: true })}>
                  + <Chip icon="deploying" label="Deploy watch" />
                </button>
              )}
              {!draft.pipeline.guardian && (
                <button type="button" className="ghost" onClick={() => setPipeline({ guardian: true })}>
                  + <Chip icon="guardian" label="Production Guardian" />
                </button>
              )}
              <button
                type="button"
                onClick={() => setSheet({ stage: BLANK_STAGE, isNew: true })}
                data-testid="new-stage"
              >
                + New stage
              </button>
            </div>
            <h3>On each row</h3>
            {ROW_DETAILS.map((detail) => (
              <Switch
                key={detail}
                label={ROW_DETAIL_LABELS[detail]}
                checked={!draft.layout.hiddenDetails.includes(detail)}
                onChange={() => setLayout({ hiddenDetails: toggle(draft.layout.hiddenDetails, detail) })}
              />
            ))}
            <button type="button" className="ghost" onClick={() => setSheet(null)}>
              Done
            </button>
          </div>
        </div>
      )}

      {sheet !== null && typeof sheet === 'object' && (
        <StageSheet
          key={sheet.stage.id || 'new'}
          stage={sheet.stage}
          isNew={sheet.isNew}
          inPipeline={checks.includes(sheet.stage.id)}
          taken={(id) => stage(id) !== undefined}
          onSave={saveStage}
          onReset={resetStage}
          onClose={() => setSheet(null)}
        />
      )}

      {sheet === 'close' && (
        <div className="sheet-backdrop" role="alertdialog" aria-modal="true" aria-label="Apply the changes?">
          <div className="editor-sheet stack" data-testid="close-dialog">
            <h2>Apply these changes to your dashboard?</h2>
            <p className="muted">
              Approve saves the layout and the pipeline; the PR loop uses the new pipeline from its next step.
            </p>
            {readOnly && (
              <p className="warning small">Demo data is read-only: connect a server to apply changes.</p>
            )}
            {error && (
              <p className="error small" role="alert">
                {error}
              </p>
            )}
            <div className="row-actions">
              <button
                type="button"
                disabled={readOnly || saving}
                onClick={approve}
                data-testid="editor-approve"
              >
                {saving ? 'Applying…' : 'Approve'}
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => router.push('/')}
                data-testid="editor-discard"
              >
                Discard
              </button>
              <button type="button" className="ghost" onClick={() => setSheet(null)}>
                Keep editing
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
