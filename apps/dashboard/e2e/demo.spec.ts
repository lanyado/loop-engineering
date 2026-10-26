import { expect, test } from '@playwright/test';
import { expectNoHorizontalScroll, globalSettings, open, projectSettings, snap } from './helpers';

// The dashboard with no SERVER_URL: fixture data, labelled, read-only; DASHBOARD_AUTH=none (no login).

test('opens without a login: no cookie, no login page, no Log out', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('project').first()).toBeVisible();
  await page.goto('/login?next=%2Fmetrics');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('topbar-items')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Log out' })).toHaveCount(0);
  expect(await page.context().cookies()).toHaveLength(0);
  // Tokens never reach the browser.
  expect(await page.content()).not.toContain('DASHBOARD_TOKEN=');
});

test('the old tabs lead to the board', async ({ page }) => {
  for (const path of ['/tree', '/prs', '/metrics', '/settings', '/new']) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/$/);
  }
});

test('refuses a foreign Host and cross-site writes, and cannot be framed', async ({ page }) => {
  const res = await page.request.get('/');
  expect(res.status()).toBe(200);
  expect(res.headers()['x-frame-options']).toBe('DENY');
  expect(res.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(res.headers()['referrer-policy']).toBe('no-referrer');
  for (const host of ['evil.example:3101', '127.0.0.1.evil.example:3101']) {
    for (const path of ['/', '/api/events']) {
      const rebound = await page.request.get(path, { headers: { Host: host } });
      expect(rebound.status(), `${host}${path}`).toBe(403);
      expect(await rebound.text()).not.toContain('Stripe');
    }
  }
  for (const headers of <Record<string, string>[]>[{ Origin: 'http://evil.example' }, {}]) {
    const write = await page.request.post('/', {
      headers: { ...headers, 'Next-Action': '0'.repeat(42), 'Content-Type': 'text/plain' },
      data: '[]',
      maxRedirects: 0,
    });
    expect(write.status(), JSON.stringify(headers)).toBe(403);
  }
});

test('the top bar shows the 5-hour and weekly limits', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('demo-banner')).toContainText('Demo data');
  // No "Live" indicator in the top bar any more; the meters carry the Claude mark beside them.
  await expect(page.getByTestId('live-status')).toHaveCount(0);
  await expect(page.getByTestId('claude-mark')).toContainText('Claude');
  const meters = page.getByTestId('usage-meter');
  await expect(meters).toHaveCount(2);
  await expect(meters.first()).toContainText('5-hour');
  await expect(meters.first()).toContainText('38%');
  await expect(meters.first()).toContainText(/resets in 2h 1\dm/);
  await expect(meters.last()).toContainText('Weekly');
  await expect(meters.last().getByRole('meter')).toHaveAttribute('aria-valuenow', '64');
  await expect(page.getByTestId('usage-stale')).toHaveCount(0);
  // No tabs any more: one screen.
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
});

