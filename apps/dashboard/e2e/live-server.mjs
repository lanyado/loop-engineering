/* global process, console */
// The real always-on server (apps/server, built) on a temp SQLite file, for the "live" e2e
// projects. Seeds sample data, and adds two test-only routes guarded by the MCP token:
//   POST /test/reset  wipes and reseeds the data
//   POST /test/ask    { text, options, recommended } asks a question as a session would
//   POST /test/task   { text } sends the checkout session a new task (so its Planner plans again)
// Claude's usage limits come from a snapshot file written here, as the status line script would.
// A SessionRunner on fake tmux, git and an in-memory fs backs "End session": no agent, no real git.
// Run after `npm run build`. Env: LIVE_PORT, DASHBOARD_TOKEN, MCP_TOKEN.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '@loop-engineering/core';
import {
  DefaultAgentCli,
  FakeGitDriver,
  FakeTmuxDriver,
  MemoryFs,
  SessionRunner,
} from '@loop-engineering/runner';
import { FileStageLibrary } from '@loop-engineering/loop';
import {
  claudeUsageModule,
  createServer,
  dashboardApi,
  pipelineModule,
  plannerModule,
} from '@loop-engineering/server';

const port = Number(process.env.LIVE_PORT ?? 3102);
const dashboardToken = process.env.DASHBOARD_TOKEN;
const mcpToken = process.env.MCP_TOKEN;
if (!dashboardToken || !mcpToken) throw new Error('DASHBOARD_TOKEN and MCP_TOKEN are required');

const dir = mkdtempSync(join(tmpdir(), 'loop-e2e-'));
const store = openStore({ path: join(dir, 'loop.db') });
const usageFile = join(dir, 'claude-usage.json');
const nowSeconds = Math.floor(Date.now() / 1000);
writeFileSync(
  usageFile,
  JSON.stringify({
    capturedAt: nowSeconds,
    rateLimits: {
      five_hour: { used_percentage: 91.4, resets_at: nowSeconds + 3600 },
      seven_day: { used_percentage: 12, resets_at: nowSeconds + 4 * 86400 },
    },
  }),
);
let ids = {};

