import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionToken } from '@loop-engineering/core';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { expect, test, type Locator, type Request } from '@playwright/test';
import { E2E } from './env';
import {
  api,
  expectNoHorizontalScroll,
  globalSettings,
  open,
  projectSettings,
  snap,
  testRoute,
} from './helpers';

// The dashboard wired to the real server (e2e/live-server.mjs), reset before every test.

/** A Next.js server action call (a dashboard write), as the browser sends it. */
const isServerAction = (request: Request) =>
  request.method() === 'POST' && request.headers()['next-action'] !== undefined;

interface Ids {
  shop: number;
  blog: number;
  checkout: number;
  search: number;
  rss: number;
  question: number;
  approval: number;
}
let ids: Ids;
test.beforeEach(async () => {
  ({ ids } = await testRoute<{ ids: Ids }>('/test/reset'));
});

test('an agent asks via ask_human, the question appears live, one tap answers it', async ({ page }, info) => {
  await open(page);
  await expect(page.getByTestId('question')).toHaveCount(2);
  const checkout = page.getByTestId('session-row').filter({ hasText: 'Apple Pay checkout' });

  // A real MCP client, connected the way a Claude Code session is.
  const client = new Client({ name: 'e2e-agent', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${E2E.serverUrl}/mcp`), {
      requestInit: {
        // The session's own token: /mcp refuses the shared MCP_TOKEN.
        headers: {
          Authorization: `Bearer ${sessionToken(E2E.mcpToken, ids.checkout)}`,
          'X-Loop-Session-Id': String(ids.checkout),
        },
      },
    }),
  );
  try {
    const call = client.callTool({
      name: 'ask_human',
      arguments: {
        question: 'Ship the fix today?',
        options: ['Ship today', 'Wait for QA'],
        recommended: 'Wait for QA',
      },
    });

    // No reload: the SSE relay re-renders the board, and the question lands on the Builder node.
    const card = checkout.getByTestId('question').filter({ hasText: 'Ship the fix today?' });
    await expect(card).toBeVisible();
    await expect(checkout.locator('[data-stage="builder"]').getByTestId('node-ask')).toHaveText(
      '2 questions',
    );
    await expect(card.getByRole('button', { name: /Wait for QA/ })).toContainText('default');
    await snap(page, info, 'live-board');
    await card.getByRole('button', { name: 'Ship today' }).click();
    await expect(card).toBeHidden();

    const result = (await call) as {
      structuredContent?: { answer: string; answeredVia: string; defaulted: boolean };
    };
    expect(result.structuredContent).toMatchObject({
      answer: 'Ship today',
      answeredVia: 'dashboard',
      defaulted: false,
    });
    await expect(checkout.locator('[data-stage="builder"]').getByTestId('node-ask')).toHaveText('1 question');
  } finally {
    await client.close();
  }
});

test('a new task sends the session back to planning, and submit_plan brings its plan in live', async ({
  page,
}, info) => {
  await open(page);
  const checkout = page.getByTestId('session-row').filter({ hasText: 'Apple Pay checkout' });
  const planner = checkout.getByTestId('planner-node');
  await expect(planner).toHaveAttribute('data-state', 'done');
  await expect(planner.locator('.node-detail')).toHaveText('planned');
  await planner.getByTestId('session-more').click();
  await expect(checkout.getByTestId('session-plan-text')).toContainText('Goal: Apple Pay at checkout.');

  // A new task arrives: the Planner plans again. The question from before it stays the Builder's.
  await testRoute('/test/task', { text: 'Also support Google Pay' });
  await expect(planner.locator('.node-detail')).toHaveText('planning');
  await expect(planner).toHaveAttribute('data-state', 'current');
  await expect(checkout.locator('[data-stage="builder"]').getByTestId('node-ask')).toHaveText('1 question');
  await expect(checkout.getByTestId('session-plan')).toContainText('a newer task is being planned');

  const client = new Client({ name: 'e2e-agent', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${E2E.serverUrl}/mcp`), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${sessionToken(E2E.mcpToken, ids.checkout)}`,
          'X-Loop-Session-Id': String(ids.checkout),
        },
      },
    }),
  );
  try {
    const result = await client.callTool({
      name: 'submit_plan',
      arguments: {
        plan: 'Goal: Google Pay too.\n\nFiles: web/src/checkout/PaymentSheet.tsx',
        rigor: 'fast',
        rigorReason: 'A small change in one file.',
      },
    });
    expect(result.content).toEqual([{ type: 'text', text: 'Plan recorded. Now build it.' }]);
  } finally {
    await client.close();
  }
  // No reload: session.planned re-renders the board.
  await expect(planner.locator('.node-detail')).toHaveText('planned');
  await expect(checkout.getByTestId('session-plan-text')).toContainText('Goal: Google Pay too.');
  await expect(planner.getByTestId('node-ask')).toHaveCount(0);
  // The Planner's level flips the dial live, with its reason in the details and on the dial.
  const dial = checkout.getByTestId('rigor-dial');
  await expect(dial).toHaveAttribute('data-rigor', 'fast');
  await expect(checkout.getByTestId('session-rigor-source')).toHaveText(
    'Rigor set by the Planner: A small change in one file.',
  );
  await expect(dial.getByTestId('rigor-fast')).toHaveAttribute('title', /Set by the Planner: A small change/);
  await snap(page, info, 'live-planned');

  // The human's choice replaces the Planner's and is shown as theirs.
  await dial.getByRole('radio', { name: 'Thorough', exact: true }).click();
  await expect(dial).toHaveAttribute('data-rigor', 'thorough');
  await expect(checkout.getByTestId('session-rigor-source')).toHaveText('Rigor set by you');
  await expect(dial.getByTestId('rigor-thorough')).not.toHaveAttribute('title', /Planner/);
});

test('clicking the level the Planner picked pins it, and a later plan leaves it alone', async ({ page }) => {
  await open(page);
  const checkout = page.getByTestId('session-row').filter({ hasText: 'Apple Pay checkout' });
  const dial = checkout.getByTestId('rigor-dial');
  const submit = async (rigor: string, rigorReason: string) => {
    const client = new Client({ name: 'e2e-agent', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${E2E.serverUrl}/mcp`), {
        requestInit: {
          headers: {
            Authorization: `Bearer ${sessionToken(E2E.mcpToken, ids.checkout)}`,
            'X-Loop-Session-Id': String(ids.checkout),
          },
        },
      }),
    );
    try {
      await client.callTool({
        name: 'submit_plan',
        arguments: { plan: `Plan for ${rigor}`, rigor, rigorReason },
      });
    } finally {
      await client.close();
    }
  };
  await checkout.getByTestId('planner-node').getByTestId('session-more').click();
  await submit('light', 'A small change.');
  await expect(dial).toHaveAttribute('data-rigor', 'light');
  await expect(dial.getByTestId('rigor-light')).toHaveAttribute(
    'title',
    /Set by the Planner: A small change/,
  );

  // The same level, clicked: saved as the human's, and the hint says so.
  await dial.getByRole('radio', { name: 'Light', exact: true }).click();
  await expect(dial.getByTestId('rigor-light')).toHaveAttribute('title', /Set by you/);
  await expect(checkout.getByTestId('session-rigor-source')).toHaveText('Rigor set by you');
  await page.reload();
  await expect(dial.getByTestId('rigor-light')).toHaveAttribute('title', /Set by you/);

  // A later plan, with another pick, changes nothing.
  await submit('thorough', 'Payments.');
  await page.reload();
  await expect(dial).toHaveAttribute('data-rigor', 'light');
  await expect(dial.getByTestId('rigor-light')).not.toHaveAttribute('title', /Planner/);
});

