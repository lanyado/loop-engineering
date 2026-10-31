import { FakeClock, openStore, type Project, type Store } from '@loop-engineering/core';
import { DefaultAgentCli } from '../agent-cli.js';
import { FakeGitDriver, FakeTmuxDriver, MemoryFs, type FakeWindow } from '../fakes.js';
import { SessionRunner, type RunnerConfig } from '../runner.js';

export interface Harness {
  store: Store;
  fs: MemoryFs;
  git: FakeGitDriver;
  tmux: FakeTmuxDriver;
  runner: SessionRunner;
  shop: Project;
  logs: string[];
  /** The launch script a fake window runs. */
  script(window: FakeWindow): string;
  window(target: string | null): FakeWindow;
  json(path: string): Record<string, unknown>;
  /** OPENCODE_CONFIG_CONTENT exported by a launch script, parsed. */
  inlineOpencode(window: FakeWindow): Record<string, unknown>;
  /** Pretends Claude saved conversation `id`. */
  saveConversation(id: string | null): Promise<void>;
}

export function harness(config: Partial<RunnerConfig> = {}): Harness {
  const store = openStore({ clock: new FakeClock('2026-10-18T09:00:00.000Z') });
  const fs = new MemoryFs({ '/secrets/web.env': 'API_KEY=secret\n' });
  const git = new FakeGitDriver(fs);
  const tmux = new FakeTmuxDriver();
  const logs: string[] = [];
  let n = 0;
  const runner = new SessionRunner(
    {
      store,
      fs,
      git,
      tmux,
      agentCli: new DefaultAgentCli(),
      ids: {
        uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
        suffix: () => `sfx${++n}`,
      },
      log: (m) => logs.push(m),
      sleep: () => Promise.resolve(),
    },
    {
      worktreesRoot: '/wt',
      serverUrl: 'http://srv:8787/',
      claudeProjectsDir: '/claude/projects',
      env: { MCP_TOKEN: 'tok-123', TAVILY_API_KEY: 'tv-1', UNRELATED: 'x' },
      ...config,
    },
  );
  const shop = store.projects.create({
    name: 'Shop',
    repos: [{ name: 'web', path: '/src/web', remote: 'git@github.com:me/web.git', defaultBranch: 'main' }],
    envFiles: [{ repo: 'web', source: '/secrets/web.env', target: '.env.local' }],
  });
  const window = (target: string | null): FakeWindow => {
    const w = target ? tmux.windows.get(target) : undefined;
    if (!w) throw new Error(`no window ${String(target)}`);
    return w;
  };
  const script = (w: FakeWindow): string => {
    const match = /^sh '(.+)'$/.exec(w.command);
    if (!match?.[1]) throw new Error(`unexpected command ${w.command}`);
    return fs.read(match[1]);
  };
  const json = (path: string) => JSON.parse(fs.read(path)) as Record<string, unknown>;
  const inlineOpencode = (w: FakeWindow) => {
    const match = /^export OPENCODE_CONFIG_CONTENT='(.*)'$/m.exec(script(w));
    if (!match?.[1]) throw new Error('no OPENCODE_CONFIG_CONTENT');
    return JSON.parse(match[1]) as Record<string, unknown>;
  };
  const saveConversation = (id: string | null) =>
    fs.writeFile(`/claude/projects/-wt-shop-x/${String(id)}.jsonl`, '{}\n');
  return { store, fs, git, tmux, runner, shop, logs, script, window, json, inlineOpencode, saveConversation };
}
