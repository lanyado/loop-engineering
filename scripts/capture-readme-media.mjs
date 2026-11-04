/* global Buffer, console, document, Event, fetch, setTimeout */
// Regenerates docs/media. The clips record the real dashboard and API server on sample data in a temp
// folder; the screenshots are its built-in demo mode. No agent runs and nothing leaves the machine:
// tmux and git are the fakes, and no terminal can attach to a real tmux session.
// Needs: `npm run build`, ffmpeg, ttyd, and Playwright's Chromium (npx playwright install chromium).
//   node scripts/capture-readme-media.mjs            # everything
//   node scripts/capture-readme-media.mjs pipeline   # by name: see `clips` and `shots` below
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { openStore } from '@loop-engineering/core';
import { checkJobKind, FileStageLibrary, jobLogFile, ProjectStageFiles } from '@loop-engineering/loop';
import {
  DefaultAgentCli,
  FakeGitDriver,
  FakeTmuxDriver,
  MemoryFs,
  SessionRunner,
} from '@loop-engineering/runner';
import {
  claudeUsageModule,
  createServer,
  dashboardApi,
  pipelineModule,
  plannerModule,
  terminalModule,
} from '@loop-engineering/server';
import { loopModule } from '@loop-engineering/server/dist/modules/loop.js';
import { ttydLauncher, WebTerminals } from '@loop-engineering/server/dist/modules/web-terminals.js';

// A short path, because the terminals and the editor show it. Uploads land here too, through TMPDIR.
const dir = realpathSync(mkdtempSync('/tmp/loop-media-'));
process.env.TMPDIR = dir;

