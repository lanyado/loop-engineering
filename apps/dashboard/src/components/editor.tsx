'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition, type MouseEvent } from 'react';
import { savePipeline } from '../app/actions';
import { buildBoard, GUARDIAN_NODE, PLANNER_NODE, type StageNode } from '../lib/board';
import { insert } from '../lib/layout';
import { EXAMPLE_MODELS } from '../lib/models';
import type { PipelineView, PullRequest, Question, Stage, TreeProject } from '../lib/schemas';
import { ConfirmDialog, Ghost, useGhostPlaces, useReorder, Wiggle } from './editor-parts';
import { PipelineRow, type LaneStep, type RowEdit } from './pipeline';
import { fieldsOf, StageSheet, type StageFields } from './stage-sheet';

/*
 * The pencil's editor, like iOS's Control Center: a tab per pipeline (the shared one, then each
 * project), drawn on an example session as the board draws it, where every stage wiggles. "−"
 * removes a stage, "+" on a faded one puts it back, dragging (or the arrows) reorders, and tapping a
 * stage edits its prompt and settings. Discard and Save each ask first; only Save changes the PR
 * loop, and only the tab's pipeline. A project without a pipeline of its own runs the shared one; its
 * first Save gives it its own copy (what `loop init` does). Project order and hiding are on the board.
 */

/** A tab: the shared pipeline (no id), or a project's. */
export interface EditorTab {
  id: number | null;
  name: string;
  kind: 'git' | 'folder';
  /** The project has its own pipeline (always true for the shared tab). */
  own: boolean;
}

export const tabHref = (id: number | null) => (id === null ? '/edit' : `/edit?project=${id}`);

