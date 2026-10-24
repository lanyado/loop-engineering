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
  // The Telegram allowlist is managed outside the dashboard now; the sheet has no editor for it.
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

test('the pencil edits a draft on the demo board; Discard changes nothing, and demo data cannot be approved', async ({
  page,
}, info) => {
  // Still items: the wiggle is off with reduced motion, so clicks land without waiting for it.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page);
  await page.getByRole('link', { name: 'Edit the dashboard' }).click();
  const editor = page.getByTestId('editor');
  await expect(editor).toBeVisible();
  // Every demo project, as a preview nothing on it can be clicked.
  await expect(editor.getByTestId('project')).toHaveCount(await page.getByTestId('project').count());

  // Top bar: the weekly limit goes, and "+ Add" offers it back.
  await editor.getByRole('button', { name: 'Remove Weekly limit' }).click();
  await expect(editor.locator('[data-testid="usage-meter"][data-window="Weekly"]')).toHaveCount(0);

  // Pipeline: Code review moves before Tests on the strip and on every lane of the preview.
  await editor.getByRole('button', { name: 'Move Code review left' }).click();
  const strip = editor.getByRole('region', { name: 'Pipeline' }).getByTestId('editable-item');
  await expect(strip.first()).toHaveAttribute('data-item', 'review');
  const lane = editor.getByTestId('lane').first().locator('[data-testid="node"]');
  await expect(lane.first()).toHaveAttribute('data-stage', 'review');

  // A new stage: its node shows up in the preview's lanes.
  await editor.getByTestId('editor-add').click();
  await editor.getByTestId('new-stage').click();
  await page.getByLabel('Name').fill('Docs check');
  await page.getByLabel('Label on the node (10 characters at most)').fill('Docs');
  await page.getByTestId('stage-prompt').fill('Check the README covers the change.');
  await page.getByTestId('stage-save').click();
  await expect(editor.getByTestId('lane').first().locator('[data-stage="docs-check"]')).toContainText('Docs');

  // A custom stage that is not in the pipeline can be edited and deleted from "+ Add"; Escape closes sheets.
  await editor.getByTestId('editor-add').click();
  await page.getByRole('button', { name: 'Edit Security review' }).click();
  await page.getByTestId('stage-delete').click();
  await editor.getByTestId('editor-add').click();
  await expect(page.getByRole('button', { name: 'Edit Security review' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('add-sheet')).toHaveCount(0);
  await expect(editor.getByTestId('editor-add')).toBeFocused(); // focus back where it was

  // Removing review warns that every PR will wait for approval.
  await editor.getByRole('button', { name: 'Remove Code review' }).click();
  await expect(editor.getByTestId('no-review-warning')).toBeVisible();
  await snap(page, info, 'editor');

  // ✕: demo data cannot be approved; Discard goes back with nothing changed.
  await editor.getByTestId('editor-close').click();
  await expect(page.getByTestId('editor-approve')).toBeDisabled();
  await page.getByTestId('editor-discard').click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('[data-testid="usage-meter"][data-window="Weekly"]')).toHaveCount(1);
  await expect(page.getByTestId('lane').first().locator('[data-testid="node"]').first()).toHaveAttribute(
    'data-stage',
    'tests',
  );
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
