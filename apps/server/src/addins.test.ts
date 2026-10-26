import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAddins } from './addins.js';
import { ConfigError } from './config.js';

let dir: string;
const made: string[] = [];
const fresh = () => {
  dir = mkdtempSync(join(tmpdir(), 'addins-'));
  made.push(dir);
};
beforeEach(fresh);
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

const entry = (code: string) => {
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'index.js'), code);
};

describe('local add-ins', () => {
  it('are none without a built local/ folder', async () => {
    expect(await loadAddins(join(dir, 'missing'), {})).toEqual([]);
    expect(await loadAddins(dir, {})).toEqual([]);
  });

  it("are the modules local/dist/index.js returns, given the server's environment", async () => {
    entry('export const serverModules = (env) => [{ name: "mine:" + env.MINE }];');
    expect(await loadAddins(dir, { MINE: 'on' })).toEqual([{ name: 'mine:on' }]);
  });

  it('refuse an entry without serverModules, and pass on its own errors', async () => {
    entry('export const other = 1;');
    await expect(loadAddins(dir, {})).rejects.toThrow(ConfigError);
    // A fresh folder: Node caches a module by its path.
    fresh();
    entry(
      'export function serverModules() { const e = new Error("MINE_TOKEN is not set"); e.name = "MineConfigError"; throw e; }',
    );
    await expect(loadAddins(dir, {})).rejects.toThrow(/MINE_TOKEN is not set/);
  });
});
