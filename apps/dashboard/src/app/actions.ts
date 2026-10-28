'use server';

import { refresh } from 'next/cache';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import * as z from 'zod';
import {
  createSessionToken,
  passwordMatches,
  safeNextPath,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  cookieIsSecure,
} from '../lib/auth';
import { BackendError, ReadOnlyError, type Backend } from '../lib/backend';
import { clientIp, LoginLimiter } from '../lib/login-limiter';
import {
  agentModelInput,
  answerInput,
  editsInput,
  endSessionInput,
  rigorInput,
  skipCheckInput,
  hideProjectInput,
  stageTerminalInput,
  newRequestInput,
  projectToggleInput,
  sessionMessageInput,
  settingsInput,
} from '../lib/schemas';
import { layoutPatch, parseLayout, type Layout, type LayoutPatch } from '../lib/layout';
import { getAuthConfig, noLogin } from '../lib/server/env';
import { backendForViewer, requireLogin } from '../lib/server/session';
import { parseTheme, THEME_COOKIE } from '../lib/theme';

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

/** Runs one write: login check, input validation, backend call, refresh; errors become messages. */
async function write<S extends z.ZodType>(
  schema: S,
  input: unknown,
  run: (data: z.output<S>, backend: Backend) => Promise<string | undefined>,
): Promise<ActionResult> {
  // Outside the try: a logged-out caller is redirected (the redirect must propagate).
  const backend = await backendForViewer();
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' };
  try {
    const message = await run(parsed.data, backend);
    refresh();
    return message === undefined ? { ok: true } : { ok: true, message };
  } catch (error) {
    if (error instanceof ReadOnlyError || error instanceof BackendError)
      return { ok: false, error: error.message };
    console.error('[dashboard] action failed:', error);
    return { ok: false, error: 'Something went wrong. Try again.' };
  }
}

export async function answerQuestion(questionId: number, answer: string): Promise<ActionResult> {
  return write(answerInput, { questionId, answer }, async ({ questionId, answer }, backend) => {
    const result = await backend.answer(questionId, answer);
    if (result.accepted) return undefined;
    const q = result.question;
    const via = q.answeredVia === 'timeout' ? 'the 15-minute default' : (q.answeredVia ?? 'another channel');
    throw new BackendError(409, `Already settled: "${q.answer ?? q.recommendedOption}" (via ${via}).`);
  });
}

export async function setProjectToggle(
  projectId: number,
  field: 'autoMerge',
  value: boolean,
): Promise<ActionResult> {
  return write(projectToggleInput, { projectId, field, value }, async (d, backend) => {
    await backend.updateProject(d.projectId, { [d.field]: d.value });
    return undefined;
  });
}

export async function updateSettings(patch: unknown): Promise<ActionResult> {
  return write(
    settingsInput.refine((p) => Object.keys(p).length > 0, 'Nothing to save'),
    patch,
    async (p, backend) => {
      await backend.updateSettings(p);
      return 'Saved';
    },
  );
}

/**
 * Changes only `patch`'s part of the layout as the server has it now, so a save never writes back a
 * stale copy of the rest (two tabs saving at the same instant can still race); refused when the
 * current layout cannot be read.
 */
async function mergeLayout(backend: Backend, patch: (current: Layout) => LayoutPatch): Promise<void> {
  const current = parseLayout((await backend.settings()).dashboardLayout);
  await backend.updateSettings({ dashboardLayout: { ...current, ...patch(current) } });
}

/** A new project order on the board (the whole order of what it shows). */
export async function saveProjectOrder(projectOrder: unknown): Promise<ActionResult> {
  return write(layoutPatch.required({ projectOrder: true }), { projectOrder }, async (d, backend) => {
    await mergeLayout(backend, () => d);
    return undefined;
  });
}

/** Hides a project from the board, or shows it again. */
export async function setProjectHidden(projectId: number, hidden: boolean): Promise<ActionResult> {
  return write(hideProjectInput, { projectId, hidden }, async (d, backend) => {
    await mergeLayout(backend, ({ hiddenProjects }) => {
      const others = hiddenProjects.filter((id) => id !== d.projectId);
      return { hiddenProjects: d.hidden ? [...others, d.projectId] : others };
    });
    return undefined;
  });
}

/** The editor's Save: the pipeline first (the server may refuse it), then the layout. */
export async function applyEdits(edits: unknown): Promise<ActionResult> {
  return write(editsInput, edits, async (d, backend) => {
    if (d.pipeline) await backend.updatePipeline(d.pipeline);
    // A pipeline-only Save leaves the layout alone, so it cannot overwrite another tab's save.
    if (Object.keys(d.layout).length > 0) await mergeLayout(backend, () => d.layout);
    return undefined;
  });
}

