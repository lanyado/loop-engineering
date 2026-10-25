'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { applyEdits } from '../app/actions';
import { buildBoard, GUARDIAN_NODE, type StageNode } from '../lib/board';
import {
  insert,
  ROW_DETAIL_LABELS,
  toggle,
  TOPBAR_ITEMS,
  TOPBAR_LABELS,
  type Layout,
  type RowDetail,
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
import { ConfirmDialog, EditableRow, Ghost, useGhostPlaces, useReorder, Wiggle } from './editor-parts';
import { FinishedGroup } from './finished-sessions';
import { PipelineRow, type LaneStep, type RowEdit } from './pipeline';
import { KindChip } from './project-kind';
import { fieldsOf, StageSheet, type StageFields } from './stage-sheet';
import { TopbarItem } from './topbar-items';

/*
 * The pencil's editor, like iOS's Control Center: one example project, drawn as the board draws it,
 * where everything that can change wiggles. "−" removes, "+" on a faded item puts it back, dragging
 * (or the arrows) reorders, and tapping a stage edits it. Discard and Save each ask first; only Save
 * changes the user's dashboard and the PR loop. Project order and hiding are on the real board.
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

/** The faded tile that makes a new stage: no stage id can look like this. */
const NEW_STAGE = ':new';

/** A node for something not in the pipeline, drawn faded where it would go. */
const ghostNode = (stage: string, label: string, icon: string): StageNode => ({
  stage,
  label,
  icon,
  custom: true,
  check: false,
  skipped: false,
  skippable: false,
  state: 'todo',
  questions: [],
});

export function Editor({
  layout,
  view,
  example,
  usage,
  now,
  readOnly,
}: {
  layout: Layout;
  view: PipelineView;
  /** The one demo project the editor draws. */
  example: { tree: TreeProject[]; pullRequests: PullRequest[]; questions: Question[] };
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
  const [sheet, setSheet] = useState<'save' | 'discard' | { stage: Stage; isNew: boolean } | null>(null);
  const [saving, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const setLayout = (patch: Partial<Draft['layout']>) =>
    setDraft((d) => ({ ...d, layout: { ...d.layout, ...patch } }));
  const setPipeline = (patch: Partial<Draft['pipeline']>) =>
    setDraft((d) => ({ ...d, pipeline: { ...d.pipeline, ...patch } }));
  /** A stage file to write or delete; a null only stays when the server has a file to remove. */
  const setEdit = (id: string, edit: StageFields | null) =>
    setDraft((d) => {
      const rest = Object.fromEntries(Object.entries(d.edits).filter(([key]) => key !== id));
      const saved = view.stages.find((s) => s.id === id);
      const fileOnServer = saved !== undefined && (!saved.builtin || saved.overridden);
      return { ...d, edits: edit === null && !fileOnServer ? rest : { ...rest, [id]: edit } };
    });
  const { checks } = draft.pipeline;
  const stage = (id: string) => stages.find((s) => s.id === id);
  // Every change to the checks goes through setChecks, so a removed one waits where it last was.
  const { entries: checkEntries, change: setChecks } = useGhostPlaces(
    checks,
    stages.map((s) => s.id),
    (next) => setPipeline({ checks: next }),
  );
  const checkOrder = useReorder(checks, setChecks);

  const board = useMemo(
    () =>
      buildBoard(
        example.tree,
        example.pullRequests,
        example.questions.filter((q) => q.status === 'pending'),
        { pipeline: draft.pipeline, stages },
      ),
    [example, draft.pipeline, stages],
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
    if (!checks.includes(id)) setChecks([...checks, id]);
  };
  /** A built-in's own prompt comes back from the server on Save; until then the sheet says so. */
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
    setChecks(checks.filter((c) => c !== id));
    setEdit(id, null);
  };
  const openStage = (id: string) =>
    setSheet({
      stage: stage(id) ?? { ...BLANK_STAGE, id, title: id, label: id.slice(0, 10) },
      isNew: false,
    });

  const save = () =>
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

  /** A part of the row: "−" hides it on the dashboard, "+" shows it again. */
  const part: RowEdit['part'] = (detail: RowDetail, content) => {
    const props = {
      item: detail,
      label: ROW_DETAIL_LABELS[detail],
      block: detail === 'earlierPrs' || detail === 'finished',
    };
    const flip = () => setLayout({ hiddenDetails: toggle(draft.layout.hiddenDetails, detail) });
    return draft.layout.hiddenDetails.includes(detail) ? (
      <Ghost {...props} onAdd={flip}>
        {content}
      </Ghost>
    ) : (
      <Wiggle {...props} onRemove={flip}>
        {content}
      </Wiggle>
    );
  };

  /**
   * A lane as the editor draws it: the checks wiggle and reorder; stage files not in the pipeline,
   * "New stage" and a removed Deploy or Guardian wait faded where they would go (on the first lane,
   * so a split row offers each once); Approval and Merge are fixed.
   */
  const lane: RowEdit['lane'] = (l, node, first) => {
    const ghost = (n: StageNode, label: string, onAdd: () => void): LaneStep => ({
      key: `+${n.stage}`,
      state: 'todo',
      content: (
        <Ghost item={n.stage} label={label} onAdd={onAdd}>
          {node(n, 'add')}
        </Ghost>
      ),
    });
    const step = (n: StageNode): LaneStep => {
      const optional = n.stage === 'deploying' ? 'deploy' : n.stage === GUARDIAN_NODE ? 'guardian' : null;
      return {
        key: n.stage,
        state: n.state,
        content: n.check ? (
          <Wiggle
            item={n.stage}
            label={stage(n.stage)?.title ?? n.label}
            onRemove={() => setChecks(checks.filter((c) => c !== n.stage))}
            onOpen={() => openStage(n.stage)}
            order={checkOrder(checks.indexOf(n.stage))}
          >
            {node(n)}
          </Wiggle>
        ) : optional && !draft.pipeline[optional] ? (
          // A PR already at a step the pipeline no longer runs: shown, and offered back.
          ghost(n, n.label, () => setPipeline({ [optional]: true })).content
        ) : optional ? (
          <Wiggle item={n.stage} label={n.label} onRemove={() => setPipeline({ [optional]: false })}>
            {node(n)}
          </Wiggle>
        ) : (
          <span className="fixed-node" inert>
            {node(n)}
          </span>
        ),
      };
    };
    // The checks, and (on the first lane only) the stage files not in the pipeline where they were.
    const checkSteps = checkEntries.flatMap(({ item, ghost: off, at }) => {
      const s = stage(item);
      const n = l.nodes.find((x) => x.stage === item);
      if (off)
        return first && s
          ? [ghost(ghostNode(item, s.label, s.icon), s.title, () => setChecks(insert(checks, item, at)))]
          : [];
      return n ? [step(n)] : [];
    });
    const newStage = ghost(ghostNode(NEW_STAGE, 'New stage', 'sparkle'), 'a new stage', () =>
      setSheet({ stage: BLANK_STAGE, isNew: true }),
    );
    const has = (id: string) => l.nodes.some((n) => n.stage === id);
    const deployGhost =
      first && !draft.pipeline.deploy && !has('deploying')
        ? [
            ghost(ghostNode('deploying', 'Deploy', 'deploying'), 'Deploy', () =>
              setPipeline({ deploy: true }),
            ),
          ]
        : [];
    const guardianGhost =
      first && !draft.pipeline.guardian && !has(GUARDIAN_NODE)
        ? [
            ghost(ghostNode(GUARDIAN_NODE, 'Guardian', 'guardian'), 'Guardian', () =>
              setPipeline({ guardian: true }),
            ),
          ]
        : [];
    return [
      ...checkSteps,
      ...(first ? [newStage] : []),
      ...l.nodes
        .filter((n) => !n.check)
        .flatMap((n) => (n.stage === 'merge' ? [step(n), ...deployGhost] : [step(n)])),
      ...guardianGhost,
    ];
  };

  return (
    <div className="app editor" data-testid="editor">
      <header className="topbar editing">
        <div className="topbar-items" aria-label="Top bar">
          <EditableRow<TopbarItemName>
            items={draft.layout.topbar}
            all={TOPBAR_ITEMS}
            label={(item) => TOPBAR_LABELS[item]}
            render={(item) => <TopbarItem item={item} usage={usage} now={now} preview />}
            onChange={(topbar) => setLayout({ topbar })}
          />
        </div>
        <div className="topbar-actions">
          <button
            type="button"
            className="ghost small"
            onClick={() => (changed ? setSheet('discard') : router.push('/'))}
            data-testid="editor-discard"
          >
            Discard
          </button>
          <button
            type="button"
            className="small"
            disabled={!changed}
            onClick={() => setSheet('save')}
            data-testid="editor-save"
          >
            Save
          </button>
        </div>
      </header>

      <section className="editor-notes" aria-label="Editing">
        <p className="muted small">
          An example project with your layout and pipeline. Tap − to remove, + to add back, drag or use the
          arrows to reorder, and tap a stage to change what it checks. Save applies it to your dashboard and
          the PR loop.
        </p>
        {brokenPipeline && (
          <p className="warning small" data-testid="pipeline-error">
            The PR loop waits: {brokenPipeline}. Save writes the pipeline shown here.
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
      </section>

      <main className="content">
        {board.projects.map((p) => (
          <section key={p.project.id} className="project" data-testid="project" data-project={p.project.name}>
            <header className="project-head" inert>
              <div className="project-title">
                <h2>{p.project.name}</h2>
                <KindChip project={p.project} />
              </div>
            </header>
            <ul className="rows">
              {p.rows.map((row) => (
                <PipelineRow
                  key={row.session.id}
                  row={row}
                  folder={p.project.kind === 'folder'}
                  readOnly
                  now={now}
                  edit={{ part, lane }}
                />
              ))}
            </ul>
            {p.finished.length > 0 && part('finished', <FinishedGroup sessions={p.finished} now={now} />)}
          </section>
        ))}
      </main>

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

      {(sheet === 'save' || sheet === 'discard') && (
        <ConfirmDialog
          action={sheet}
          readOnly={readOnly}
          saving={saving}
          error={error}
          onConfirm={sheet === 'save' ? save : () => router.push('/')}
          onKeepEditing={() => {
            setError(null);
            setSheet(null);
          }}
        />
      )}
    </div>
  );
}