function seed(server) {
  const repo = (name) => ({
    name,
    path: `/tmp/${name}`,
    remote: `git@example.com:${name}.git`,
    defaultBranch: 'main',
  });
  const shop = store.projects.create({
    name: 'shop',
    repos: [repo('web'), repo('api')],
    markedForDirectInput: true,
  });
  const blog = store.projects.create({ name: 'blog', repos: [repo('site')], autoMerge: true });
  const checkout = store.sessions.create({
    projectId: shop.id,
    title: 'Apple Pay checkout',
    model: 'opus',
    branch: 'loop/apple-pay',
  });
  const search = store.sessions.create({
    projectId: shop.id,
    title: 'Search relevance',
    model: 'opus',
    branch: 'loop/search',
    status: 'paused',
    pauseReason: 'usage_limit',
  });
  const rss = store.sessions.create({
    projectId: blog.id,
    title: 'RSS feed',
    model: 'opencode/glm-5.3-flash-free',
    provider: 'opencode',
    branch: 'loop/rss',
  });
  // The rigor dial at Fast, chosen by the human.
  store.sessions.update(rss.id, { rigor: 'fast' });
  // A past Claude Code conversation, as the importer stores it.
  store.sessions.importEnded({
    projectId: blog.id,
    title: 'Migrate the blog to MDX',
    model: 'claude-opus-4-1',
    agentSessionId: '0b1c2d3e-0000-4000-8000-000000000001',
    createdAt: '2026-09-03T09:00:00.000Z',
    endedAt: '2026-09-03T10:30:00.000Z',
  });
  // Its task came, then its plan (submit_plan): questions asked from here on are the Builder's.
  const request = store.requests.create({
    projectId: shop.id,
    sessionId: checkout.id,
    text: 'Support Apple Pay',
    source: 'telegram',
  });
  store.sessions.setPlan(
    checkout.id,
    'Goal: Apple Pay at checkout.\n\nFiles: web/src/checkout/PaymentSheet.tsx, api/src/webhooks/stripe.ts\n\nTests: webhook dedupe; checkout e2e.\n\nRisks: duplicate webhooks.',
  );
  const webhook = store.subagents.create({
    sessionId: checkout.id,
    title: 'Stripe webhook handler',
    model: 'sonnet',
    effort: 'high',
  });
  store.subagents.create({
    sessionId: checkout.id,
    title: 'Checkout e2e tests',
    model: 'haiku',
    effort: 'medium',
    status: 'done',
  });
  const seeded = server.ctx.questions.ask({
    sessionId: checkout.id,
    subagentId: webhook.id,
    text: 'Dedupe Stripe webhooks in Postgres or Redis?',
    options: ['Postgres table', 'Redis SET'],
    recommendedOption: 'Postgres table',
    context: 'We already run Postgres.',
  }).question;
  const pr = store.pullRequests.create({
    projectId: shop.id,
    sessionId: checkout.id,
    requestId: request.id,
    repo: 'web',
    number: 212,
    url: 'https://github.com/example/web/pull/212',
  });
  store.pullRequests.update(pr.id, { stage: 'qa', round: 2 });
  store.metrics.record(pr.id, { costUsd: 3.42, tokensIn: 1_840_000, tokensOut: 96_000, failures: 1 });
  const done = store.pullRequests.create({
    projectId: blog.id,
    sessionId: rss.id,
    repo: 'site',
    number: 44,
    url: 'https://github.com/example/site/pull/44',
  });
  store.pullRequests.update(done.id, { stage: 'deployed', round: 1, outcome: 'merged' });
  // A PR waiting for the human's approval: the loop asked through the PR's session.
  const approval = server.ctx.questions.ask({
    sessionId: search.id,
    text: 'Merge api#85?',
    options: ['Merge', 'Hold'],
    recommendedOption: 'Hold',
  }).question;
  const waiting = store.pullRequests.create({
    projectId: shop.id,
    sessionId: search.id,
    repo: 'api',
    number: 85,
    url: 'https://github.com/example/api/pull/85',
  });
  store.pullRequests.update(waiting.id, {
    stage: 'awaiting_approval',
    round: 1,
    loopState: { question: { kind: 'approval', id: approval.id } },
  });
  ids = {
    shop: shop.id,
    blog: blog.id,
    checkout: checkout.id,
    search: search.id,
    rss: rss.id,
    question: seeded.id,
    approval: approval.id,
    pr: pr.id,
  };
}

function reset(server) {
  for (const p of store.projects.list()) store.projects.delete(p.id);
  store.settings.update({
    sessionModel: 'opus',
    fallbackModel: 'opencode/glm-5.3-flash-free',
    telegramAllowlist: [],
    dashboardLayout: {},
  });
  seed(server);
}