test('every live session is a pipeline of nodes, with questions on the node that asks', async ({
  page,
}, info) => {
  await open(page);
  // Projects waiting on you come first; idle ones last.
  await expect(page.getByTestId('project')).toHaveCount(4);
  await expect(page.getByTestId('project').first()).toHaveAttribute('data-project', 'shop');

  const shop = page.locator('[data-testid="project"][data-project="shop"]');
  await expect(shop.getByTestId('project-pending')).toHaveText('3 waiting on you');
  // The green "N working" counter is gone: only the waiting-on-you count stays.
  await expect(shop.getByTestId('working-count')).toHaveCount(0);
  const checkout = shop.getByTestId('session-row').filter({ hasText: 'Apple Pay checkout' });
  await expect(checkout.getByTestId('session-header-status')).toHaveText('Active');
  // Two open PRs: the pipeline splits into two lanes after the builder.
  await expect(checkout.getByTestId('lane')).toHaveCount(2);
  const web = checkout.locator('[data-testid="lane"][data-pr-number="212"]');
  await expect(web.locator('[data-stage="qa"]')).toHaveAttribute('data-state', 'current');
  await expect(web.locator('[data-stage="review"]')).toHaveAttribute('data-state', 'done');
  await expect(web.locator('[data-stage="merge"]')).toHaveAttribute('data-state', 'todo');
  // The colours the request asked for: done is green, the node in progress is purple (no longer
  // the indigo accent). Light palette in the tests: --good #166534, --progress #7c3aed.
  const doneBorder = await web
    .locator('[data-stage="review"]')
    .evaluate((el) => getComputedStyle(el).borderTopColor);
  expect(doneBorder).toBe('rgb(22, 101, 52)');
  const currentBorder = await web
    .locator('[data-stage="qa"]')
    .evaluate((el) => getComputedStyle(el).borderTopColor);
  expect(currentBorder).toBe('rgb(124, 58, 237)');
  await expect(web).toContainText('round 2/5');
  await expect(web.getByTestId('pr-metrics')).toHaveText('$3.42 · 1.9M tokens · 2 rounds · 1 failure');
  // The builder's agent asked twice: its node says so, and both cards sit under the row.
  const builder = checkout.locator('[data-stage="builder"]');
  await expect(builder).toHaveAttribute('data-state', 'waiting');
  await expect(builder.getByTestId('node-ask')).toHaveText('2 questions');
  await expect(checkout.getByTestId('subagent-count')).toContainText('3 subagents');
  const questions = checkout.getByTestId('question');
  await expect(questions).toHaveCount(2);
  const first = questions.filter({ hasText: 'Stripe sends the same webhook' });
  await expect(first.locator('.asker')).toHaveText('Builder › Stripe webhook handler');
  await expect(first.getByTestId('countdown')).toHaveText(/\d+:\d\d left/);
  await expect(first.getByRole('button', { name: /Postgres table/ })).toContainText('default');
  await first.getByText('Context').click();
  await expect(first.getByText('We already run Postgres')).toBeVisible();
  // Demo mode: every answer control is disabled.
  for (const button of await first.getByRole('button').all()) await expect(button).toBeDisabled();

  // The loop's approval question is on the Approval node of its PR, not on the builder.
  const search = shop.getByTestId('session-row').filter({ hasText: 'Search relevance' });
  await expect(search.getByTestId('session-header-status')).toHaveText('Paused · agent exited');
  const approval = search.locator(
    '[data-testid="lane"][data-pr-number="85"] [data-stage="awaiting_approval"]',
  );
  await expect(approval).toHaveAttribute('data-state', 'waiting');
  await expect(approval).toContainText('waiting on you');
  await expect(search.getByTestId('question').locator('.asker')).toHaveText('Approval · api#85');
  await expect(search.locator('[data-stage="builder"]')).toHaveAttribute('data-state', 'halted');

  // A deployed PR: every node done. An escalated one: the loop stopped.
  const blog = page.locator('[data-testid="project"][data-project="blog"]');
  await expect(blog.locator('[data-pr-number="44"] [data-stage="deploying"]')).toHaveAttribute(
    'data-state',
    'current',
  );
  await expect(blog.getByText('Paused · paused by you')).toBeVisible();
  const infra = page.locator('[data-testid="project"][data-project="infra"]');
  await expect(infra.locator('[data-pr-number="19"] [data-stage="deploying"]')).toContainText('escalated');
  // The escalation ends red: the Deploy node carries it as a failed lane end, not a grey stop.
  await expect(infra.locator('[data-pr-number="19"] [data-stage="deploying"]')).toHaveAttribute(
    'data-state',
    'failed',
  );
  // And the failed lane end is red, as the request asks for escalation: --bad #b91c1c.
  const failedBorder = await infra
    .locator('[data-pr-number="19"] [data-stage="deploying"]')
    .evaluate((el) => getComputedStyle(el).borderTopColor);
  expect(failedBorder).toBe('rgb(185, 28, 28)');
  // The lane's end label is only on the Deploy node: the others keep their own state word.
  await expect(infra.locator('[data-pr-number="19"] [data-stage="review"]')).toContainText('stopped');

  // blog has auto-merge on: its pipeline has no Approval node. shop approves by hand: nodes there.
  await expect(blog.locator('[data-stage="awaiting_approval"]')).toHaveCount(0);
  await expect(shop.locator('[data-stage="awaiting_approval"]')).not.toHaveCount(0);

  // A folder project: no lanes, a note instead.
  const resume = page.locator('[data-testid="project"][data-project="resume"]');
  await expect(resume.getByTestId('kind-chip')).toHaveText('Folder');
  await expect(resume.getByTestId('folder-path')).toHaveText('/Users/demo/resume');
  await expect(resume.getByTestId('lane')).toHaveCount(0);
  await expect(resume.getByTestId('no-prs-note')).toBeVisible();

  // Finished sessions are folded away.
  await expect(shop.getByText('Finished (1)')).toBeVisible();
  await expect(shop.getByText('Order export CSV')).toBeHidden();
  await expectNoHorizontalScroll(page);
  await snap(page, info, 'board');
});

