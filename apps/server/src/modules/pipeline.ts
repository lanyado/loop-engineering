import { ValidationError, type Project } from '@loop-engineering/core';
import {
  RESERVED_STAGE_IDS,
  STAGE_ACCESS,
  STAGE_ICONS,
  STAGE_RUNS,
  projectStagesDir,
  skipCheck,
  type ProjectStageFiles,
  type StageLibrary,
} from '@loop-engineering/loop';
import { bodyLimit } from 'hono/body-limit';
import type { Context } from 'hono';
import * as z from 'zod';
import type { ServerModule } from '../context.js';
import { idParam } from '../ids.js';

/**
 * The PR loop's pipeline and stage files, for the dashboard's editor: the shared ones (packages/loop/stages,
 * overridden by STAGES_DIR) and each project's own (.loop-engineering/ in its folder or first repo, see
 * ProjectStageFiles). Served whether or not the loop runs, so the pipeline can be set up first.
 *
 *   GET /pipeline   { pipeline: { checks, deploy, guardian }, stages: [{ id, title, label, icon, access,
 *                     runs, prompt, builtin, overridden }], guardian: <the Guardian's instructions, the
 *                     same shape>, planner: <the Planner's instructions, the same shape>,
 *                     choices: { icons, access, runs, reserved },
 *                     projects: { [projectId]: { pipeline, stages } } }
 *                   The shared pipeline, which every project without its own folder runs, and in
 *                   `projects` the pipeline of each project that has one (what the board draws).
 *                   (choices: the values a stage may take and the ids it may not, for the editor)
 *   GET /pipeline?project=<id>
 *                   The pipeline that project runs, the same shape without `projects`, plus
 *                   project: { id, own, dir }: own is whether it has its own folder, dir where that
 *                   folder is (or would be; null for a project with no folder). 404 for an unknown project.
 *   PUT /pipeline[?project=<id>]
 *                   { pipeline, stages?: { [id]: { title, label, icon, access, runs, prompt } | null } }
 *                   -> the same as GET. Writes <id>.md and pipeline.json in the shared folder, or in the
 *                   project's own one, which it first creates as a copy of the shared one if the project
 *                   has none; null deletes a custom stage or resets a built-in one ("guardian" and
 *                   "planner" are their instructions). Everything is validated before anything is
 *                   written; a stage still in the pipeline cannot be deleted (400).
 *   POST /pipeline?project=<id>
 *                   Gives the project its own folder, a copy of the shared one (what `loop init` does):
 *                   201 with the GET body and created: true, or 200 and created: false when it had one.
 *   POST /prs/:id/skip  { check, skip } -> { pullRequest }: skips one check of the PR's pipeline for one PR,
 *                   or brings it back (packages/loop/src/skip.ts); 400 for a PR not at a check or a
 *                   check outside the pipeline. Works with the loop off; a running loop steps that PR at once
 *                   (a job running the skipped check is stopped, a check brought back starts).
 *
 * This schema checks the shape; the stage library checks ids, sizes and the pipeline (its
 * ValidationError is a 400, see app.ts).
 */
const stageFields = z.strictObject({
  title: z.string(),
  label: z.string(),
  icon: z.enum(STAGE_ICONS),
  access: z.enum(STAGE_ACCESS),
  runs: z.enum(STAGE_RUNS),
  prompt: z.string(),
});
const pipelineUpdate = z.strictObject({
  pipeline: z.strictObject({ checks: z.array(z.string()), deploy: z.boolean(), guardian: z.boolean() }),
  stages: z
    .record(z.string(), stageFields.nullable())
    .refine((s) => Object.keys(s).length <= 30, 'at most 30 stages per change')
    .optional(),
});

/** Under /api; app.ts gives PUT here a larger body limit than the rest of /api. */
export const PIPELINE_PATH = '/pipeline';

const skipBody = z.strictObject({ check: z.string().max(32), skip: z.boolean() });

/** Turns a failed write to the folder (permissions, disk full) into a 500 that says so. */
function writing<T>(c: Context, write: () => T): T | Response {
  try {
    return write();
  } catch (error) {
    // Filesystem failures carry the system call that failed; anything else is a real bug.
    if (error instanceof ValidationError || !(error instanceof Error && 'syscall' in error)) throw error;
    return c.json({ error: `could not write the stage files: ${error.message}` }, 500);
  }
}

export function pipelineModule({
  stages,
  pokePr = () => undefined,
}: {
  stages: ProjectStageFiles;
  /** Tells a running PR loop to step this PR now (a skip changed what it waits for). */
  pokePr?: (prId: number) => void;
}): ServerModule {
  const choices = {
    icons: STAGE_ICONS,
    access: STAGE_ACCESS,
    runs: STAGE_RUNS,
    reserved: RESERVED_STAGE_IDS,
  };
  const view = (library: StageLibrary) => ({
    pipeline: library.pipeline(),
    stages: library.stages(),
    guardian: library.guardian(),
    planner: library.planner(),
    choices,
  });
  const projectView = (project: Project) => ({
    ...view(stages.forProject(project)),
    project: { id: project.id, own: stages.ownLibrary(project) !== null, dir: projectStagesDir(project) },
  });
  return {
    name: 'pipeline',
    api(api, ctx) {
      /** The project the query names; undefined for the shared pipeline. */
      const projectOf = (c: Context): Project | undefined => {
        const raw = c.req.query('project');
        if (raw === undefined) return undefined;
        const id = idParam.safeParse(raw);
        if (!id.success) throw new ValidationError('the project id must be a positive whole number');
        return ctx.store.projects.require(id.data); // unknown: NotFoundError, a 404 (app.ts)
      };
      const sharedView = () => ({
        ...view(stages.shared),
        projects: Object.fromEntries(
          ctx.store.projects.list().flatMap((p) => {
            const own = stages.ownLibrary(p);
            return own ? [[p.id, { pipeline: own.pipeline(), stages: own.stages() }]] : [];
          }),
        ),
      });
      api.get(PIPELINE_PATH, (c) => {
        const project = projectOf(c);
        return c.json(project ? projectView(project) : sharedView());
      });
      api.post(PIPELINE_PATH, (c) => {
        const project = projectOf(c);
        if (!project) return c.json({ error: 'name the project: POST /pipeline?project=<id>' }, 400);
        const done = writing(c, () => stages.init(project));
        if (done instanceof Response) return done;
        return c.json({ ...projectView(project), created: done.created }, done.created ? 201 : 200);
      });
      api.post('/prs/:id/skip', async (c) => {
        const parsed = skipBody.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) return c.json({ error: z.prettifyError(parsed.error) }, 400);
        // An unknown PR is a NotFoundError: 404 (app.ts).
        const id = idParam.safeParse(c.req.param('id'));
        if (!id.success) return c.json({ error: 'the PR id must be a positive whole number' }, 400);
        const pullRequest = skipCheck(ctx.store, stages, id.data, parsed.data.check, parsed.data.skip);
        pokePr(id.data);
        return c.json({ pullRequest });
      });
      // 30 stages of 4,000 characters, at up to 3 bytes each in UTF-8.
      api.put(PIPELINE_PATH, bodyLimit({ maxSize: 400 * 1024 }), async (c) => {
        const project = projectOf(c);
        const parsed = pipelineUpdate.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) return c.json({ error: z.prettifyError(parsed.error) }, 400);
        const change = parsed.data;
        const done = writing(c, () =>
          project ? stages.init(project, change) : stages.shared.update(change),
        );
        if (done instanceof Response) return done;
        return c.json(project ? projectView(project) : sharedView());
      });
    },
  };
}
