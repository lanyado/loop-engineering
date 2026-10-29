// Regenerates the README's animated screenshots from the dashboard's demo data.
// Needs: @playwright/test (a dashboard dev dependency, hoisted to the root), a built dashboard served in demo mode (SERVER_URL empty) and ffmpeg.
//   cd apps/dashboard && SERVER_URL= npx next start -p 3191
//   node scripts/capture-readme-media.mjs [http://localhost:3191]
import { chromium } from '@playwright/test';
import { URL, fileURLToPath } from 'node:url';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:3191';
const out = fileURLToPath(new URL('../docs/media/', import.meta.url));
const tmp = fileURLToPath(new URL('../.media-tmp/', import.meta.url));
mkdirSync(out, { recursive: true });
rmSync(tmp, { recursive: true, force: true });

const size = { width: 1200, height: 640 };
const browser = await chromium.launch();

async function clip(name, script) {
  const dir = `${tmp}${name}/`;
  const ctx = await browser.newContext({
    viewport: size,
    colorScheme: 'dark',
    recordVideo: { dir, size },
  });
  const page = await ctx.newPage();
  await page.goto(base);
  await page.waitForTimeout(1200);
  await script(page);
  await ctx.close();
  const webm = dir + readdirSync(dir)[0];
  renameSync(webm, `${dir}clip.webm`);
  // Two-pass palette keeps the GIF small and crisp.
  const vf = 'fps=10,scale=880:-1:flags=lanczos';
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-ss',
    '1',
    '-i',
    `${dir}clip.webm`,
    '-filter_complex',
    `[0:v]${vf},split[a][b];[a]palettegen=max_colors=64[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`,
    `${out}${name}.gif`,
  ]);
}

await clip('pipeline', async (page) => {
  await page.mouse.move(600, 330);
  for (const level of ['fast', 'light', 'thorough', 'standard']) {
    await page.getByTestId(`rigor-${level}`).first().hover();
    await page.waitForTimeout(700);
  }
  await page.mouse.wheel(0, 380);
  await page.waitForTimeout(1200);
  await page.mouse.wheel(0, -380);
  await page.waitForTimeout(800);
});

await clip('questions', async (page) => {
  await page.mouse.wheel(0, 420);
  await page.waitForTimeout(900);
  await page.getByText('Context').first().click();
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'Merge', exact: true }).first().hover();
  await page.waitForTimeout(1000);
  await page.getByRole('button', { name: /Hold/ }).first().hover();
  await page.waitForTimeout(1200);
});

await clip('editor', async (page) => {
  await page.getByRole('link', { name: 'Edit the dashboard' }).click();
  await page.waitForTimeout(1500);
  // The remove buttons wiggle in edit mode, so Playwright never sees them as stable.
  await page.getByRole('button', { name: 'Remove Weekly limit' }).click({ force: true });
  await page.waitForTimeout(1000);
  await page.getByRole('button', { name: 'Add Weekly limit' }).click({ force: true });
  await page.waitForTimeout(1200);
});

await browser.close();
rmSync(tmp, { recursive: true, force: true });