test('finished stage nodes carry no state word, and the Builder is a narrow tile like the rest', async ({
  page,
}) => {
  await open(page);
  const checkout = page
    .locator('[data-testid="project"][data-project="shop"]')
    .getByTestId('session-row')
    .filter({ hasText: 'Apple Pay checkout' });
  const web = checkout.locator('[data-testid="lane"][data-pr-number="212"]');
  // Done is the green tile itself: no word under the title (Review has run, Merge has not started).
  await expect(web.locator('[data-stage="review"]')).toHaveAttribute('data-state', 'done');
  await expect(web.locator('[data-stage="review"] .node-detail')).toHaveCount(0);
  await expect(web.locator('[data-stage="review"]')).not.toContainText('done');
  // The other words survive: the not-yet stage still says so.
  await expect(web.locator('[data-stage="merge"][data-state="todo"]')).toContainText('not yet');

  // The Builder sits in the main flow but matches the lane tiles: a narrow rectangle with the
  // icon stacked over its label, and its title in the lane's small font.
  const builder = checkout.locator('[data-stage="builder"]');
  const builderLayout = await builder.evaluate((el) => {
    const style = getComputedStyle(el);
    return { flexDirection: style.flexDirection, padding: style.padding };
  });
  const laneLayout = await web.locator('[data-stage="qa"]').evaluate((el) => ({
    flexDirection: getComputedStyle(el).flexDirection,
    padding: getComputedStyle(el).padding,
  }));
  expect(builderLayout).toEqual(laneLayout);
  const builderTitleSize = await builder
    .locator('.node-title')
    .evaluate((el) => getComputedStyle(el).fontSize);
  const laneTitleSize = await web
    .locator('[data-stage="qa"] .node-title')
    .evaluate((el) => getComputedStyle(el).fontSize);
  expect(builderTitleSize).toBe(laneTitleSize);
  // The subagent count is in the session header above the pipeline.
  await expect(checkout.getByTestId('subagent-count')).toHaveText('3 subagents');
  // The builder node detail no longer includes the subagent count or midfield separator.
  await expect(builder.locator('.node-detail')).not.toContainText('·');
  // The question chip wraps inside the narrow tile instead of overflowing it.
  const ask = builder.getByTestId('node-ask');
  await expect(ask).toHaveText('2 questions');
  await expect(ask).toHaveCSS('white-space', 'normal');
  await expectNoHorizontalScroll(page);
});

test('session details and the + boxes are there, read-only in demo mode', async ({ page }, info) => {
  await open(page);
  const resume = page.locator('[data-testid="project"][data-project="resume"]');
  const row = resume.getByTestId('session-row').first();
  await row.getByTestId('session-more').click();
  const details = row.getByTestId('session-details');
  await expect(details).toContainText('in place, no branch');
  await expect(details.getByTestId('session-provider')).toHaveText('claude');
  await expect(details.getByTestId('end-session-button')).toBeDisabled();

  const checkout = page.getByTestId('session-row').filter({ hasText: 'Apple Pay checkout' });
  await checkout.getByTestId('session-more').click();
  await expect(checkout.getByTestId('subagent')).toHaveCount(3);
  // QA sent bugs back to the builder: the chip says so, the panel lists them.
  const chip = checkout.getByTestId('session-feedback-toggle');
  await expect(chip).toHaveText('1 feedback · QA');
  // The way back is drawn under the lane that sent it: a pill on a line from the QA stage.
  const back = checkout.getByTestId('return-path');
  await expect(back).toHaveCount(1);
  await expect(back.getByTestId('return-path-toggle')).toHaveText('QA · 2 back');
  await chip.click();
  const feedback = checkout.getByTestId('session-feedback');
  await expect(feedback).toContainText('QA failures (round 2/5) · the builder is fixing it, nothing to do');
  await expect(feedback.getByTestId('feedback-items')).toContainText('The Apple Pay button is misaligned');
  await chip.click();
  await expect(checkout.getByTestId('session-feedback')).toHaveCount(0);
  await checkout.getByTestId('session-plus').click();
  const composer = checkout.getByTestId('session-composer');
  await expect(composer).toContainText('Message to “Apple Pay checkout”');
  await expect(composer.getByRole('button', { name: 'Send to session' })).toBeDisabled();
  // A reply keeps its compact box: only a new session's prompt got the extra rows.
  await expect(composer.locator('textarea')).toHaveAttribute('rows', '3');

  const shop = page.locator('[data-testid="project"][data-project="shop"]');
  await shop.getByTestId('project-plus').click();
  await expect(shop.getByTestId('project-composer')).toContainText('New session in shop');
  // The new session prompt is a long one now: 8 rows, not the 3-row reply box.
  await expect(shop.getByTestId('project-composer').locator('textarea')).toHaveAttribute('rows', '8');
  await expect(
    shop.getByTestId('project-composer').getByRole('button', { name: 'Start session' }),
  ).toBeDisabled();

  // New sessions start here and nowhere else: the top bar has no "+ New session" button.
  await expect(page.getByTestId('new-task-link')).toHaveCount(0);
  await expect(page.getByTestId('new-task-form')).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  await snap(page, info, 'board-panels');
});