// The one way out, for success and failure alike: whatever has started by then is stopped.
const cleanups = [() => rmSync(dir, { recursive: true, force: true })];
process.on('exit', () => {
  for (const undo of cleanups.reverse()) {
    try {
      undo();
    } catch (error) {
      console.error(`cleanup: ${String(error)}`);
    }
  }
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => process.exit(1));

const SERVER_PORT = 3191;
const LIVE_PORT = 3192;
const DEMO_PORT = 3193;
const TOKEN = 'readme-media-dashboard-token-0001';
const MCP_TOKEN = 'readme-media-mcp-token-000000001';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = join(root, 'docs/media');
const frames = join(dir, 'frames');
mkdirSync(out, { recursive: true });

const logsDir = join(dir, 'logs');
mkdirSync(logsDir);
const usageFile = join(dir, 'claude-usage.json');
const nowSeconds = Math.floor(Date.now() / 1000);
writeFileSync(
  usageFile,
  JSON.stringify({
    capturedAt: nowSeconds,
    rateLimits: {
      five_hour: { used_percentage: 38, resets_at: nowSeconds + 2 * 3600 + 780 },
      seven_day: { used_percentage: 64, resets_at: nowSeconds + 3 * 86400 + 4 * 3600 },
    },
  }),
);

// ---- Sample data ----

const BUILDER_SCREEN = String.raw`
\033[1;35m✻\033[0m \033[1mAdd Apple Pay to checkout.\033[0m
\033[2m  Plan approved. Building on loop/apple-pay.\033[0m

\033[36m⏺\033[0m Read \033[2mweb/src/checkout/PaymentSheet.tsx\033[0m
\033[36m⏺\033[0m Edit \033[2mweb/src/checkout/PaymentSheet.tsx\033[0m  \033[32m+48\033[0m \033[31m-6\033[0m
\033[36m⏺\033[0m Edit \033[2mapi/src/webhooks/stripe.ts\033[0m  \033[32m+31\033[0m \033[31m-2\033[0m
\033[36m⏺\033[0m Bash \033[2mnpm test -- checkout\033[0m
\033[2m  ✓ 42 tests passed\033[0m
\033[36m⏺\033[0m Bash \033[2mgh pr create --title "Apple Pay at checkout"\033[0m
\033[2m  https://github.com/example/web/pull/212\033[0m

\033[1m⏺ PR opened. Waiting for the loop's checks.\033[0m

\033[2m────────────────────────────────────────────────────────\033[0m
\033[1m❯\033[0m
`;

const jobEvents = (...items) =>
  items
    .map((item) => {
      if (item.startsWith('===')) return item;
      const content = item.startsWith('$ ')
        ? { type: 'tool_use', name: 'Bash', input: { command: item.slice(2) } }
        : { type: 'text', text: item };
      return JSON.stringify({ type: 'assistant', message: { content: [content] } });
    })
    .join('\n') + '\n';

const JOB_LOGS = {
  tests: jobEvents(
    '=== tests, round 1 ===',
    'Running the tests related to the change, then the suite.',
    '$ npm test -- checkout webhooks',
    '42 passed, 0 failed.',
    '$ npm test',
    '1,284 passed, 0 failed. New code in PaymentSheet is covered.',
  ),
  review: jobEvents(
    '=== code review, round 2 ===',
    'Reading the diff against main.',
    '$ git diff origin/main...HEAD --stat',
    'Round 1 asked for webhook dedupe by event id. The fix is in and has a test.',
    'No blocking findings.',
  ),
  qa: jobEvents(
    '=== QA, round 2 ===',
    'The change touches checkout UI: exercising it in a browser.',
    '$ npx playwright test e2e/checkout.spec.ts',
    'Apple Pay button renders and opens the sheet on Safari and Chrome.',
  ),
};

const PLAN =
  'Goal: Apple Pay at checkout.\n\nFiles: web/src/checkout/PaymentSheet.tsx, api/src/webhooks/stripe.ts\n\nTests: webhook dedupe; checkout e2e.\n\nRisks: duplicate webhooks.';
const RIGOR = { rigor: 'standard', reason: 'Payments code, but a contained change.' };
const MODELS = {
  models: { tests: 'haiku', review: 'opus', qa: 'sonnet' },
  reason: 'A careful review; the tests are routine.',
};

// ---- The real server on a temp database, with stand-ins for tmux, git and the agents ----

const store = openStore({ path: join(dir, 'loop.db') });
// Anything aimed at tmux plays the sample screen, so no terminal can reach a real session. Stage
// terminals are the real thing, on the sample logs.
const webTerminals = new WebTerminals((spec, port, basePath) => {
  if (spec.argv[0] !== 'tmux') return ttydLauncher(spec, port, basePath);
  const screen = join(dir, 'builder-screen.txt');
  writeFileSync(screen, BUILDER_SCREEN);
  const play = `while IFS= read -r line; do printf '%b\\n' "$line"; sleep 0.12; done < '${screen}'; exec sleep 3600`;
  return ttydLauncher({ ...spec, argv: ['sh', '-c', play] }, port, basePath);
});
cleanups.push(() => webTerminals.stopAll());
const idleEngine = {
  config: { logsDir, maxConcurrentJobs: 1 },
  start() {},
  stop: async () => {},
  poke() {},
  status: () => ({ running: [], queued: [] }),
};
const server = createServer({
  config: {
    host: '127.0.0.1',
    port: SERVER_PORT,
    dbPath: join(dir, 'loop.db'),
    dashboardToken: TOKEN,
    mcpToken: MCP_TOKEN,
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
      {
        worktreesRoot: join(dir, 'wt'),
        serverUrl: `http://127.0.0.1:${SERVER_PORT}`,
        env: { MCP_TOKEN },
      },
    );
  },
  usageMonitor: false,
  modules: [
    dashboardApi({ home: dir }),
    claudeUsageModule({ file: usageFile }),
    pipelineModule({
      stages: new ProjectStageFiles(new FileStageLibrary(join(dir, 'stages'), () => undefined)),
    }),
    plannerModule(),
    terminalModule({ open: () => Promise.resolve(), web: webTerminals, sweepMs: 1000 }),
    loopModule({
      createEngine: () => idleEngine,
      web: webTerminals,
      openCommand: () => Promise.resolve(),
      log: () => undefined,
    }),
  ],
  sseKeepAliveMs: 5_000,
});

const repo = (name) => {
  const path = join(dir, 'repos', name);
  mkdirSync(path, { recursive: true });
  return { name, path, remote: `git@example.com:${name}.git`, defaultBranch: 'main' };
};

/** Empties the board and adds the sample project. */
function freshProject() {
  for (const p of store.projects.list()) store.projects.delete(p.id);
  store.settings.update({
    sessionModel: 'opus',
    fallbackModel: 'opencode/glm-5.3-flash-free',
    dashboardLayout: {},
  });
  return store.projects.create({ name: 'shop', repos: [repo('web'), repo('api')] });
}