interface Draft {
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

/** A node for something not in the pipeline, drawn faded where it would go. */
const ghostNode = (stage: string, label: string, icon: string): StageNode => ({
  stage,
  label,
  icon,
  custom: true,
  check: false,
  skipped: false,
  notRun: false,
  skippable: false,
  state: 'todo',
  questions: [],
});

/** What the tab's pipeline is, and where Save writes it. */
function ScopeNote({ tab, dir, sharedBy }: { tab: EditorTab; dir: string | null; sharedBy: string[] }) {
  if (tab.id === null)
    return sharedBy.length > 0 ? (
      <>
        The shared pipeline: {sharedBy.join(', ')} {sharedBy.length === 1 ? 'runs' : 'run'} it, having none of{' '}
        {sharedBy.length === 1 ? 'its' : 'their'} own. A new project starts on it.
      </>
    ) : (
      <>The shared pipeline: every project has its own now. A new project starts on this one.</>
    );
  const where = dir && (
    <>
      {' '}
      in <code className="mono">{dir}</code>
    </>
  );
  return tab.own ? (
    <>
      {tab.name}&apos;s own pipeline{where}.
    </>
  ) : (
    <>
      {tab.name} runs the shared pipeline. Save gives it its own{where}, a copy with your changes (what{' '}
      <code className="mono">loop init</code> does there); the shared pipeline stays as it is.
    </>
  );
}

export function Editor({
  view,
  tabs,
  tab,
  sharedBy,
  example,
  now,
  readOnly,
}: {
  /** The pipeline of the tab shown. */
  view: PipelineView;
  tabs: EditorTab[];
  tab: EditorTab;
  /** The projects that run the shared pipeline (they have none of their own). */
  sharedBy: string[];
  /** The demo session the editor draws: a git project's, or a folder project's on a folder tab. */
  example: { tree: TreeProject[]; pullRequests: PullRequest[]; questions: Question[] };
  now: number;
  readOnly: boolean;
}) {
  const router = useRouter();
  const { checks: savedChecks, deploy, guardian, error: brokenPipeline } = view.pipeline;
  const initial: Draft = { pipeline: { checks: savedChecks, deploy, guardian }, edits: {} };
  const [draft, setDraft] = useState<Draft>(initial);
  const [stages, setStages] = useState<Stage[]>(view.stages);
  // The Guardian's and the Planner's instructions: stage files that are never checks.
  const [instructions, setInstructions] = useState<Record<string, Stage>>({
    [GUARDIAN_NODE]: view.guardian,
    ...(view.planner ? { [PLANNER_NODE]: view.planner } : {}),
  });
  const savedInstructions = (id: string): Stage | undefined =>
    id === GUARDIAN_NODE ? view.guardian : id === PLANNER_NODE ? view.planner : undefined;
  const [sheet, setSheet] = useState<'save' | 'discard' | { stage: Stage; isNew: boolean } | null>(null);
  /** Where Discard goes: the board, or the tab picked while this one had changes. */
  const [leaveTo, setLeaveTo] = useState('/');
  const [saving, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const setPipeline = (patch: Partial<Draft['pipeline']>) =>
    setDraft((d) => ({ ...d, pipeline: { ...d.pipeline, ...patch } }));
  /** A stage file to write or delete; a null only stays when the server has a file to remove. */
  const setEdit = (id: string, edit: StageFields | null) =>
    setDraft((d) => {
      const rest = Object.fromEntries(Object.entries(d.edits).filter(([key]) => key !== id));
      const saved = savedInstructions(id) ?? view.stages.find((s) => s.id === id);
      // A broken file is on the server too, even where it changes nothing (a built-in's, unread).
      const fileOnServer =
        saved !== undefined && (!saved.builtin || saved.overridden || saved.error !== undefined);
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
  const folder = tab.kind === 'folder';
  // A project on the shared pipeline: Save gives it its own copy, even with nothing changed.
  const makesOwn = tab.id !== null && !tab.own;
  /** Checks the loop would hold PRs at: their stage file is missing or broken. */
  const stuck = checks.filter((id) => !stage(id) || stage(id)?.error);

  const saveStage = (id: string, fields: StageFields) => {
    setSheet(null);
    const own = instructions[id];
    if (own) {
      if (JSON.stringify(fieldsOf(own)) === JSON.stringify(fields) && !own.error) return;
      setInstructions((all) => ({ ...all, [id]: { ...own, ...fields, overridden: true, error: undefined } }));
      setEdit(id, fields);
      return;
    }
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
    const reset = (s: Stage, original: Stage | undefined): Stage =>
      original && !original.overridden ? original : { ...s, prompt: '', overridden: false };
    const own = instructions[id];
    if (own) setInstructions((all) => ({ ...all, [id]: reset(own, savedInstructions(id)) }));
    else
      setStages((all) =>
        all.map((s) =>
          s.id === id
            ? reset(
                s,
                view.stages.find((v) => v.id === id),
              )
            : s,
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
      stage: instructions[id] ?? stage(id) ?? { ...BLANK_STAGE, id, title: id, label: id.slice(0, 10) },
      isNew: false,
    });

  const save = () =>
    start(async () => {
      setError(null);
      // An unreadable pipeline.json is replaced by what the editor shows.
      const update = { pipeline: draft.pipeline, stages: draft.edits };
      const result = await savePipeline(tab.id === null ? { update } : { projectId: tab.id, update });
      if (result.ok) router.push('/');
      else setError(result.error);
    });
  /** Another tab: asks first when this one has changes it would drop. */
  const openTab = (e: MouseEvent, href: string) => {
    if (!changed) return;
    e.preventDefault();
    setLeaveTo(href);
    setSheet('discard');
  };
  const discard = (href: string) => {
    if (!changed) return router.push(href);
    setLeaveTo(href);
    setSheet('discard');
  };

  /** The Planner node: it always runs, so it only opens its instructions (when the server has them). */
  const planner: RowEdit['planner'] = (n) =>
    instructions[PLANNER_NODE] ? (
      <Wiggle item={PLANNER_NODE} label="Planner" onOpen={() => openStage(PLANNER_NODE)}>
        {n}
      </Wiggle>
    ) : (
      <span className="fixed-node" inert>
        {n}
      </span>
    );

  /**
   * A lane as the editor draws it: the checks wiggle and reorder; stage files not in the pipeline and
   * a removed Deploy or Guardian wait faded where they would go (on the first lane, so a split row
   * offers each once); tapping Guardian edits its instructions; Approval and Merge are fixed.
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
          <Wiggle
            item={n.stage}
            label={n.label}
            onRemove={() => setPipeline({ [optional]: false })}
            onOpen={optional === 'guardian' ? () => openStage(GUARDIAN_NODE) : undefined}
          >
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
      ...l.nodes
        .filter((n) => !n.check)
        .flatMap((n) => (n.stage === 'merge' ? [step(n), ...deployGhost] : [step(n)])),
      ...guardianGhost,
    ];
  };

  return (
    <div className="app editor" data-testid="editor">
      <header className="topbar editing">
        <nav className="editor-tabs" aria-label="Pipelines">
          {tabs.map((t) => {
            const href = tabHref(t.id);
            const current = t.id === tab.id;
            return (
              <Link
                key={t.id ?? 'shared'}
                href={href}
                className={`editor-tab${current ? ' current' : ''}${t.own ? '' : ' on-shared'}`}
                aria-current={current ? 'page' : undefined}
                title={
                  t.id === null
                    ? 'Every project without a pipeline of its own runs this one'
                    : t.own
                      ? `${t.name} has its own pipeline`
                      : `${t.name} runs the shared pipeline until you save one here or run loop init`
                }
                onClick={(e) => openTab(e, href)}
                data-testid="editor-tab"
                data-project={t.id ?? 'shared'}
              >
                {t.name}
              </Link>
            );
          })}
        </nav>
        <div className="topbar-actions">
          <button
            type="button"
            className="ghost small"
            onClick={() => discard('/')}
            data-testid="editor-discard"
          >
            Discard
          </button>
          <button
            type="button"
            className="small"
            disabled={!changed && !makesOwn}
            onClick={() => setSheet('save')}
            data-testid="editor-save"
          >
            Save
          </button>
        </div>
      </header>

      <section className="editor-notes" aria-label="About this pipeline">
        <p className="muted small" data-testid="pipeline-scope">
          <ScopeNote tab={tab} dir={view.project?.dir ?? null} sharedBy={sharedBy} />
        </p>
        {folder && (
          <p className="muted small" data-testid="folder-note">
            Folder projects have no PRs: only the Planner&apos;s instructions apply to {tab.name}.
          </p>
        )}
        {brokenPipeline && (
          <p className="warning small" data-testid="pipeline-error">
            The PR loop waits: {brokenPipeline}. Save writes the pipeline shown here.
          </p>
        )}
        {!folder && stuck.length > 0 && (
          <p className="warning small" data-testid="stuck-stages">
            PRs wait at {stuck.join(', ')}: its stage file is missing or broken. Tap it to fix it, or remove
            it.
          </p>
        )}
        {!folder && !checks.includes('review') && (
          <p className="warning small" data-testid="no-review-warning">
            Without Code review, every PR waits for your approval, even in projects with auto-merge on.
          </p>
        )}
      </section>

      <main className="content">
        {board.projects.map((p) => (
          <section key={p.project.id} className="project" data-testid="project" data-project={tab.name}>
            <header className="project-head">
              <div className="project-title" inert>
                <h2>{tab.id === null ? 'Shared pipeline' : tab.name}</h2>
                <span className="muted small">Example session</span>
              </div>
              {!folder && (
                <span className="project-buttons">
                  <button
                    type="button"
                    className="secondary small"
                    onClick={() => setSheet({ stage: BLANK_STAGE, isNew: true })}
                    data-testid="new-stage"
                  >
                    + New stage
                  </button>
                </span>
              )}
            </header>
            <ul className="rows">
              {p.rows.map((row) => (
                <PipelineRow
                  key={row.session.id}
                  row={row}
                  folder={p.project.kind === 'folder'}
                  readOnly
                  now={now}
                  edit={{ lane, planner }}
                  models={EXAMPLE_MODELS}
                />
              ))}
            </ul>
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
          target={
            tab.id === null
              ? 'the shared pipeline'
              : makesOwn
                ? `${tab.name}'s own new pipeline`
                : `${tab.name}'s pipeline`
          }
          readOnly={readOnly}
          saving={saving}
          error={error}
          onConfirm={sheet === 'save' ? save : () => router.push(leaveTo)}
          onKeepEditing={() => {
            setError(null);
            setLeaveTo('/');
            setSheet(null);
          }}
        />
      )}
    </div>
  );
}