test('a Finished group lists imported sessions newest first, without End session', async ({ page }, info) => {
  await open(page);
  const resume = page.locator('[data-testid="project"][data-project="resume"]');
  const finished = resume.getByTestId('finished');
  // Folded by default: a long history does not flood the page.
  await expect(finished.getByText('Finished (23)')).toBeVisible();
  await expect(finished.getByTestId('finished-session').first()).toBeHidden();
  await finished.getByText('Finished (23)').click();
  const rows = finished.getByTestId('finished-session');
  await expect(rows.first()).toBeVisible();
  await expect(rows.first()).toContainText('Archive the old drafts');
  await expect(rows.first().getByTestId('imported-chip')).toHaveText('Imported');
  await expect(rows.first().getByTestId('finished-date')).toHaveText(/^\d{1,2} \w{3} \d{4}$/);
  // 20 shown, the rest behind "Show 3 more".
  await expect(rows.filter({ visible: true })).toHaveCount(20);
  const more = finished.getByTestId('show-more');
  const shown = finished.getByTestId('shown-count');
  await expect(more).toHaveText('Show 3 more');
  await expect(shown).toHaveText('20 of 23 shown');
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await more.click();
  await expect(rows.filter({ visible: true })).toHaveCount(23);
  // Open, it says so and sits under the whole list, with the count still in view.
  await expect(more).toHaveText('Show fewer');
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await expect(shown).toHaveText('23 of 23 shown');
  const lastRow = await rows.last().boundingBox();
  const button = await more.boundingBox();
  expect(button!.y).toBeGreaterThan(lastRow!.y + lastRow!.height - 1);
  await more.click();
  await expect(rows.filter({ visible: true })).toHaveCount(20);
  await expect(more).toHaveText('Show 3 more');
  await more.click();
  await expect(rows.filter({ visible: true })).toHaveCount(23);
  await expect(rows.last()).toContainText('Tailor the resume for a staff engineer role');
  // The oldest past conversation opens under its row: the stored transcript.
  const tailor = rows.filter({ hasText: 'Tailor the resume for a staff engineer role' }).first();
  await tailor.getByTestId('finished-view').click();
  await expect(tailor.getByTestId('finished-transcript-text')).toContainText(
    'Tailor my resume for the staff engineer role at Acme',
  );
  await rows.filter({ hasText: 'Archive the old drafts' }).first().getByTestId('finished-view').click();
  await expect(
    rows.filter({ hasText: 'Archive the old drafts' }).first().getByTestId('finished-transcript-text'),
  ).toHaveText(/No transcript stored for this session\.|Loading…/);
  const dates = await finished
    .getByTestId('finished-date')
    .evaluateAll((els) => els.map((el) => el.getAttribute('datetime') ?? ''));
  expect(dates).toEqual([...dates].sort().reverse());
  // Ended and imported sessions can never be ended again.
  await expect(finished.getByTestId('end-session-button')).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  await snap(page, info, 'board-finished');
});

test('a failed transcript fetch shows the failure, and reopening the panel retries it', async ({ page }) => {
  // Nothing in the panel is writable in demo mode, so this is read-only UI logic: the first fetch
  // fails, the panel says so, and the next open forgets the failure and fetches again.
  await page.route('**/api/sessions/*/transcript', (route) => route.abort());
  await open(page);
  const resume = page.locator('[data-testid="project"][data-project="resume"]');
  const finished = resume.getByTestId('finished');
  await finished.getByText('Finished (23)').click();
  const rows = finished.getByTestId('finished-session');
  await finished.getByTestId('show-more').click();
  await expect(rows.filter({ visible: true })).toHaveCount(23);
  const tailor = rows.filter({ hasText: 'Tailor the resume for a staff engineer role' }).first();
  await tailor.getByTestId('finished-view').click();
  await expect(tailor.getByTestId('finished-transcript-text')).toHaveText(
    'The transcript could not be loaded.',
  );
  // Stop breaking the fetch: the kept failure is forgotten, so reopening retries.
  await tailor.getByTestId('finished-view').click();
  await page.unroute('**/api/sessions/*/transcript');
  await tailor.getByTestId('finished-view').click();
  await expect(tailor.getByTestId('finished-transcript-text')).toContainText(
    'Tailor my resume for the staff engineer role at Acme',
  );
});