test('the model name on a stage is changeable: it saves, survives a reload, and a later plan leaves it', async ({
  page,
}, info) => {
  await open(page);
  const checkout = page.getByTestId('session-row').filter({ hasText: 'Apple Pay checkout' });
  const lane = checkout.locator('[data-testid="lane"][data-pr-number="212"]');
  const review = lane.locator('[data-stage="review"]');
  const tests = lane.locator('[data-stage="tests"]');
  const name = (node: typeof review) => node.getByTestId('node-model-name');
  const stored = async (agent: string) => {
    const { projects } = await api<{
      projects: { sessions: { id: number; models: Record<string, { model: string; by: string }> }[] }[];
    }>('/tree');
    return projects.flatMap((p) => p.sessions).find((s) => s.id === ids.checkout)?.models[agent];
  };
  await expect(name(review)).toHaveText('opus');
  await expect(name(checkout.locator('[data-stage="builder"]'))).toHaveText('opus');

  // The caption is a button with a full accessible name; the keyboard opens the menu and Escape closes it.
  const button = review.getByTestId('node-model-button');
  await expect(button).toHaveAccessibleName(/^Model for .+: opus\. Change$/);
  await button.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByTestId('model-menu');
  await expect(menu).toBeVisible();
  for (const [i, alias] of ['opus', 'sonnet', 'haiku'].entries())
    await expect(menu.getByTestId('model-choice').nth(i)).toHaveText(alias);
  // Only Claude-capable models are offered, and the arrows move between them.
  await expect(menu.getByTestId('model-choice')).toHaveText(['opus', 'sonnet', 'haiku']);
  await menu.getByTestId('model-choice').first().focus();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByTestId('model-choice').nth(1)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(menu.getByTestId('model-choice').first()).toBeFocused();
  await menu.getByTestId('model-custom').fill('opencode/big-pickle');
  await expect(menu.getByTestId('model-custom-warning')).toBeVisible();
  await menu.getByTestId('model-custom').fill('');
  await expect(menu.getByTestId('model-custom-warning')).toHaveCount(0);
  await expect(menu.getByTestId('model-default')).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(button).toBeFocused();

  // Choosing a model shows at once, is saved as the human's, and survives a reload.
  await button.click();
  await menu
    .getByTestId('model-choice')
    .filter({ hasText: /^sonnet$/ })
    .click();
  await expect(menu).toHaveCount(0);
  await expect(name(review)).toHaveText('sonnet');
  await expect.poll(() => stored('review')).toEqual({ model: 'sonnet', by: 'human' });
  await page.reload();
  await expect(name(review)).toHaveText('sonnet');
  await expect(review.getByTestId('node-model')).toHaveAttribute('title', 'sonnet (set by you)');
  await expect(review.getByTestId('node-model')).toHaveAttribute('data-source', 'human');

  // A later plan picks models for the other agents but leaves the one the human chose.
  const client = new Client({ name: 'e2e-agent', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${E2E.serverUrl}/mcp`), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${sessionToken(E2E.mcpToken, ids.checkout)}`,
          'X-Loop-Session-Id': String(ids.checkout),
        },
      },
    }),
  );
  try {
    const result = await client.callTool({
      name: 'submit_plan',
      arguments: {
        plan: 'Goal: Google Pay too.',
        models: { review: 'haiku', tests: 'haiku', builder: 'sonnet' },
        modelsReason: 'A small change.',
      },
    });
    expect(result.content).toEqual([
      { type: 'text', text: 'Plan recorded. The human chose the model for review; it stays. Now build it.' },
    ]);
  } finally {
    await client.close();
  }
  // No reload: session.planned re-renders the board.
  await expect(name(tests)).toHaveText('haiku');
  await expect(tests.getByTestId('node-model')).toHaveAttribute('title', 'haiku (chosen by the Planner)');
  await expect(name(checkout.locator('[data-stage="builder"]'))).toHaveText('sonnet');
  await expect(name(review)).toHaveText('sonnet');
  await expect.poll(() => stored('review')).toEqual({ model: 'sonnet', by: 'human' });
  await checkout.getByTestId('planner-node').getByTestId('session-more').click();
  await expect(checkout.getByTestId('session-models-planner')).toHaveText(
    'Models picked by the Planner: tests haiku, builder sonnet: A small change.',
  );
  await expect(checkout.getByTestId('session-models-human')).toHaveText('Models set by you: review sonnet');

  // A free-text name: a long name shows its tail and keeps its full name in the title; a bad one is refused.
  await review.getByTestId('node-model-button').click();
  await menu.getByTestId('model-custom').fill('--dangerously-skip-permissions');
  await menu.getByTestId('model-custom-use').click();
  await expect(menu.getByRole('alert')).toContainText('not starting with a dash');
  await expect.poll(() => stored('review')).toEqual({ model: 'sonnet', by: 'human' });
  await menu.getByTestId('model-custom').fill('claude-opus-4-8');
  await menu.getByTestId('model-custom').press('Enter');
  await expect(menu).toHaveCount(0);
  await expect(name(review)).toHaveText('opus-4-8');
  await expect(review.getByTestId('node-model')).toHaveAttribute('title', 'claude-opus-4-8 (set by you)');
  await expect.poll(() => stored('review')).toEqual({ model: 'claude-opus-4-8', by: 'human' });
  await snap(page, info, 'models');

  // "Use the default" clears the pick: back to the session model, free for the Planner again.
  await review.getByTestId('node-model-button').click();
  await menu.getByTestId('model-default').click();
  await expect(name(review)).toHaveText('opus');
  await expect(review.getByTestId('node-model')).toHaveAttribute('title', 'opus (the default)');
  await expect.poll(() => stored('review')).toBeUndefined();
});

