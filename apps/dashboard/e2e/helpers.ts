import { expect, type Page, type TestInfo } from '@playwright/test';
import { E2E } from './env';

/** Opens the board of a DASHBOARD_AUTH=none dashboard (the loopback default): no login step. */
export async function open(page: Page, path = '/') {
  await page.goto(path);
  await expect(page.getByTestId('project').first()).toBeVisible();
}

/** A project's section on the board, and its settings panel opened. */
export async function projectSettings(page: Page, project: string) {
  const section = page.locator(`[data-testid="project"][data-project="${project}"]`);
  await section.getByTestId('project-settings-toggle').click();
  return section.getByTestId('project-settings');
}

/** The top bar's settings sheet (every project), opened. */
export async function globalSettings(page: Page) {
  const sheet = page.getByTestId('settings-sheet');
  await sheet.locator('summary').click();
  return sheet;
}

/** Opens a page of a DASHBOARD_AUTH=password dashboard: redirected to /login, then back. */
export async function login(page: Page, path = '/') {
  await page.goto(path);
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('Password').fill(E2E.password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByTestId('project').first()).toBeVisible();
}

/** Nothing wider than the window: the page itself never scrolls sideways. */
export async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

/** Saves a full-page screenshot under test-results/screenshots, named by project and view. */
export async function snap(page: Page, info: TestInfo, name: string) {
  await page.screenshot({
    path: `test-results/screenshots/${info.project.name}-${name}.png`,
    fullPage: true,
  });
}

/** Calls the real server's API with the dashboard token, as the dashboard's server does. */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${E2E.serverUrl}/api${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${E2E.dashboardToken}`, 'Content-Type': 'application/json' },
  });
  return (await res.json()) as T;
}

export async function testRoute<T>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(`${E2E.serverUrl}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${E2E.mcpToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return (await res.json()) as T;
}