test('settings sit with their project and in the top bar, disabled in demo mode', async ({ page }, info) => {
  await open(page);
  const shop = await projectSettings(page, 'shop');
  await expect(shop.getByTestId('toggle-autoMerge')).not.toBeChecked();
  await expect(shop.getByTestId('toggle-markedForDirectInput')).toBeChecked();
  await expect(shop.getByTestId('toggle-autoMerge')).toBeDisabled();
  await expect((await projectSettings(page, 'infra')).getByTestId('permission-mode')).toHaveValue('plan');
  // bypassPermissions is never offered from the dashboard.
  await expect(page.locator('option[value="bypassPermissions"]')).toHaveCount(0);
  const resume = await projectSettings(page, 'resume');
  await expect(resume.getByTestId('kind-chip')).toHaveText('Folder');
  await expect(resume.getByTestId('autoMerge-na')).toContainText('n/a (no PRs)');
  await expect(resume.getByTestId('toggle-autoMerge')).toHaveCount(0);
  await expect(resume.getByTestId('toggle-markedForDirectInput')).toBeChecked();
  await expectNoHorizontalScroll(page);

  const sheet = await globalSettings(page);
  await expect(sheet.getByTestId('input-fallbackModel')).toHaveValue('opencode/glm-5.3-flash-free');
  // The chat allowlist is managed outside the dashboard now; the sheet has no editor for it.
  await expect(sheet.getByTestId('allowlist')).toHaveCount(0);
  await expect(sheet.getByRole('button', { name: 'Log out' })).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  await snap(page, info, 'settings');
});

test('the theme switch works in read-only demo mode and survives a reload', async ({ page }, info) => {
  const LIGHT = 'rgb(245, 246, 248)';
  const DARK = 'rgb(12, 14, 18)';
  const html = page.locator('html');
  const looks = () =>
    page.evaluate(() => ({
      bg: getComputedStyle(document.body).backgroundColor,
      scheme: getComputedStyle(document.documentElement).colorScheme,
    }));
  const pick = (label: string) =>
    page.getByTestId('settings-sheet').getByText(label, { exact: true }).click();
  const themeCookies = async () => (await page.context().cookies()).filter((c) => c.name === 'loop-theme');

  await page.emulateMedia({ colorScheme: 'light' });
  await open(page);
  await expect(html).not.toHaveAttribute('data-theme');
  await expect(
    (await globalSettings(page))
      .getByRole('group', { name: 'Appearance' })
      .getByRole('radio', { name: 'System' }),
  ).toBeChecked();
  expect(await looks()).toEqual({ bg: LIGHT, scheme: 'light dark' });

  // OS light, Dark picked.
  await pick('Dark');
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await expect.poll(looks).toEqual({ bg: DARK, scheme: 'dark' });
  await expect
    .poll(themeCookies)
    .toMatchObject([{ value: 'dark', httpOnly: true, sameSite: 'Lax', path: '/' }]);
  await snap(page, info, 'settings-dark');

  await page.reload();
  await expect(html).toHaveAttribute('data-theme', 'dark');
  expect(await looks()).toEqual({ bg: DARK, scheme: 'dark' });
  await expect((await globalSettings(page)).getByTestId('theme-dark')).toBeChecked();

  // OS dark: System follows it, Light overrides it.
  await page.emulateMedia({ colorScheme: 'dark' });
  await pick('System');
  await expect(html).not.toHaveAttribute('data-theme');
  await expect.poll(looks).toEqual({ bg: DARK, scheme: 'light dark' });
  await expect.poll(themeCookies).toHaveLength(0);
  await pick('Light');
  await expect(html).toHaveAttribute('data-theme', 'light');
  await expect.poll(looks).toEqual({ bg: LIGHT, scheme: 'light' });
  await expect.poll(themeCookies).toMatchObject([{ value: 'light' }]);
});