export async function createRequest(text: string, projectId: number | null): Promise<ActionResult> {
  return write(newRequestInput, { text, projectId }, async (d, backend) => {
    const request = await backend.createRequest(d);
    return request.projectId === null ? 'Sent. The router will pick a project.' : 'Sent.';
  });
}

export async function messageSession(sessionId: number, text: string): Promise<ActionResult> {
  return write(sessionMessageInput, { sessionId, text }, async (d, backend) => {
    await backend.messageSession(d.sessionId, d.text);
    return 'Sent to the session.';
  });
}

export async function endSession(sessionId: number): Promise<ActionResult> {
  return write(endSessionInput, { sessionId }, async (d, backend) => {
    await backend.endSession(d.sessionId);
    return 'Session ended.';
  });
}

/** The rigor dial above a session's pipeline. */
export async function setRigor(sessionId: number, rigor: string): Promise<ActionResult> {
  return write(rigorInput, { sessionId, rigor }, async (d, backend) => {
    await backend.setRigor(d.sessionId, d.rigor);
    return undefined;
  });
}

/** The model caption on a stage node: one agent's model for this session, or null for the default. */
export async function setAgentModel(
  sessionId: number,
  agent: string,
  model: string | null,
): Promise<ActionResult> {
  return write(agentModelInput, { sessionId, agent, model }, async (d, backend) => {
    await backend.setAgentModel(d.sessionId, d.agent, d.model);
    return undefined;
  });
}

export async function openTerminal(sessionId: number): Promise<ActionResult> {
  return write(endSessionInput, { sessionId }, async (d, backend) => {
    await backend.openTerminal(d.sessionId);
    return 'Opened in Terminal.';
  });
}

/** Skips one check for one PR (the pop-up on its node confirmed it), or brings it back. */
export async function skipCheck(prId: number, check: string, skip: boolean): Promise<ActionResult> {
  return write(skipCheckInput, { prId, check, skip }, async (d, backend) => {
    await backend.skipCheck(d.prId, d.check, d.skip);
    return undefined;
  });
}

export async function openStageTerminal(prId: number, stage: string): Promise<ActionResult> {
  return write(stageTerminalInput, { prId, stage }, async (d, backend) => {
    await backend.openStageTerminal(d.prId, d.stage);
    return 'Opened in Terminal.';
  });
}

/** A per-browser preference, not a server setting, so read-only demo mode allows it. */
export async function setTheme(theme: string): Promise<void> {
  await requireLogin();
  const jar = await cookies();
  const value = parseTheme(theme);
  if (value) {
    const requestHeaders = await headers();
    jar.set(THEME_COOKIE, value, {
      httpOnly: true,
      secure: cookieIsSecure((name) => requestHeaders.get(name)),
      sameSite: 'lax',
      path: '/',
      maxAge: 365 * 24 * 60 * 60, // a year
    });
  } else {
    jar.delete(THEME_COOKIE);
  }
  refresh();
}

export type LoginState = { error: string | null };

const limiter = new LoginLimiter();

export async function login(_prev: LoginState, form: FormData): Promise<LoginState> {
  // DASHBOARD_AUTH=none has no login: nothing to check, no cookie to set.
  if (noLogin()) redirect('/');
  const { password, secret, problem } = getAuthConfig();
  if (!password || !secret) return { error: problem ?? 'Login is not configured.' };
  const ip = clientIp(await headers());
  const check = limiter.check(ip);
  if (!check.allowed) {
    return { error: `Too many failed attempts. Try again in ${Math.ceil(check.retryAfterMs / 60_000)} min.` };
  }
  const input = form.get('password');
  if (typeof input !== 'string' || input.length === 0 || input.length > 1000) {
    return { error: 'Enter the dashboard password.' };
  }
  if (!(await passwordMatches(input, password))) {
    limiter.fail(ip);
    // On top of the PBKDF2 cost and the lockouts; the password itself should be long and random.
    await new Promise((resolve) => setTimeout(resolve, 750));
    return { error: 'Wrong password.' };
  }
  limiter.succeed(ip);
  const requestHeaders = await headers();
  (await cookies()).set(SESSION_COOKIE, await createSessionToken(secret, Date.now()), {
    httpOnly: true,
    // Trusts x-forwarded-proto/Origin: assumes any proxy in front overwrites them (Vercel does).
    // Secure over https only: a Secure cookie would not stick on http://localhost (Safari).
    secure: cookieIsSecure((name) => requestHeaders.get(name)),
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  });
  redirect(safeNextPath(form.get('next')));
}

export async function logout(): Promise<void> {
  if (noLogin()) redirect('/');
  (await cookies()).delete(SESSION_COOKIE);
  redirect('/login');
}