function openPr(session, requestId, stage) {
  const pr = store.pullRequests.create({
    projectId: session.projectId,
    sessionId: session.id,
    requestId,
    repo: 'web',
    number: 212,
    url: 'https://github.com/example/web/pull/212',
  });
  store.pullRequests.update(pr.id, { stage, round: 1 });
  return pr;
}

/** A planned session on a PR at `stage`, as the loop leaves them. */
function plannedSession(stage) {
  const shop = freshProject();
  const session = store.sessions.create({
    projectId: shop.id,
    title: 'Apple Pay checkout',
    model: 'opus',
    branch: 'loop/apple-pay',
    tmuxTarget: 'readme-sample:@5',
  });
  const request = store.requests.create({
    projectId: shop.id,
    sessionId: session.id,
    text: 'Add Apple Pay to checkout.',
    source: 'dashboard',
  });
  store.sessions.setPlan(session.id, PLAN, RIGOR, MODELS);
  const pr = openPr(session, request.id, stage);
  store.pullRequests.update(pr.id, { round: 2 });
  store.metrics.record(pr.id, { costUsd: 2.18, tokensIn: 1_120_000, tokensOut: 74_000 });
  return { shop, session, pr };
}

/** What the loop mirrors into a PR's state from the Guardian's latest run. */
const guardianRun = (status) => ({
  runId: 1,
  status,
  critical: false,
  summary: 'Checkout and login work on production.',
});

// ---- Driving the page ----

// Headless Chromium draws no pointer, and the clips need one to read as someone using the app.
const CURSOR = `addEventListener('DOMContentLoaded', () => {
  const c = document.createElement('div');
  c.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M4 2l13 11h-7l-3 7z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  c.style.cssText = 'position:fixed;left:-40px;top:-40px;z-index:2147483647;pointer-events:none;transition:transform .12s;transform-origin:4px 2px';
  document.documentElement.append(c);
  addEventListener('mousemove', (e) => { c.style.left = e.clientX - 4 + 'px'; c.style.top = e.clientY - 2 + 'px'; }, true);
  addEventListener('mousedown', () => { c.style.transform = 'scale(.8)'; }, true);
  addEventListener('mouseup', () => { c.style.transform = ''; }, true);
});`;

let mouse = { x: 720, y: 400 };

/** Moves the pointer to the middle of `target` the way a hand does, easing in and out. */
async function glide(page, target) {
  await target.waitFor({ state: 'visible' });
  // Not scrollIntoViewIfNeeded: it waits for a stable element, and edit mode's items wiggle.
  await target.evaluate((el) => el.scrollIntoView({ block: 'nearest' }));
  const box = await target.boundingBox();
  const to = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const from = mouse;
  const steps = 22;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const ease = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    await page.mouse.move(from.x + (to.x - from.x) * ease, from.y + (to.y - from.y) * ease);
    await page.waitForTimeout(14);
  }
  mouse = to;
}

/** A real click at the pointer. Edit mode's wiggling items never count as stable for locator.click(). */
async function click(page, target) {
  await glide(page, target);
  await page.waitForTimeout(160);
  await page.mouse.down();
  await page.waitForTimeout(70);
  await page.mouse.up();
}

/** The board re-renders itself on this event; stage changes alone send it nothing to react to. */
async function refresh(page, wait = 450) {
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(wait);
}

// The lane with every stage needs more than the dashboard's 1280px minimum to show without scrolling.
const WIDTH = 1440;
const project = (page) => page.locator('[data-testid="project"][data-project="shop"]');
const row = (page) => project(page).getByTestId('session-row').first();