test('the pencil edits one example project in place; Save and Discard each ask first, and demo data cannot be saved', async ({
  page,
}, info) => {
  // Still items: the wiggle is off with reduced motion, so clicks land without waiting for it.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page);
  await page.getByRole('link', { name: 'Edit the dashboard' }).click();
  const editor = page.getByTestId('editor');
  await expect(editor).toBeVisible();
  // No help text, and the Session node carries none of its buttons here.
  await expect(editor.getByText('An example project with your layout')).toHaveCount(0);
  await expect(editor.getByTestId('session-plus')).toHaveCount(0);
  // One example project, and nothing to save yet: Discard just leaves.
  await expect(editor.getByTestId('project')).toHaveCount(1);
  await expect(editor.getByTestId('editor-save')).toBeDisabled();
  await editor.getByTestId('editor-discard').click();
  await expect(page).toHaveURL(/\/$/);
  await page.getByRole('link', { name: 'Edit the dashboard' }).click();

  // Top bar: the weekly limit goes, and stays in place faded, with a "+" that brings it back.
  await editor.getByRole('button', { name: 'Remove Weekly limit' }).click();
  await expect(editor.locator('[data-testid="ghost-item"][data-item="weekly"]')).toHaveCount(1);
  await editor.getByRole('button', { name: 'Add Weekly limit' }).click();
  await expect(editor.locator('[data-testid="editable-item"][data-item="weekly"]')).toHaveCount(1);
  await editor.getByRole('button', { name: 'Remove Weekly limit' }).click();

  // A part of the row: the PR's cost goes, faded where it was.
  await editor.getByRole('button', { name: 'Remove PR cost and tokens' }).click();
  await expect(editor.locator('[data-testid="ghost-item"][data-item="prMetrics"]')).toContainText('tokens');

  // The pipeline is edited on the example's own lane. A removed check waits faded where it was.
  const steps = editor.getByTestId('lane').locator('.lane-step > [data-item]');
  await editor.getByRole('button', { name: 'Remove Tests' }).click();
  await expect(steps.first()).toHaveAttribute('data-testid', 'ghost-item');
  await editor.getByRole('button', { name: 'Add Tests' }).click();
  await expect(steps.first()).toHaveAttribute('data-item', 'tests');
  // Code review moves before Tests, with a real mouse: the arrows show on hover, above the item's tap.
  const lane = editor.getByTestId('lane').locator('[data-testid="editable-item"]');
  const left = editor.getByRole('button', { name: 'Move Code review left' });
  await left.hover();
  const box = (await left.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByTestId('stage-sheet')).toHaveCount(0);
  await expect(lane.first()).toHaveAttribute('data-item', 'review');
  // After that reorder, − then + puts Tests back where it now sits, second.
  await editor.getByRole('button', { name: 'Remove Tests' }).click();
  await expect(steps.nth(1)).toHaveAttribute('data-testid', 'ghost-item');
  await editor.getByRole('button', { name: 'Add Tests' }).click();
  await expect(lane.nth(1)).toHaveAttribute('data-item', 'tests');
  // Dragging: QA, carried by the mouse onto the first place, lifts, and lands there without opening.
  const centre = async (item: string) => {
    const b = (await editor.locator(`.lane-step > [data-item="${item}"]`).boundingBox())!;
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  const [qa, first] = [await centre('qa'), await centre('review')];
  await page.mouse.move(qa.x, qa.y);
  await page.mouse.down();
  await page.mouse.move(qa.x - 20, qa.y, { steps: 4 });
  await expect(editor.locator('[data-item="qa"]')).toHaveClass(/lifted/);
  await page.mouse.move(first.x, first.y, { steps: 12 });
  await page.mouse.up();
  await expect(lane.first()).toHaveAttribute('data-item', 'qa');
  await expect(editor.locator('.lifted')).toHaveCount(0);
  await expect(page.getByTestId('stage-sheet')).toHaveCount(0);

  // A stage file not in the pipeline waits faded on the lane; "+" adds it.
  await editor.getByRole('button', { name: 'Add Security review' }).click();
  await expect(editor.locator('[data-testid="editable-item"][data-item="security"]')).toHaveCount(1);

  // A new stage, from the button above the pipeline, with the wider Runs choices.
  await editor.getByTestId('new-stage').click();
  await page.getByLabel('Name').fill('Docs check');
  await page.getByLabel('Label on the node (10 characters at most)').fill('Docs');
  await page.getByLabel('Runs').selectOption({ label: 'Only when docs change' });
  await page.getByTestId('stage-prompt').fill('Check the README covers the change.');
  await page.getByTestId('stage-save').click();
  await expect(editor.locator('[data-testid="editable-item"][data-item="docs-check"]')).toContainText('Docs');

  // Tapping a custom stage opens it; Delete takes it off the lane for good.
  await editor.getByRole('button', { name: 'Edit Security review' }).click();
  await page.getByTestId('stage-delete').click();
  await expect(editor.locator('[data-item="security"]')).toHaveCount(0);

  // Tapping Guardian edits its instructions; only those are offered.
  await editor.getByRole('button', { name: 'Edit Guardian' }).click();
  await expect(page.getByLabel('Name')).toHaveCount(0);
  await page.getByLabel('Instructions').fill('Check the booking flow end to end.');
  await page.getByTestId('stage-save').click();
  await editor.getByRole('button', { name: 'Edit Guardian' }).click();
  await expect(page.getByLabel('Instructions')).toHaveValue('Check the booking flow end to end.');
  await page.keyboard.press('Escape');

  // Removing review warns that every PR will wait for approval; Deploy waits faded after Merge.
  await editor.getByRole('button', { name: 'Remove Code review' }).click();
  await expect(editor.getByTestId('no-review-warning')).toBeVisible();
  await editor.getByRole('button', { name: 'Remove Deploy' }).click();
  await expect(editor.locator('[data-testid="ghost-item"][data-item="deploying"]')).toHaveCount(1);
  await snap(page, info, 'editor');

  // Save asks first, and demo data cannot be applied; Keep editing goes back to the editor.
  await editor.getByTestId('editor-save').click();
  await expect(page.getByTestId('confirm-dialog')).toContainText('Apply these changes to your dashboard?');
  await expect(page.getByTestId('confirm-yes')).toBeDisabled();
  await page.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
  // Discard asks too, then goes back with nothing changed.
  await editor.getByTestId('editor-discard').click();
  await expect(page.getByTestId('confirm-dialog')).toContainText('Discard your changes?');
  await page.getByTestId('confirm-yes').click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('[data-testid="usage-meter"][data-window="Weekly"]')).toHaveCount(1);
  await expect(page.getByTestId('lane').first().locator('[data-testid="node"]').first()).toHaveAttribute(
    'data-stage',
    'tests',
  );
});

