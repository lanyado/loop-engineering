import { ValidationError } from '@loop-engineering/core';
import {
  RESERVED_STAGE_IDS,
  rigorByLevel,
  STAGE_ACCESS,
  STAGE_ICONS,
  STAGE_RUNS,
  skipCheck,
  type EditableStageLibrary,
} from '@loop-engineering/loop';
import { bodyLimit } from 'hono/body-limit';
import * as z from 'zod';
import type { ServerModule } from '../context.js';
import { idParam } from '../ids.js';

/**
 * The PR loop's pipeline and stage files (packages/loop/stages, overridden by STAGES_DIR), for the
 * dashboard's editor. Served whether or not the loop runs, so the pipeline can be set up first.
 *
 *   GET /pipeline   { pipeline: { checks, deploy, guardian }, stages: [{ id, title, label, icon, access,
 *                     runs, prompt, builtin, overridden }], guardian: <the Guardian's instructions, the
 *                     same shape>, planner: <the Planner's instructions, the same shape>,
 *                     choices: { icons, access, runs, reserved },
 *                     rigor: { fast, light, standard, thorough } }
 *                   (choices: the values a stage may take and the ids it may not, for the editor;
 *                   rigor: the checks of the pipeline each rigor level runs, from the loop's policy)
 *   POST /prs/:id/skip  { check, skip } -> { pullRequest }: skips one check of the pipeline for one PR,
 *                   or brings it back (packages/loop/src/skip.ts); 400 for a PR not at a check or a
 *                   check outside the pipeline. Works with the loop off; a running loop steps that PR at once
 *                   (a job running the skipped check is stopped, a check brought back starts).
 *   PUT /pipeline   { pipeline, stages?: { [id]: { title, label, icon, access, runs, prompt } | null } }
 *                   -> the same as GET. Writes STAGES_DIR/<id>.md and pipeline.json; null deletes a
 *                   custom stage or resets a built-in one ("guardian" and "planner" are their instructions). Everything is validated before anything is
 *                   written; a stage still in the pipeline cannot be deleted (400).
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

export function pipelineModule({
  stages,
  pokePr = () => undefined,
}: {
  stages: EditableStageLibrary;
  /** Tells a running PR loop to step this PR now (a skip changed what it waits for). */
  pokePr?: (prId: number) => void;
}): ServerModule {
  const choices = {
    icons: STAGE_ICONS,
    access: STAGE_ACCESS,
    runs: STAGE_RUNS,
    reserved: RESERVED_STAGE_IDS,
  };
  const view = () => {
    const pipeline = stages.pipeline();
    return {
      pipeline,
      stages: stages.stages(),
      guardian: stages.guardian(),
      planner: stages.planner(),
      choices,
      rigor: rigorByLevel(pipeline.checks),
    };
  };
  return {
    name: 'pipeline',
    api(api, ctx) {
      api.get(PIPELINE_PATH, (c) => c.json(view()));
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
        const parsed = pipelineUpdate.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) return c.json({ error: z.prettifyError(parsed.error) }, 400);
        try {
          stages.update(parsed.data);
        } catch (error) {
          // The folder cannot be written (permissions, disk full): say so, not "internal error".
          // Filesystem failures carry the system call that failed; anything else is a real bug.
          if (error instanceof ValidationError || !(error instanceof Error && 'syscall' in error))
            throw error;
          return c.json({ error: `could not write the stage files: ${(error as Error).message}` }, 500);
        }
        return c.json(view());
      });
    },
  };
}