test('the model of a session on OpenCode is shown but cannot be changed', async ({ page }) => {
  await testRoute('/test/pr', {
    sessionId: ids.rss,
    pr: { projectId: ids.blog, repo: 'site', number: 46, stage: 'tests', round: 1 },
  });
  await open(page);
  const rss = page.getByTestId('session-row').filter({ hasText: 'RSS feed' });
  await expect(rss.locator('[data-stage="review"]').getByTestId('node-model-name')).toHaveText(
    'glm-5.3-flash-free',
  );
  await expect(rss.getByTestId('node-model-button')).toHaveCount(0);
});

test('answers with free text', async ({ page }) => {
  await open(page);
  const card = page.getByTestId('question').filter({ hasText: 'Dedupe Stripe webhooks' });
  await card.getByLabel('Free-text answer').fill('Postgres, with a unique index on event id');
  await card.getByRole('button', { name: 'Send' }).click();
  await expect(card).toBeHidden();
  await expect(page.locator('[data-stage="builder"][data-state="waiting"]')).toHaveCount(0);
  const { question } = await api<{ question: { status: string; answer: string; answeredVia: string } }>(
    `/questions/${ids.question}`,
  );
  expect(question).toMatchObject({
    status: 'answered',
    answer: 'Postgres, with a unique index on event id',
    answeredVia: 'dashboard',
  });
});

test('a question answered elsewhere disappears live', async ({ page }) => {
  await open(page);
  const { question } = await testRoute<{ question: { id: number } }>('/test/ask', {
    text: 'Telegram will answer this one',
    options: ['A', 'B'],
    recommended: 'A',
  });
  const card = page.getByTestId('question').filter({ hasText: 'Telegram will answer this one' });
  await expect(card).toBeVisible();
  // Another channel (here: the API, as an add-in channel would through the bus) answers first.
  await api(`/questions/${question.id}/answer`, { method: 'POST', body: JSON.stringify({ answer: 'B' }) });
  await expect(card).toBeHidden();
});

test('project toggles and settings save to the server', async ({ page }, info) => {
  await open(page);
  const shop = await projectSettings(page, 'shop');

  await shop.getByTestId('toggle-autoMerge').click();
  await expect(shop.getByTestId('toggle-autoMerge')).toBeChecked();
  await expect
    .poll(
      async () => (await api<{ project: { autoMerge: boolean } }>(`/projects/${ids.shop}`)).project.autoMerge,
    )
    .toBe(true);

  const sheet = await globalSettings(page);
  await sheet.getByTestId('input-fallbackModel').fill('opencode/qwen-free');
  await sheet.getByTestId('input-fallbackModel').press('Enter');
  await expect
    .poll(
      async () => (await api<{ settings: { fallbackModel: string } }>('/settings')).settings.fallbackModel,
    )
    .toBe('opencode/qwen-free');

  // The chat allowlist is managed outside the dashboard now; the sheet has no editor for it.
  await expect(page.getByTestId('allowlist')).toHaveCount(0);

  // Everything survives a reload, because it came from the server.
  await page.reload();
  const reloaded = await projectSettings(page, 'shop');
  await expect(reloaded.getByTestId('toggle-autoMerge')).toBeChecked();
  await expectNoHorizontalScroll(page);
  await snap(page, info, 'live-settings');
});

test('a toggle flips from a click anywhere on its row, the description included', async ({ page }) => {
  await open(page);
  const shop = await projectSettings(page, 'shop');
  await expect(shop.getByTestId('toggle-autoMerge')).not.toBeChecked();
  await shop.getByText('Merge when review, tests and QA pass').click();
  await expect(shop.getByTestId('toggle-autoMerge')).toBeChecked();
  await expect
    .poll(
      async () => (await api<{ project: { autoMerge: boolean } }>(`/projects/${ids.shop}`)).project.autoMerge,
    )
    .toBe(true);
});

test('+ on a project starts a session there; + on a session sends it a message', async ({ page }, info) => {
  await open(page);
  const shop = page.locator('[data-testid="project"][data-project="shop"]');
  await shop.getByTestId('project-plus').click();
  const project = shop.getByTestId('project-composer');
  await project.getByLabel('New session in shop').fill('Add a gift card option');
  await project.getByRole('button', { name: 'Start session' }).click();
  await expect(project.getByRole('status')).toHaveText('Sent.');

  const checkout = shop.getByTestId('session-row').filter({ hasText: 'Apple Pay checkout' });
  await checkout.getByTestId('session-plus').click();
  const message = checkout.getByTestId('session-composer');
  await message.getByLabel('Message to “Apple Pay checkout”').fill('Also handle refunds');
  await message.getByRole('button', { name: 'Send to session' }).click();
  await expect(message.getByRole('status')).toHaveText('Sent to the session.');
  await expect(message.getByRole('textbox')).toHaveValue('');
  await snap(page, info, 'live-plus');

  const { requests } = await api<{
    requests: { text: string; projectId: number | null; targetSessionId: number | null }[];
  }>('/requests');
  expect(requests.slice(0, 2)).toEqual([
    expect.objectContaining({
      text: 'Also handle refunds',
      projectId: ids.shop,
      targetSessionId: ids.checkout,
    }),
    expect.objectContaining({ text: 'Add a gift card option', projectId: ids.shop, targetSessionId: null }),
  ]);
});