test('with motion on, a drag moves each item once and lands where it is dropped', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await open(page);
  await page.getByRole('link', { name: 'Edit the dashboard' }).click();
  const editor = page.getByTestId('editor');

  /** Drags `from` to the point `to` in small steps, recording each order the row passes through. */
  async function drag(
    row: string,
    from: string,
    to: { x: number; y: number },
    read: () => Promise<string[]>,
  ) {
    const b = (await editor.locator(`${row} > [data-item="${from}"]`).boundingBox())!;
    const start = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    const orders = [(await read()).join(' ')];
    const note = async () => {
      const now = (await read()).join(' ');
      if (now !== orders.at(-1)) orders.push(now);
    };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    for (let i = 1; i <= 20; i++) {
      await page.mouse.move(start.x + ((to.x - start.x) * i) / 20, start.y + ((to.y - start.y) * i) / 20);
      await note();
    }
    // Held near where it was dropped, jiggling a little, while the others are still sliding.
    for (const dx of [4, -4, 4, -4, 0]) {
      await page.mouse.move(to.x + dx, to.y);
      await note();
    }
    await page.mouse.up();
    await page.waitForTimeout(400);
    await note();
    return orders;
  }
  const centre = async (selector: string) => {
    const b = (await editor.locator(selector).boundingBox())!;
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };

  // The top bar: the narrow Claude mark past the wide 5-hour meter's middle.
  const top = () =>
    editor
      .locator('.topbar-items > [data-item]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-item')!));
  const meter = await centre('.topbar-items > [data-item="fiveHour"]');
  expect(await drag('.topbar-items', 'claude', { x: meter.x + 40, y: meter.y }, top)).toEqual([
    'brand claude fiveHour weekly',
    'brand fiveHour claude weekly',
  ]);

  // The lane: QA to the first place, past two checks: two moves, and it lands first.
  const lane = () =>
    editor
      .locator('.lane-flow .lane-step > [data-order]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-item')!));
  const tests = await centre('.lane-step > [data-item="tests"]');
  expect(await drag('.lane-step', 'qa', { x: tests.x - 30, y: tests.y }, lane)).toEqual([
    'tests review qa',
    'tests qa review',
    'qa tests review',
  ]);
  await expect(page.getByTestId('stage-sheet')).toHaveCount(0);

  // On a phone the top bar wraps onto two lines: a drag across the lines lands once, without a loop.
  await page.setViewportSize({ width: 390, height: 800 });
  const weekly = await centre('.topbar-items > [data-item="weekly"]');
  const brand = await centre('.topbar-items > [data-item="brand"]');
  const wrapped = await drag('.topbar-items', 'weekly', { x: brand.x - 10, y: brand.y }, top);
  expect(wrapped.at(-1)).toBe('weekly brand fiveHour claude');
  expect(new Set(wrapped).size).toBe(wrapped.length); // never back to an order it had
  expect(weekly.y).toBeGreaterThan(brand.y); // it did start on the second line
  await expect(editor).toBeVisible();
  // A small drag along the second line, and a slow sweep across it, leave the order alone; dropped on
  // the right half of the first line, it goes last there (third), and never swaps back on the way.
  const second = await centre('.topbar-items > [data-item="claude"]');
  const along = await drag('.topbar-items', 'claude', { x: second.x + 10, y: second.y }, top);
  expect(along).toEqual(['weekly brand fiveHour claude']);
  const wide = await centre('.topbar-items > [data-item="fiveHour"]');
  const across = await drag('.topbar-items', 'claude', { x: wide.x + wide.x / 3, y: wide.y }, top);
  expect(new Set(across).size).toBe(across.length);
  await page.setViewportSize({ width: 1280, height: 800 });

  // Escape mid-drag puts it back.
  const b = (await editor.locator('.lane-step > [data-item="qa"]').boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 120, b.y + b.height / 2, { steps: 10 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.waitForTimeout(400);
  expect(await lane()).toEqual(['qa', 'tests', 'review']);
  await expect(editor.locator('.lifted')).toHaveCount(0);
});

