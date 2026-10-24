import { QUESTION_LIMITS } from '@loop-engineering/ask-human';
import { QUESTION_STATUSES } from '@loop-engineering/core';
import { Hono } from 'hono';
import * as z from 'zod';
import { idParam } from '../ids.js';
import type { ServerContext } from '../context.js';

const statusList = z
  .string()
  .transform((s) => s.split(',').map((x) => x.trim()))
  .pipe(z.array(z.enum(QUESTION_STATUSES)));
const listQuery = z.object({
  status: statusList.optional(),
  sessionId: idParam.optional(),
});
const answerBody = z.object({ answer: z.string().trim().min(1).max(QUESTION_LIMITS.answer) });

/**
 * GET  /questions?status=pending[,answered,defaulted]&sessionId=N  ->  { questions }
 *      Pending-only lists come soonest deadline first; others newest first.
 * GET  /questions/:id                                              ->  { question }
 * POST /questions/:id/answer  { answer }                          ->  200 { accepted: true, question }
 *      409 { accepted: false, question } when it was already answered or defaulted (first answer wins).
 */
export function questionRoutes(ctx: ServerContext): Hono {
  const api = new Hono();

  api.get('/questions', (c) => {
    const query = listQuery.safeParse(c.req.query());
    if (!query.success) return c.json({ error: z.prettifyError(query.error) }, 400);
    const { status, sessionId } = query.data;
    const onlyPending = status?.length === 1 && status[0] === 'pending' && sessionId === undefined;
    const questions = onlyPending
      ? ctx.store.questions.listPending()
      : ctx.store.questions.list({
          ...(status ? { status } : {}),
          ...(sessionId !== undefined ? { sessionId } : {}),
        });
    return c.json({ questions });
  });

  api.get('/questions/:id', (c) => {
    const id = idParam.safeParse(c.req.param('id'));
    if (!id.success) return c.json({ error: 'question id must be a positive integer' }, 400);
    const question = ctx.store.questions.get(id.data);
    return question ? c.json({ question }) : c.json({ error: `question ${id.data} not found` }, 404);
  });

  api.post('/questions/:id/answer', async (c) => {
    const id = idParam.safeParse(c.req.param('id'));
    if (!id.success) return c.json({ error: 'question id must be a positive integer' }, 400);
    const body = answerBody.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) {
      return c.json(
        { error: `body must be JSON like {"answer": "..."} with 1-${QUESTION_LIMITS.answer} characters` },
        400,
      );
    }
    const { accepted, question } = ctx.questions.answer(id.data, body.data.answer, 'dashboard');
    return c.json({ accepted, question }, accepted ? 200 : 409);
  });

  return api;
}
