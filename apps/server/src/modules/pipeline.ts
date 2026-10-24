import { STAGE_ACCESS, STAGE_ICONS, STAGE_RUNS, type EditableStageLibrary } from '@loop-engineering/loop';
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
 */
const stageFields = z.strictObject({
  title: z.string().max(60),
  label: z.string().max(10),
  icon: z.enum(STAGE_ICONS),
  access: z.enum(STAGE_ACCESS),
  runs: z.enum(STAGE_RUNS),
  prompt: z.string().max(18_000),
});
const pipelineUpdate = z.strictObject({
  pipeline: z.strictObject({
    checks: z.array(z.string().max(32)).max(12),
    deploy: z.boolean(),
    guardian: z.boolean(),
  }),
  stages: z.record(z.string().max(32), stageFields.nullable()).optional(),
});

export function pipelineModule({ stages }: { stages: EditableStageLibrary }): ServerModule {
  const view = () => ({ pipeline: stages.pipeline(), stages: stages.stages() });
  return {
    name: 'pipeline',
    api(api) {
      api.get('/pipeline', (c) => c.json(view()));
      api.put('/pipeline', async (c) => {
        const raw: unknown = await c.req.json().catch(() => null);
        const parsed = pipelineUpdate.safeParse(raw);
        if (!parsed.success) return c.json({ error: z.prettifyError(parsed.error) }, 400);
        if (Object.keys(parsed.data.stages ?? {}).length > 30)
          return c.json({ error: 'at most 30 stages per change' }, 400);
        stages.update(parsed.data); // a ValidationError becomes a 400 (app.ts)
        return c.json(view());
      });
    },
  };
}