test('the board shows the server data: nodes, lanes, the loop question, usage', async ({ page }, info) => {
  await open(page);
  const shop = page.locator('[data-testid="project"][data-project="shop"]');
  await expect(shop.getByTestId('session-row')).toHaveCount(2);
  const search = shop.getByTestId('session-row').filter({ hasText: 'Search relevance' });
  await expect(search.getByTestId('session-header-status')).toHaveText('Paused · usage limit');
  // The loop's approval question is on the Approval node of api#85.
  const approval = search.locator('[data-pr-number="85"] [data-stage="awaiting_approval"]');
  await expect(approval).toHaveAttribute('data-state', 'waiting');
  const card = search.getByTestId('question');
  await expect(card.locator('.asker')).toHaveText('Approval · api#85');
  await card.getByRole('button', { name: 'Merge' }).click();
  await expect(card).toBeHidden();
  await expect(approval).toHaveAttribute('data-state', 'current');
  const { question } = await api<{ question: { status: string; answer: string } }>(
    `/questions/${ids.approval}`,
  );
  expect(question).toMatchObject({ status: 'answered', answer: 'Merge' });

  const checkout = shop.getByTestId('session-row').filter({ hasText: 'Apple Pay checkout' });
  const web = checkout.locator('[data-testid="lane"][data-pr-number="212"]');
  await expect(web.locator('[data-stage="qa"]')).toHaveAttribute('data-state', 'current');
  await expect(web).toContainText('round 2/5');
  await expect(checkout.getByTestId('subagent-count')).toContainText('2 subagents');
  await checkout.getByTestId('session-more').click();
  await expect(checkout.getByTestId('subagent')).toHaveCount(2);
  const blog = page.locator('[data-testid="project"][data-project="blog"]');
  // The deployed PR ships on the Deploy node instead of a separate end node.
  await expect(blog.locator('[data-pr-number="44"] [data-stage="deploying"]')).toContainText('shipped');

  // Claude usage from the status line snapshot: 91% of the 5-hour window shows red.
  await expect(page.getByTestId('claude-mark')).toContainText('Claude');
  const fiveHour = page.locator('[data-testid="usage-meter"][data-window="5-hour"]');
  await expect(fiveHour).toContainText('91%');
  await expect(fiveHour).toHaveClass(/\bbad\b/);
  await expect(page.locator('[data-testid="usage-meter"][data-window="Weekly"]')).toContainText('12%');
  await expectNoHorizontalScroll(page);
  await snap(page, info, 'live-board-data');
});

test('an imported session shows in the Finished group, marked imported, with no End session', async ({
  page,
}, info) => {
  await open(page);
  const blog = page.locator('[data-testid="project"][data-project="blog"]');
  // Still listed as a live session of the project: only the runner-started one.
  await expect(blog.getByTestId('session-row')).toHaveCount(1);
  const finished = blog.getByTestId('finished');
  await finished.getByText('Finished (1)').click();
  const row = finished.getByTestId('finished-session');
  await expect(row).toContainText('Migrate the blog to MDX');
  await expect(row.getByTestId('imported-chip')).toHaveText('Imported');
  await expect(row.getByTestId('finished-date')).toHaveAttribute('datetime', '2026-09-03T10:30:00.000Z');
  await expect(finished.getByTestId('end-session-button')).toHaveCount(0);
  const { projects } = await api<{
    projects: { name: string; sessions: { source: string; status: string }[] }[];
  }>('/tree');
  expect(projects.find((p) => p.name === 'blog')?.sessions.filter((s) => s.source === 'import')).toEqual([
    expect.objectContaining({ status: 'ended' }),
  ]);
  await expectNoHorizontalScroll(page);
  await snap(page, info, 'live-board-imported');
});

/** The id Next gave a Server Action in this build. */
function actionId(name: string): string {
  const manifest = JSON.parse(readFileSync('.next/server/server-reference-manifest.json', 'utf8')) as {
    node: Record<string, { exportedName: string }>;
  };
  const id = Object.entries(manifest.node).find(([, v]) => v.exportedName === name)?.[0];
  if (!id) throw new Error(`no Server Action named ${name}`);
  return id;
}

test('a rebound Host gets no data and a cross-site Server Action changes nothing', async ({ playwright }) => {
  const other = await playwright.request.newContext({ baseURL: E2E.liveUrl });
  try {
    // A page's RSC payload, as a client navigation fetches it, under a DNS-rebound hostname.
    const page = await other.get('/', {
      headers: { RSC: '1', Host: `evil.example:${E2E.livePort}` },
      maxRedirects: 0,
    });
    expect(page.status()).toBe(403);
    expect(await page.text()).not.toContain('Apple Pay checkout');

    // answerQuestion posted from another site, from nowhere (no Origin), and under a rebound Host.
    const send = (headers: Record<string, string>) =>
      other.post('/', {
        headers: {
          'Next-Action': actionId('answerQuestion'),
          'Content-Type': 'text/plain;charset=UTF-8',
          ...headers,
        },
        data: JSON.stringify([ids.question, 'Redis SET']),
        maxRedirects: 0,
      });
    for (const headers of <Record<string, string>[]>[
      { Origin: 'http://evil.example' },
      {},
      { Origin: `http://evil.example:${E2E.livePort}`, Host: `evil.example:${E2E.livePort}` },
    ]) {
      expect((await send(headers)).status(), JSON.stringify(headers)).toBe(403);
    }
    const before = await api<{ question: { status: string } }>(`/questions/${ids.question}`);
    expect(before.question.status).toBe('pending');

    // The same call from the dashboard's own origin goes through (so the refusals are not vacuous).
    await send({ Origin: E2E.liveUrl });
    const after = await api<{ question: { status: string; answer: string } }>(`/questions/${ids.question}`);
    expect(after.question).toMatchObject({ status: 'answered', answer: 'Redis SET' });
  } finally {
    await other.dispose();
  }
});

