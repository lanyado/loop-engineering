import { STAGE_ACCESS, STAGE_ICONS, STAGE_RUNS, type EditableStageLibrary } from '@loop-engineering/loop';
import { bodyLimit } from 'hono/body-limit';
import * as z from 'zod';
import type { ServerModule } from '../context.js';

/**
 * The PR loop's pipeline and stage files (packages/loop/stages, overridden by STAGES_DIR), for the
 * dashboard's editor. Served whether or not the loop runs, so the pipeline can be set up first.
 *
 *   GET /pipeline   { pipeline: { checks, deploy, guardian }, stages: [{ id, title, label, icon, access,
 *                     runs, prompt, builtin, overridden }] }
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

export function pipelineModule({ stages }: { stages: EditableStageLibrary }): ServerModule {
  const view = () => ({ pipeline: stages.pipeline(), stages: stages.stages() });
  return {
    name: 'pipeline',
    api(api) {
      api.get('/pipeline', (c) => c.json(view()));
      // 30 stages of 4,000 characters, at up to 3 bytes each in UTF-8.
      api.put('/pipeline', bodyLimit({ maxSize: 400 * 1024 }), async (c) => {
        const parsed = pipelineUpdate.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) return c.json({ error: z.prettifyError(parsed.error) }, 400);
        stages.update(parsed.data);
        return c.json(view());
      });
    },
  };
}