test('a check node offers Skip behind a confirmation pop-up; demo data cannot be changed', async ({
  page,
}) => {
  await open(page);
  const skip = page.getByTestId('skip-check').first();
  await skip.click();
  const dialog = page.getByTestId('skip-dialog');
  await expect(dialog).toContainText(/^Skip .+ for .+#\d+\?/);
  await expect(dialog.getByTestId('skip-confirm')).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(skip).toBeFocused();
});

test('a rigor dial sits above each git session pipeline, and the lane dims what its level does not run', async ({
  page,
}, info) => {
  await open(page);
  const row = (title: string) => page.getByTestId('session-row').filter({ hasText: title });

  const checkout = row('Apple Pay checkout');
  const dial = checkout.getByTestId('rigor-dial');
  await expect(dial).toHaveAttribute('data-rigor', 'thorough');
  await expect(dial.getByRole('radiogroup')).toHaveAccessibleName('Rigor for Apple Pay checkout');
  await expect(dial.getByRole('radio', { name: 'Thorough', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  // The caption, plus (for screen readers; a tooltip on the dial) the demo's read-only note.
  await expect(dial.getByTestId('rigor-caption')).toHaveText(
    'Thorough: every check, QA on every PR, tests for every change Demo data is read-only.',
  );
  await expect(dial.getByRole('radiogroup')).toHaveAttribute('title', 'Demo data is read-only.');
  await expect(checkout.locator('[data-off]')).toHaveCount(0);
  // Demo data: read-only, yet reachable by keyboard; clicks and arrows change nothing.
  for (const radio of await dial.getByRole('radio').all())
    await expect(radio).toHaveAttribute('aria-disabled', 'true');
  // force: Playwright counts aria-disabled as not clickable; the point is that a click does nothing.
  await dial.getByRole('radio', { name: 'Fast', exact: true }).click({ force: true });
  await expect(dial).toHaveAttribute('data-rigor', 'thorough');
  await dial.getByRole('radio', { name: 'Thorough', exact: true }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(dial.getByRole('radio', { name: 'Standard', exact: true })).toBeFocused();
  await expect(dial).toHaveAttribute('data-rigor', 'thorough');

  // Light: QA is off (dimmed, no Skip), tests and review run; two rounds at most.
  const rss = row('RSS feed + dark mode');
  await expect(rss.getByTestId('rigor-dial')).toHaveAttribute('data-rigor', 'light');
  const qa = rss.locator('[data-stage="qa"]');
  await expect(qa).toHaveAttribute('data-off', 'true');
  await expect(qa).toContainText('off');
  await expect(qa.getByTestId('skip-check')).toHaveCount(0);
  expect(Number(await qa.evaluate((el) => getComputedStyle(el).opacity))).toBeLessThan(1);
  await expect(rss.locator('[data-stage="tests"]')).not.toHaveAttribute('data-off', 'true');
  // Light cuts the PR's budget by its own rule: the round shows without a denominator.
  await expect(rss.getByTestId('lane')).toContainText('round 2');
  await expect(rss.getByTestId('lane')).not.toContainText('round 2/');

  // Fast: every check of its open PR off; its merged PR still shows the checks it ran.
  const cdn = row('Image CDN migration');
  await expect(cdn.getByTestId('rigor-dial')).toHaveAttribute('data-rigor', 'fast');
  for (const stage of ['tests', 'review', 'qa'])
    await expect(cdn.locator(`[data-pr-number="41"] [data-stage="${stage}"]`)).toHaveAttribute(
      'data-off',
      'true',
    );
  await expect(cdn.locator('[data-pr-number="44"] [data-off]')).toHaveCount(0);
  // It merged at Fast: no check passed at its merged head, and its lane says so.
  await expect(cdn.locator('[data-pr-number="44"] [data-not-run]')).toHaveCount(3);
  await expect(cdn.locator('[data-pr-number="44"] [data-stage="qa"]')).toContainText('not run');

  // Standard draws the pipeline as it is; a folder project has no PRs and no dial.
  await expect(row('Search relevance').getByTestId('rigor-dial')).toHaveAttribute('data-rigor', 'standard');
  await expect(row('Search relevance').locator('[data-off]')).toHaveCount(0);
  await expect(page.locator('[data-project="resume"]').getByTestId('rigor-dial')).toHaveCount(0);

  // It fits a phone: inside the window, and the page does not scroll sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalScroll(page);
  const box = await dial.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await snap(page, info, 'rigor');

  // The editor's preview draws it, inert.
  await page.goto('/edit');
  await expect(page.getByTestId('rigor-dial').first()).toHaveAttribute('inert', '');
});