test('a folder project shows a Folder chip and its path; auto-merge is n/a', async ({ page }, info) => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'loop-e2e-folder-')));
  writeFileSync(join(folder, 'resume.md'), '# Resume\n');
  try {
    const created = await api<{ project: { id: number; kind: string; folderPath: string } }>('/projects', {
      method: 'POST',
      body: JSON.stringify({ name: 'resume', kind: 'folder', folderPath: folder }),
    });
    expect(created.project).toMatchObject({ kind: 'folder', folderPath: folder });
    // kind cannot change afterwards.
    const changed = await fetch(`${E2E.serverUrl}/api/projects/${created.project.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${E2E.dashboardToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'git' }),
    });
    expect(changed.status).toBe(400);

    await open(page);
    const board = page.locator('[data-testid="project"][data-project="resume"]');
    await expect(board.getByTestId('kind-chip')).toHaveText('Folder');
    await expect(board.getByTestId('folder-path')).toHaveText(folder);
    await expect(
      page.locator('[data-testid="project"][data-project="shop"]').getByTestId('kind-chip'),
    ).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    await snap(page, info, 'live-board-folder');

    const settings = await projectSettings(page, 'resume');
    await expect(settings.getByTestId('kind-chip')).toHaveText('Folder');
    await expect(settings.getByTestId('folder-path')).toHaveText(folder);
    await expect(settings.getByTestId('autoMerge-na')).toContainText('n/a (no PRs)');
    await expect(settings.getByTestId('toggle-autoMerge')).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    await snap(page, info, 'live-settings-folder');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('the trimmed board: no idle note on an idle project, no repo names by the title, CR and no "no PR yet"', async ({
  page,
}, info) => {
  // A fresh git project with repos but no sessions: the board has no rows for it.
  const created = await api<{ project: { id: number; name: string; kind: string } }>('/projects', {
    method: 'POST',
    body: JSON.stringify({
      name: 'docs',
      repos: [
        { name: 'docs', path: '/tmp/docs-src', remote: 'git@example.com:docs.git', defaultBranch: 'main' },
      ],
    }),
  });
  expect(created.project).toMatchObject({ kind: 'git', name: 'docs' });
  await open(page);
  // Where the old board said "Nothing running. Use + Session to start one.", nothing shows.
  await expect(page.getByText('Nothing running')).toHaveCount(0);
  const docs = page.locator('[data-testid="project"][data-project="docs"]');
  // A git project's title is just the name: the repo names went to the lanes.
  await expect(docs.locator('.project-title')).toContainText('docs');
  await expect(docs.locator('.project-title .muted')).toHaveCount(0);
  await expect(docs.getByTestId('kind-chip')).toHaveCount(0);
  await expect(docs.locator('.rows')).toHaveCount(0);
  // No filler under the lane label either, and the review node is titled CR.
  await expect(page.getByText('no PR yet')).toHaveCount(0);
  await expect(page.locator('[data-pr-number="212"] [data-stage="review"] .node-title')).toHaveText('CR');
  await expectNoHorizontalScroll(page);
  await snap(page, info, 'live-board-idle');
});

test('a git project with live rows names itself alone: no repo list beside the title', async ({ page }) => {
  // The idle check above covers a project with no rows; shop has rows and shared repo names ('web'
  // appears on two lanes), so a repo list would be visible here if the header still held one.
  await open(page);
  const shop = page.locator('[data-testid="project"][data-project="shop"]');
  await expect(shop.locator('.rows')).not.toHaveCount(0);
  await expect(shop.locator('.project-title')).toContainText('shop');
  await expect(shop.locator('.project-title .muted')).toHaveCount(0);
  await expect(shop.getByTestId('kind-chip')).toHaveCount(0);
});

test('a lane with no PR shows no filler text, and Deploy reports merged, reverted and a deploy question', async ({
  page,
}, info) => {
  // Board states the seed does not hold: a session that opened no PR, a merged one still waiting
  // for its deploy, a reverted one, and a deploy failure asking on the Deploy node.
  const shop = page.locator('[data-testid="project"][data-project="shop"]');
  await testRoute('/test/pr', { session: { projectId: ids.shop, title: 'Gift card checkout' } });
  await testRoute('/test/pr', {
    session: { projectId: ids.shop, title: 'Cache the pricing page' },
    pr: { projectId: ids.shop, repo: 'web', number: 902, stage: 'merge', round: 1, outcome: 'merged' },
  });
  await testRoute('/test/pr', { session: { projectId: ids.blog, title: 'Add a sitemap' } });
  await testRoute('/test/pr', {
    session: { projectId: ids.blog, title: 'Trim the images' },
    pr: { projectId: ids.blog, repo: 'site', number: 903, stage: 'reverted', round: 1, outcome: 'reverted' },
  });
  await testRoute('/test/pr', {
    sessionId: ids.checkout,
    pr: { projectId: ids.shop, repo: 'web', number: 901, stage: 'deploying', round: 1, deployQuestion: true },
  });

  await open(page);
  // A session with no PR shows the placeholder lane: an empty label where "no PR yet" used to sit.
  const gift = shop.getByTestId('session-row').filter({ hasText: 'Gift card checkout' });
  const giftLane = gift.locator('[data-testid="lane"][data-pr-number=""]');
  await expect(giftLane).toHaveCount(1);
  await expect(giftLane.locator('.lane-label')).toHaveText('');
  await expect(giftLane.locator('[data-stage="deploying"] .node-detail')).toHaveText('not yet');
  // Auto-merge is off for shop: the placeholder pipeline still carries its Approval node.
  await expect(giftLane.locator('[data-stage="awaiting_approval"] .node-title')).toHaveText('Approval');
  // blog approves on its own: its placeholder lane has no Approval node either.
  const sitemap = page
    .locator('[data-testid="project"][data-project="blog"]')
    .getByTestId('session-row')
    .filter({ hasText: 'Add a sitemap' });
  await expect(sitemap.locator('[data-pr-number=""]')).toHaveCount(1);
  await expect(sitemap.locator('[data-stage="awaiting_approval"]')).toHaveCount(0);
  // The page-wide filler check now runs against real placeholder lanes.
  await expect(page.getByText('no PR yet')).toHaveCount(0);

  // Merged with a deploy still to come: the Deploy node says merged.
  const cache = shop.getByTestId('session-row').filter({ hasText: 'Cache the pricing page' });
  await expect(cache.locator('[data-pr-number="902"] [data-stage="deploying"] .node-detail')).toHaveText(
    'merged',
  );
  // Reverted: the failed lane end shows on Deploy too.
  await expect(
    page.locator('[data-pr-number="903"] [data-stage="deploying"][data-state="failed"] .node-detail'),
  ).toHaveText('reverted');

  // A deploy question sits on the Deploy node: it waits on you, and the card names Deploy.
  const web901 = shop.locator('[data-testid="lane"][data-pr-number="901"]');
  await expect(web901.locator('[data-stage="deploying"]')).toHaveAttribute('data-state', 'waiting');
  await expect(web901.locator('[data-stage="deploying"]')).toContainText('waiting on you');
  const deployCard = shop.getByTestId('question').filter({ hasText: 'deploy stalled' });
  await expect(deployCard.locator('.asker')).toHaveText('Deploy · web#901');

  await expectNoHorizontalScroll(page);
  await snap(page, info, 'live-lane-ends');
});

test('Deploy says closed when a human closed the PR, running while deploying, and an escalation lands there', async ({
  page,
}) => {
  // Three PR states the seed does not hold: one the human closed, one mid-deploy with nothing
  // asked yet, and one the loop gave up on, asking an escalating question on the lane's end.
  const shop = page.locator('[data-testid="project"][data-project="shop"]');
  const blog = page.locator('[data-testid="project"][data-project="blog"]');
  await testRoute('/test/pr', {
    session: { projectId: ids.shop, title: 'Close out the coupons' },
    pr: { projectId: ids.shop, repo: 'web', number: 904, stage: 'qa', round: 2, outcome: 'closed' },
  });
  await testRoute('/test/pr', {
    session: { projectId: ids.shop, title: 'Cache the top banner' },
    pr: { projectId: ids.shop, repo: 'web', number: 906, stage: 'deploying', round: 1 },
  });
  await testRoute('/test/pr', {
    session: { projectId: ids.blog, title: 'Rewrite the README' },
    pr: {
      projectId: ids.blog,
      repo: 'site',
      number: 905,
      stage: 'escalated',
      round: 1,
      escalationQuestion: 'The checkout PR keeps failing. Give up?',
    },
  });

  await open(page);
  // Closed by a human: every node halted, and Deploy carries the ended word too.
  const web904 = shop.locator('[data-testid="lane"][data-pr-number="904"]');
  await expect(web904.locator('[data-stage="deploying"]')).toHaveAttribute('data-state', 'halted');
  await expect(web904.locator('[data-stage="deploying"] .node-detail')).toHaveText('closed');
  await expect(web904.locator('[data-stage="review"]')).toContainText('stopped');
  // Deploying with nothing asked: the node is live, the detail is the plain state word.
  const web906 = shop.locator('[data-testid="lane"][data-pr-number="906"]');
  await expect(web906.locator('[data-stage="deploying"]')).toHaveAttribute('data-state', 'current');
  await expect(web906.locator('[data-stage="deploying"] .node-detail')).toHaveText('running');
  // An escalation question sits on the lane's end: the Deploy node waits on you for it, and the
  // card above the row names where it came from.
  const site905 = blog.locator('[data-testid="lane"][data-pr-number="905"]');
  const deploy905 = site905.locator('[data-stage="deploying"]');
  await expect(deploy905).toHaveAttribute('data-state', 'waiting');
  await expect(deploy905.locator('.node-detail')).toHaveText('escalated');
  await expect(deploy905.getByTestId('node-ask')).toHaveText('1 question');
  const escalationCard = blog.getByTestId('question').filter({ hasText: 'keeps failing. Give up?' });
  await expect(escalationCard.locator('.asker')).toHaveText('Escalated · site#905');
});

test('ends a session from its details after a confirm step', async ({ page }, info) => {
  await open(page);
  const card = page.getByTestId('session-row').filter({ hasText: 'Search relevance' });
  await card.getByTestId('session-more').click();
  await card.getByTestId('end-session-button').click();
  await expect(card.getByText('End it?')).toBeVisible();
  // Keep it backs out without ending anything.
  await card.getByRole('button', { name: 'Keep it' }).click();
  await expect(card.getByTestId('end-session-button')).toBeVisible();
  await card.getByTestId('end-session-button').click();
  await expectNoHorizontalScroll(page);
  await snap(page, info, 'live-end-session-confirm');
  await card.getByTestId('end-session-confirm').click();
  await expect
    .poll(async () => {
      const { projects } = await api<{
        projects: { sessions: { id: number; title: string; status: string }[] }[];
      }>('/tree');
      return projects.flatMap((p) => p.sessions).find((s) => s.title === 'Search relevance')?.status;
    })
    .toBe('ended');
  // Its PR still waits for approval, so the row stays on the board, its session ended.
  await expect(card.getByTestId('session-header-status')).toHaveText('Ended');
  await expect(card.getByTestId('session-plus')).toHaveCount(0);
});

test('the editor applies the shared pipeline on Save, and keeps the board layout', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page);
  // A project hidden on the board first: the editor's Save must keep it hidden.
  const names = () => page.getByTestId('project').evaluateAll((els) => els.map((e) => e.dataset.project));
  const last = (await names()).at(-1)!;
  await projectSettings(page, last);
  await page.locator(`[data-testid="project"][data-project="${last}"]`).getByTestId('hide-project').click();
  await expect.poll(names).not.toContain(last);
  await page.getByRole('link', { name: 'Edit the pipelines' }).click();
  const editor = page.getByTestId('editor');
  await expect(editor.getByTestId('pipeline-scope')).toContainText('The shared pipeline: blog, shop run it');
  await editor.getByRole('button', { name: 'Move Code review left' }).click();
  await editor.getByTestId('new-stage').click();
  await page.getByLabel('Name').fill('Docs check');
  await page.getByLabel('Label on the node (10 characters at most)').fill('Docs');
  await page.getByTestId('stage-prompt').fill('Check the README covers the change.');
  await page.getByTestId('stage-save').click();
  await editor.getByRole('button', { name: 'Edit Guardian' }).click();
  await page.getByLabel('Instructions').fill('Check the booking flow end to end.');
  await page.getByTestId('stage-save').click();
  await editor.getByRole('button', { name: 'Edit Planner' }).click();
  await page.getByLabel('Instructions').fill('Read the code, then plan in five lines.');
  await page.getByTestId('stage-save').click();
  await editor.getByTestId('editor-save').click();
  await expect(page.getByTestId('confirm-dialog')).toContainText(
    'Apply these changes to the shared pipeline?',
  );
  await page.getByTestId('confirm-yes').click();
  await expect(page).toHaveURL(/\/$/);
  await snap(page, info, 'after-approve');

  // The real board and the real server have it.
  const { pipeline, stages, guardian, planner, projects } = await api<{
    pipeline: { checks: string[] };
    stages: { id: string; prompt: string }[];
    guardian: { prompt: string };
    planner: { prompt: string; overridden: boolean };
    projects: Record<string, unknown>;
  }>('/pipeline');
  expect(pipeline.checks).toEqual(['review', 'tests', 'qa', 'docs-check']);
  expect(stages.find((s) => s.id === 'docs-check')?.prompt).toBe('Check the README covers the change.');
  expect(guardian.prompt).toBe('Check the booking flow end to end.');
  expect(planner).toMatchObject({ prompt: 'Read the code, then plan in five lines.', overridden: true });
  expect(stages.map((s) => s.id)).not.toContain('planner');
  expect(projects).toEqual({});
  const lane = page.getByTestId('lane').first();
  await expect(lane.locator('[data-testid="node"]').first()).toHaveAttribute('data-stage', 'review');
  await expect(lane.locator('[data-stage="docs-check"]')).toContainText('Docs');
  expect(await names()).not.toContain(last);
});

test("a project's tab gives it its own pipeline on Save; the other projects keep the shared one", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page);
  await page.getByRole('link', { name: 'Edit the pipelines' }).click();
  const editor = page.getByTestId('editor');
  await editor.locator('[data-testid="editor-tab"][data-project="' + ids.shop + '"]').click();
  await expect(page).toHaveURL(new RegExp(`/edit\\?project=${ids.shop}$`));
  await expect(editor.getByTestId('pipeline-scope')).toContainText('shop runs the shared pipeline');
  // QA goes for shop only, and its Planner gets its own instructions.
  await editor.getByRole('button', { name: 'Remove Manual QA' }).click();
  await editor.getByRole('button', { name: 'Edit Planner' }).click();
  await page.getByLabel('Instructions').fill('Plan shop work in three lines.');
  await page.getByTestId('stage-save').click();
  // Another tab while something changed asks first; Keep editing stays here.
  await editor.locator('[data-testid="editor-tab"][data-project="shared"]').click();
  await expect(page.getByTestId('confirm-dialog')).toContainText('Discard your changes?');
  await page.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page).toHaveURL(new RegExp(`project=${ids.shop}$`));
  await editor.getByTestId('editor-save').click();
  await expect(page.getByTestId('confirm-dialog')).toContainText(
    "Apply these changes to shop's own new pipeline?",
  );
  await page.getByTestId('confirm-yes').click();
  await expect(page).toHaveURL(/\/$/);

  type View = {
    pipeline: { checks: string[] };
    planner: { prompt: string };
    project: { own: boolean; dir: string };
    projects?: Record<string, { pipeline: { checks: string[] } }>;
  };
  const shop = await api<View>(`/pipeline?project=${ids.shop}`);
  expect(shop).toMatchObject({ pipeline: { checks: ['tests', 'review'] }, project: { own: true } });
  expect(shop.planner.prompt).toBe('Plan shop work in three lines.');
  expect(readFileSync(join(shop.project.dir, 'planner.md'), 'utf8')).toContain(
    'Plan shop work in three lines.',
  );
  const blog = await api<View>(`/pipeline?project=${ids.blog}`);
  expect(blog).toMatchObject({ pipeline: { checks: ['tests', 'review', 'qa'] }, project: { own: false } });
  expect((await api<View>('/pipeline')).projects?.[ids.shop]?.pipeline.checks).toEqual(['tests', 'review']);

  // The board draws shop's lanes without QA, and blog's with it.
  const lanes = (project: string) =>
    page.locator(`[data-testid="project"][data-project="${project}"] [data-testid="lane"]`).first();
  await expect(lanes('shop').locator('[data-stage="qa"]')).toHaveCount(0);
  await expect(lanes('blog').locator('[data-stage="qa"]')).toHaveCount(1);

  // Back in the editor, shop's tab is its own now, and the shared tab still has QA.
  await page.getByRole('link', { name: 'Edit the pipelines' }).click();
  await expect(editor.locator('[data-testid="editor-tab"][data-project="' + ids.shop + '"]')).not.toHaveClass(
    /on-shared/,
  );
  await expect(editor.locator('.lane-step > [data-item="qa"]')).toHaveCount(1);
});

test('a project moves up and hides from its settings, and shows again from the list under the board', async ({
  page,
}) => {
  await open(page);
  const names = () => page.getByTestId('project').evaluateAll((els) => els.map((e) => e.dataset.project));
  const before = await names();
  const last = before.at(-1)!;
  await projectSettings(page, last);
  // The panel stays open while its project moves.
  const placement = page
    .locator(`[data-testid="project"][data-project="${last}"]`)
    .getByTestId('project-placement');
  await placement.getByRole('button', { name: 'Move up' }).click();
  await expect.poll(names).toEqual([...before.slice(0, -2), last, before.at(-2)]);

  await placement.getByTestId('hide-project').click();
  await expect.poll(names).not.toContain(last);
  const hidden = page.getByTestId('hidden-projects');
  await hidden.locator('summary').click();
  await hidden.getByRole('button', { name: 'Show' }).click();
  await expect.poll(names).toContain(last);
});

test('a check is skipped for one PR from a pop-up on its node, and brought back the same way', async ({
  page,
}) => {
  await open(page);
  const lane = page.locator('[data-testid="lane"][data-pr-number="212"]');
  const qa = lane.locator('[data-testid="node"][data-stage="qa"]');
  // The node flips the moment the owner confirms: the save (a server action) is held until it has.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/*', async (route) => {
    if (isServerAction(route.request())) await held;
    await route.continue();
  });
  await qa.getByTestId('skip-check').click();
  const dialog = page.getByTestId('skip-dialog');
  await expect(dialog).toContainText('Skip QA for web#212?');
  await dialog.getByTestId('skip-confirm').click();
  await expect(dialog).toHaveCount(0);
  await expect(qa).toContainText('skipped');
  await expect(qa.getByTestId('skip-check')).toHaveText('Run again');
  const saved = page.waitForResponse((r) => isServerAction(r.request()));
  release();
  await saved;
  await page.unroute('**/*');
  await page.reload();
  await expect(qa).toContainText('skipped');
  await expect(qa.getByTestId('skip-check')).toHaveText('Run again');

  await qa.getByTestId('skip-check').click();
  await expect(page.getByTestId('skip-dialog')).toContainText('Run QA again for web#212?');
  await page.getByTestId('skip-confirm').click();
  await expect(qa.getByTestId('skip-check')).toHaveText('Skip');
  await expect(qa).not.toContainText('skipped');
});

test('a skip the server never gets flips the node back and reopens the pop-up with the error', async ({
  page,
}) => {
  await open(page);
  const qa = page.locator('[data-testid="lane"][data-pr-number="212"] [data-testid="node"][data-stage="qa"]');
  await page.route('**/*', (route) => (isServerAction(route.request()) ? route.abort() : route.continue()));
  await qa.getByTestId('skip-check').click();
  await page.getByTestId('skip-confirm').click();
  const dialog = page.getByTestId('skip-dialog');
  await expect(dialog.getByRole('alert')).not.toBeEmpty();
  await expect(dialog).toContainText('Skip QA for web#212?');
  await expect(qa.getByTestId('skip-check')).toHaveText('Skip');
  await expect(qa).not.toContainText('skipped');
});

test('the rigor dial saves a level, and every level draws every stage', async ({ page }, info) => {
  await testRoute('/test/pr', {
    sessionId: ids.rss,
    pr: { projectId: ids.blog, repo: 'site', number: 46, stage: 'tests', round: 1 },
  });
  await open(page);
  const row = page
    .locator('[data-testid="project"][data-project="blog"]')
    .getByTestId('session-row')
    .filter({ hasText: 'RSS feed' });
  const dial = row.getByTestId('rigor-dial');
  const lane = row.locator('[data-testid="lane"][data-pr-number="46"]');
  const stored = async () => {
    const { projects } = await api<{
      projects: { name: string; sessions: { id: number; rigor: string }[] }[];
    }>('/tree');
    return projects.find((p) => p.name === 'blog')?.sessions.find((s) => s.id === ids.rss)?.rigor;
  };
  await expect(dial).toHaveAttribute('data-rigor', 'fast');
  await expect(dial.getByTestId('rigor-caption')).toContainText('Fast: same stages, low effort');
  const stages = await lane
    .locator('[data-stage]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-stage')));
  expect(stages).toEqual(expect.arrayContaining(['tests', 'review', 'qa']));
  const sameStages = async () =>
    expect(
      await lane.locator('[data-stage]').evaluateAll((els) => els.map((e) => e.getAttribute('data-stage'))),
    ).toEqual(stages);

  await dial.getByRole('radio', { name: 'Thorough', exact: true }).click();
  await expect(dial).toHaveAttribute('data-rigor', 'thorough');
  await sameStages();
  await expect.poll(stored).toBe('thorough');
  await page.reload();
  await expect(dial).toHaveAttribute('data-rigor', 'thorough');
  await expect(dial.getByRole('radio', { name: 'Thorough', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await sameStages();

  // The keyboard moves along the dial like any radio group, and each step is saved.
  await dial.getByRole('radio', { name: 'Thorough', exact: true }).focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(dial).toHaveAttribute('data-rigor', 'light');
  await expect(dial.getByRole('radio', { name: 'Light', exact: true })).toBeFocused();
  await expect.poll(stored).toBe('light');
  await sameStages();
  await expect(lane).toContainText('round 1');
  await expect(lane).not.toContainText('round 1/');
  await snap(page, info, 'rigor');
});

test('the terminal dock opens a terminal per tab, switches between them and reloads on Try again', async ({
  page,
}) => {
  await open(page);
  const dock = page
    .getByTestId('session-row')
    .filter({ hasText: 'Apple Pay checkout' })
    .getByTestId('terminal-dock');
  await expect(dock.getByTestId('terminal-dock-toggle')).toHaveAttribute('aria-expanded', 'false');
  await dock.getByTestId('terminal-dock-toggle').click();

  // The Builder's terminal loads first, under a secret path (the stand-in ttyd serves any path).
  const frame = dock.locator('iframe.dock-frame');
  await expect(frame).toHaveAttribute('src', /^http:\/\/localhost:\d+\/[0-9a-f]{48}\/$/);
  const tabs = dock.getByTestId('terminal-tab');
  expect(await tabs.count()).toBeGreaterThan(1);
  await expect(tabs.first()).toContainText('Builder');

  // Hovering the selected tab or a tool keeps the dock dark (the global button hover is light).
  const darkOnHover = async (target: Locator) => {
    await target.hover();
    const bg = await target.evaluate((el) => getComputedStyle(el).backgroundColor);
    const [r, g, b] = bg.match(/\d+/g)!.map(Number);
    expect(r! + g! + b!).toBeLessThan(200);
  };
  await darkOnHover(tabs.first());
  await darkOnHover(dock.getByTitle('Reconnect'));

  const counts = async () =>
    (await (
      await fetch(`${E2E.serverUrl}/test/terminal-launches`, {
        headers: { Authorization: `Bearer ${E2E.mcpToken}` },
      })
    ).json()) as { launches: number; urlCalls: number };

  // This server has no PR loop, so a stage's terminal fails: the pane says why and Try again asks again.
  await tabs.nth(1).click();
  await expect(dock.getByRole('alert')).toBeVisible();
  const fetched = page.waitForRequest(isServerAction);
  await dock.getByRole('button', { name: 'Try again' }).click();
  await fetched; // a real new fetch, not just a re-render
  await expect(dock.getByRole('alert')).toBeVisible();

  // Back on the Builder: Reconnect asks the server again and gets the same running terminal.
  await tabs.first().click();
  await expect(frame).toBeVisible();
  const src = await frame.getAttribute('src');
  const before = await counts();
  const reconnect = page.waitForRequest(isServerAction);
  await dock.getByTitle('Reconnect').click();
  await reconnect;
  await expect(frame).toHaveAttribute('src', src!);
  await expect.poll(async () => (await counts()).urlCalls).toBe(before.urlCalls + 1);
  expect((await counts()).launches).toBe(before.launches); // reused, not started twice
});

test('when the agent moves to a new tmux window, the dock asks for a terminal on the new one', async ({
  page,
}) => {
  await open(page);
  const dock = page
    .getByTestId('session-row')
    .filter({ hasText: 'Apple Pay checkout' })
    .getByTestId('terminal-dock');
  await dock.getByTestId('terminal-dock-toggle').click();
  const frame = dock.locator('iframe.dock-frame');
  await expect(frame).toHaveAttribute('src', /\/[0-9a-f]{48}\/$/);
  const before = await frame.getAttribute('src');

  await testRoute('/test/relaunch'); // as after a relaunch or resume
  // The board re-reads when the tab becomes visible again (as it does on its 30-second poll).
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(async () => frame.getAttribute('src')).not.toBe(before);
  await expect(frame).toHaveAttribute('src', /^http:\/\/localhost:\d+\/[0-9a-f]{48}\/$/);
});
