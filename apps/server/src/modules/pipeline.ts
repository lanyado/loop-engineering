import { ValidationError } from '@loop-engineering/core';
import {
  RESERVED_STAGE_IDS,
  STAGE_ACCESS,
  STAGE_ICONS,
  STAGE_RUNS,
  type EditableStageLibrary,
} from '@loop-engineering/loop';
import { bodyLimit } from 'hono/body-limit';
import * as z from 'zod';
import type { ServerModule } from '../context.js';

/**
 * The PR loop's pipeline and stage files (packages/loop/stages, overridden by STAGES_DIR), for the
 * dashboard's editor. Served whether or not the loop runs, so the pipeline can be set up first.
 *
 *   GET /pipeline   { pipeline: { checks, deploy, guardian }, stages: [{ id, title, label, icon, access,
 *                     runs, prompt, builtin, overridden }], choices: { icons, access, runs, reserved } }
 *                   (choices: the values a stage may take and the ids it may not, for the editor)
 *   PUT /pipeline   { pipeline, stages?: { [id]: { title, label, icon, access, runs, prompt } | null } }
 *                   -> the same as GET. Writes STAGES_DIR/<id>.md and pipeline.json; null deletes a
 *                   custom stage or resets a built-in one. Everything is validated before anything is
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

export function pipelineModule({ stages }: { stages: EditableStageLibrary }): ServerModule {
  const choices = {
    icons: STAGE_ICONS,
    access: STAGE_ACCESS,
    runs: STAGE_RUNS,
    reserved: RESERVED_STAGE_IDS,
  };
  const view = () => ({ pipeline: stages.pipeline(), stages: stages.stages(), choices });
  return {
    name: 'pipeline',
    api(api) {
      api.get(PIPELINE_PATH, (c) => c.json(view()));
      // 30 stages of 4,000 characters, at up to 3 bytes each in UTF-8.
      api.put(PIPELINE_PATH, bodyLimit({ maxSize: 400 * 1024 }), async (c) => {
        const parsed = pipelineUpdate.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) return c.json({ error: z.prettifyError(parsed.error) }, 400);
        try {
          stages.update(parsed.data);
        } catch (error) {
          if (error instanceof ValidationError) throw error; // a 400 (app.ts)
          // The folder cannot be written (permissions, disk full): say so, not "internal error".
          return c.json({ error: `could not write the stage files: ${(error as Error).message}` }, 500);
        }
        return c.json(view());
      });
    },
  };
}
