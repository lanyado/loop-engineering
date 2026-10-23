import { expect, test } from '@playwright/test';
import { E2E } from './env';
import { globalSettings, login } from './helpers';

// DASHBOARD_AUTH=password (demo data): the login path behaves exactly as before.

test('needs the password', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByText('Demo data: no server is connected.')).toBeVisible();
  await page.getByLabel('Password').fill('not-the-password');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.locator('main [role=alert]')).toHaveText('Wrong password.');
  expect((await page.context().cookies()).some((c) => c.name === 'loop_session')).toBe(false);

  const events = await page.request.get('/api/events');
  expect(events.status()).toBe(401);
  const rsc = await page.request.get('/', { headers: { RSC: '1' }, maxRedirects: 0 });
  expect(rsc.status()).toBe(307);
  expect(await rsc.text()).not.toContain('Apple Pay checkout');
});

test('logs in with an httpOnly cookie and returns to the board', async ({ page }) => {
  await login(page, '/');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('project').first()).toBeVisible();
  const cookie = (await page.context().cookies()).find((c) => c.name === 'loop_session');
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax' });
  // Tokens never reach the browser.
  const html = await page.content();
  expect(html).not.toContain('DASHBOARD_TOKEN=');
  expect(html).not.toContain(E2E.password);
  expect(await page.evaluate(() => document.cookie)).not.toContain('loop_session');

  await (await globalSettings(page)).getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login/);
});