const testRoutes = {
  name: 'e2e-test-routes',
  routes(app, ctx) {
    const guard = (c) => c.req.header('Authorization') === `Bearer ${mcpToken}`;
    app.post('/test/reset', (c) => {
      if (!guard(c)) return c.json({ error: 'unauthorized' }, 401);
      reset(server);
      rmSync(join(dir, 'stages'), { recursive: true, force: true }); // back to the built-in pipeline
      return c.json({ ok: true, ids });
    });
    app.post('/test/ask', async (c) => {
      if (!guard(c)) return c.json({ error: 'unauthorized' }, 401);
      const body = await c.req.json();
      const { question } = ctx.questions.ask({
        sessionId: ids.checkout,
        text: body.text,
        options: body.options,
        recommendedOption: body.recommended,
      });
      return c.json({ question });
    });
    app.post('/test/task', async (c) => {
      if (!guard(c)) return c.json({ error: 'unauthorized' }, 401);
      const body = await c.req.json();
      // Through RequestService, so request.created reaches the dashboard's live stream.
      const request = ctx.requests.create({
        projectId: ids.shop,
        sessionId: ids.checkout,
        text: body.text,
        source: 'dashboard',
      });
      return c.json({ request });
    });
    // Board states the seed does not hold, for tests that need them: an extra session (e.g. a
    // paused one that has opened no PR, so the board shows its placeholder lane) and an extra PR
    // whose stage/outcome is new, with an optional loop deploy question asked on it.
    app.post('/test/pr', async (c) => {
      if (!guard(c)) return c.json({ error: 'unauthorized' }, 401);
      const body = await c.req.json();
      let sessionId = body.sessionId ?? null;
      if (body.session) {
        const created = store.sessions.create({
          projectId: body.session.projectId,
          title: body.session.title,
          model: 'opus',
          branch: 'loop/e2e-extra',
          // Paused, so the fake runner never picks it up; the board still draws the lane.
          status: 'paused',
          pauseReason: 'manual',
        });
        sessionId = created.id;
      }
      let prId = null;
      let questionId = null;
      if (body.pr) {
        const pr = store.pullRequests.create({
          projectId: body.pr.projectId,
          sessionId,
          repo: body.pr.repo,
          number: body.pr.number,
          url: `https://github.com/example/${body.pr.repo}/pull/${body.pr.number}`,
          stage: body.pr.stage ?? 'review',
          round: body.pr.round ?? 1,
        });
        const patch = {
          stage: body.pr.stage ?? 'review',
          round: body.pr.round ?? 1,
          outcome: body.pr.outcome ?? null,
        };
        if (body.pr.deployQuestion) {
          const { question } = ctx.questions.ask({
            sessionId,
            text: 'The deploy stalled. Retry it or revert the merge?',
            options: ['Retry deploy', 'Revert the merge'],
            recommendedOption: 'Retry deploy',
          });
          patch.loopState = { question: { kind: 'deploy_timeout', id: question.id } };
          questionId = question.id;
        } else if (body.pr.escalationQuestion) {
          // The loop gave up and asks for a decision: a question on the lane's end.
          const { question } = ctx.questions.ask({
            sessionId,
            text: body.pr.escalationQuestion,
            options: ['Try once more', 'Give up on the PR'],
            recommendedOption: 'Give up on the PR',
          });
          patch.loopState = { question: { kind: 'escalation', id: question.id } };
          questionId = question.id;
        }
        store.pullRequests.update(pr.id, patch);
        prId = pr.id;
      }
      return c.json({ ok: true, sessionId, prId, questionId });
    });
  },
};

const server = createServer({
  config: {
    host: '127.0.0.1',
    port,
    dbPath: join(dir, 'loop.db'),
    dashboardToken,
    mcpToken,
    corsOrigins: [],
    publicUrl: null,
  },
  store,
  runner: (s) => {
    const fs = new MemoryFs();
    return new SessionRunner(
      {
        store: s,
        fs,
        git: new FakeGitDriver(fs),
        tmux: new FakeTmuxDriver(),
        agentCli: new DefaultAgentCli(),
      },
      { worktreesRoot: join(dir, 'wt'), serverUrl: `http://127.0.0.1:${port}`, env: { MCP_TOKEN: mcpToken } },
    );
  },
  usageMonitor: false,
  // Folder projects must sit inside the home folder; the live e2e makes its folders in the OS temp dir.
  modules: [
    dashboardApi({ home: tmpdir() }),
    claudeUsageModule({ file: usageFile }),
    pipelineModule({ stages: new FileStageLibrary(join(dir, 'stages'), () => undefined) }),
    plannerModule(),
    testRoutes,
  ],
  sseKeepAliveMs: 5_000,
});
seed(server);
const { url } = await server.start();
console.log(`[e2e] live server on ${url} (db in ${dir})`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void server.close().then(() => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
      process.exit(0);
    });
  });
}