/** Records `script` with the browser's own screencast, then encodes the frames to a GIF. */
async function clip(browser, name, script) {
  const clipDir = join(frames, name);
  mkdirSync(clipDir, { recursive: true });
  const ctx = await browser.newContext({
    viewport: { width: WIDTH, height: script.height ?? 640 },
    colorScheme: 'dark',
  });
  await ctx.addInitScript(CURSOR);
  const page = await ctx.newPage();
  mouse = { x: 720, y: 400 };
  const data = await script.setup?.();
  await page.goto(`http://localhost:${LIVE_PORT}${script.path ?? '/'}`);
  await page.waitForTimeout(1000);

  const cdp = await ctx.newCDPSession(page);
  const frameList = [];
  cdp.on('Page.screencastFrame', (f) => {
    const file = join(clipDir, `${String(frameList.length).padStart(5, '0')}.jpg`);
    writeFileSync(file, Buffer.from(f.data, 'base64'));
    frameList.push({ file, at: f.metadata.timestamp });
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 95, everyNthFrame: 1 });
  await page.waitForTimeout(300);
  await script.run(page, data);
  await page.waitForTimeout(script.hold ?? 1800);
  const end = Date.now() / 1000;
  await cdp.send('Page.stopScreencast');
  await ctx.close();

  // Frames come when the screen changes, so each one lasts until the next, and the last until the end.
  const list = frameList.flatMap((s, i) => [
    `file '${s.file}'`,
    `duration ${Math.max((frameList[i + 1]?.at ?? end) - s.at, 0.01).toFixed(4)}`,
  ]);
  list.push(`file '${frameList.at(-1).file}'`);
  const listFile = join(clipDir, 'frames.txt');
  writeFileSync(listFile, `${list.join('\n')}\n`);
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    listFile,
    '-filter_complex',
    // A flat UI: a palette built from what changes, no dithering noise, and only changed rectangles.
    `[0:v]fps=${script.fps ?? 12},split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`,
    join(out, `${name}.gif`),
  ]);
  rmSync(clipDir, { recursive: true, force: true });
  console.log(`${name}.gif (${frameList.length} frames)`);
}

// ---- The clips ----

const clips = {
  /** A task from the first word to the deploy: the README's hero. */
  pipeline: {
    setup: () => freshProject(),
    height: 720,
    hold: 2600,
    async run(page, shop) {
      await page.waitForTimeout(500);
      await click(page, project(page).getByTestId('project-plus'));
      const composer = project(page).getByTestId('project-composer');
      await composer.getByRole('textbox').pressSequentially('Add Apple Pay to checkout. Match this design.', {
        delay: 22,
      });
      const picture = join(dir, 'apple-pay-design.png');
      await page.screenshot({ path: picture });
      const chooser = page.waitForEvent('filechooser');
      await click(page, composer.getByTestId('attach-button'));
      await (await chooser).setFiles(picture);
      await page.waitForTimeout(700);
      await click(page, composer.getByRole('button', { name: 'Start session' }));
      await page.waitForTimeout(1300);

      // What the router and the runner do on a real server.
      const request = store.requests.list({ projectId: shop.id })[0];
      const session = store.sessions.create({
        projectId: shop.id,
        title: 'Apple Pay checkout',
        model: 'opus',
        branch: 'loop/apple-pay',
        tmuxTarget: 'readme-sample:@5',
      });
      store.requests.assignSession(request.id, session.id);
      await refresh(page, 1500);
      store.sessions.setPlan(session.id, PLAN, RIGOR, MODELS);
      await refresh(page, 1500);

      const pr = openPr(session, request.id, 'tests');
      store.metrics.record(pr.id, { costUsd: 1.46, tokensIn: 780_000, tokensOut: 52_000 });
      await refresh(page, 1200);
      store.pullRequests.update(pr.id, { stage: 'review' });
      await refresh(page, 1200);
      store.pullRequests.update(pr.id, { stage: 'qa' });
      await refresh(page, 1200);

      const { question } = server.ctx.questions.ask({
        sessionId: session.id,
        text: 'PR web#212 at 8f3c2d1 (round 1) passed its checks. Merge it?',
        options: ['Merge', 'Hold', 'Close'],
        recommendedOption: 'Hold',
      });
      store.pullRequests.update(pr.id, {
        stage: 'awaiting_approval',
        loopState: { question: { kind: 'approval', id: question.id } },
      });
      await refresh(page, 1000);
      await click(page, page.getByRole('button', { name: 'Merge', exact: true }));
      await page.waitForTimeout(500);

      store.pullRequests.update(pr.id, { stage: 'merge', loopState: {} });
      await refresh(page, 900);
      store.pullRequests.update(pr.id, { stage: 'deploying' });
      await refresh(page, 1100);
      store.pullRequests.update(pr.id, {
        stage: 'deployed',
        loopState: { guardian: guardianRun('running') },
      });
      await refresh(page, 1000);
      store.pullRequests.update(pr.id, { loopState: { guardian: guardianRun('passed') } });
      await refresh(page);
    },
  },

  /** A builder's question answered with a tap, then the alarm for a PR that stopped moving. */
  questions: {
    setup() {
      const { session, pr } = plannedSession('review');
      const webhook = store.subagents.create({
        sessionId: session.id,
        title: 'Stripe webhook handler',
        model: 'sonnet',
        effort: 'high',
      });
      server.ctx.questions.ask({
        sessionId: session.id,
        subagentId: webhook.id,
        text: 'Stripe sends the same webhook twice sometimes. Dedupe by event id in Postgres or in Redis?',
        options: ['Postgres table', 'Redis SET with TTL'],
        recommendedOption: 'Postgres table',
        context: 'We already run Postgres, and a unique index survives a restart.',
      });
      return { session, pr };
    },
    height: 860,
    async run(page, { session, pr }) {
      const card = page.getByTestId('question').first();
      await page.waitForTimeout(600);
      await click(page, card.getByText('Context'));
      await page.waitForTimeout(1100);
      await glide(page, card.getByRole('button', { name: /Redis/ }));
      await page.waitForTimeout(500);
      await click(page, card.getByRole('button', { name: /Postgres/ }));
      await page.waitForTimeout(1200);

      server.ctx.questions.ask({
        sessionId: session.id,
        text: `PR web#212 has not moved for 2h: waiting for builder session ${session.id} (active) to push fixes for the review feedback it got 2h ago. Options Keep waiting / Nudge builder / Take over`,
        context: pr.url,
        options: ['Keep waiting', 'Nudge builder', 'Take over'],
        recommendedOption: 'Keep waiting',
        timeoutMs: 3_600_000,
      });
      await refresh(page, 1500);
      const alarm = page.getByTestId('question').first();
      await click(page, alarm.getByRole('button', { name: /Nudge builder/ }));
      await page.waitForTimeout(800);
    },
  },

  /** The rigor dial, the model on a node, and skipping one check. */
  controls: {
    setup: () => plannedSession('review'),
    async run(page) {
      const dial = row(page).getByTestId('rigor-dial');
      await page.waitForTimeout(500);
      await click(page, dial.getByTestId('rigor-fast'));
      await page.waitForTimeout(1200);
      await click(page, dial.getByTestId('rigor-thorough'));
      await page.waitForTimeout(1200);
      await click(page, dial.getByTestId('rigor-standard'));
      await page.waitForTimeout(900);

      await click(page, row(page).getByRole('button', { name: /^Model for QA/ }));
      await page.waitForTimeout(800);
      await click(page, page.getByTestId('model-choice').filter({ hasText: /opus/ }).first());
      await page.waitForTimeout(1000);

      await click(page, row(page).getByRole('button', { name: /^Skip QA/ }));
      await page.waitForTimeout(1100);
      await click(page, page.getByTestId('skip-confirm'));
      await page.waitForTimeout(800);
    },
  },

  /** The terminals under a pipeline: the Builder live, each stage following its log. */
  terminals: {
    setup() {
      const { pr } = plannedSession('qa');
      for (const [stage, text] of Object.entries(JOB_LOGS)) {
        writeFileSync(jobLogFile(logsDir, pr.id, checkJobKind(stage)), text);
      }
      return { pr };
    },
    height: 800,
    hold: 1500,
    async run(page, { pr }) {
      const dock = row(page).getByTestId('terminal-dock');
      await page.waitForTimeout(500);
      await click(page, dock.getByTestId('terminal-dock-toggle'));
      await page.waitForTimeout(3200);
      const tabs = dock.getByTestId('terminal-tab');
      // Each tab connects to its own terminal, which takes a moment.
      await click(page, tabs.filter({ hasText: 'Tests' }));
      await page.waitForTimeout(3400);
      await click(page, tabs.filter({ hasText: 'CR' }));
      await page.waitForTimeout(3400);
      await click(page, tabs.filter({ hasText: 'QA' }));
      await page.waitForTimeout(3000);
      // A running stage's terminal follows its log.
      appendFileSync(
        jobLogFile(logsDir, pr.id, checkJobKind('qa')),
        jobEvents('Checked the failure paths too: a declined card returns to the sheet.', 'QA passed.'),
      );
    },
  },

  /** The pencil: a tab per project, then moving, removing and adding stages on the pipeline. */
  editor: {
    setup: () => plannedSession('review'),
    path: '/edit',
    height: 720,
    // Edit mode wiggles every stage, so each frame costs more.
    fps: 7,
    hold: 1200,
    async run(page) {
      const editor = page.getByTestId('editor');
      await page.waitForTimeout(600);
      await click(page, page.getByTestId('editor-tab').filter({ hasText: /^shop$/ }));
      await page.waitForTimeout(1000);

      const item = (name) => editor.locator(`.lane-step > [data-item="${name}"]`);
      // Dragged by hand, so the lift and the slide show.
      await glide(page, item('qa'));
      await page.mouse.down();
      await glide(page, item('tests'));
      await page.waitForTimeout(200);
      await page.mouse.up();
      await page.waitForTimeout(900);

      await click(page, editor.getByRole('button', { name: 'Remove Tests' }));
      await page.waitForTimeout(800);
      await click(page, editor.getByRole('button', { name: 'Add Tests' }));
      await page.waitForTimeout(800);

      await click(page, editor.getByTestId('new-stage'));
      await page.waitForTimeout(500);
      await page.getByLabel('Name').pressSequentially('Security review', { delay: 16 });
      await page.getByLabel('Label on the node (10 characters at most)').fill('Security');
      await page
        .getByTestId('stage-prompt')
        .pressSequentially('Look for injection, leaked secrets and missing auth checks.', { delay: 6 });
      await page.waitForTimeout(400);
      await click(page, page.getByTestId('stage-save'));
      await page.waitForTimeout(1200);
    },
  },
};

// ---- The screenshots ----

/** A retina picture of the demo dashboard (labelled as demo data on screen). PNGs of a flat UI shrink a lot on a 256-color palette. */
async function shot(browser, name, { colorScheme }) {
  const ctx = await browser.newContext({
    viewport: { width: WIDTH, height: 845 },
    colorScheme,
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${DEMO_PORT}/`);
  await page.waitForTimeout(1000);
  const raw = join(dir, `${name}-raw.png`);
  await page.screenshot({ path: raw });
  await ctx.close();
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-i',
    raw,
    '-filter_complex',
    '[0:v]split[a][b];[a]palettegen=max_colors=256[p];[b][p]paletteuse=dither=none',
    '-compression_level',
    '100',
    join(out, `${name}.png`),
  ]);
  console.log(`${name}.png`);
}

const shots = {
  'board-dark': { colorScheme: 'dark' },
  'board-light': { colorScheme: 'light' },
};

// ---- Run ----

const answers = (url) =>
  fetch(url).then(
    (r) => r.ok,
    () => false,
  );

/** Refuses a port something else holds: its pages would be recorded as if they were ours. */
async function nextStart(port, env) {
  const url = `http://127.0.0.1:${port}/login`;
  if (await answers(url)) throw new Error(`port ${port} is in use`);
  const child = spawn(
    join(root, 'node_modules/.bin/next'),
    ['start', '-H', '127.0.0.1', '-p', String(port)],
    {
      cwd: join(root, 'apps/dashboard'),
      stdio: ['ignore', 'ignore', 'inherit'],
      env: {
        ...process.env,
        NEXT_TELEMETRY_DISABLED: '1',
        DASHBOARD_HOST: '127.0.0.1',
        DASHBOARD_AUTH: '',
        DASHBOARD_PASSWORD: '',
        DASHBOARD_SESSION_SECRET: '',
        ...env,
      },
    },
  );
  cleanups.push(() => child.kill());
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`the dashboard on port ${port} exited`);
    if (await answers(url)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`the dashboard on port ${port} did not start`);
}

const wanted = process.argv.slice(2);
const chosen = (name) => wanted.length === 0 || wanted.includes(name);
for (const name of wanted) {
  if (!clips[name] && !shots[name]) throw new Error(`no clip or shot called ${name}`);
}

await server.start();
await nextStart(LIVE_PORT, { SERVER_URL: `http://127.0.0.1:${SERVER_PORT}`, DASHBOARD_TOKEN: TOKEN });
await nextStart(DEMO_PORT, { SERVER_URL: '', DASHBOARD_TOKEN: '' });
const browser = await chromium.launch();
for (const [name, script] of Object.entries(clips)) if (chosen(name)) await clip(browser, name, script);
for (const [name, options] of Object.entries(shots)) if (chosen(name)) await shot(browser, name, options);
process.exit(0);
