import { describe, expect, it } from 'vitest';
import { runsOn } from './changes.js';
import type { StageRuns } from './stages.js';

const diff = (...files: string[]) => files.map((f) => `diff --git a/${f} b/${f}\n+x\n`).join('');

/** Each kind with files it counts and files it does not. */
const CASES: [StageRuns, string[], string[]][] = [
  ['always', ['README.md'], []],
  [
    'code-changes',
    [
      'src/a.ts',
      'package.json',
      'tests/a.test.ts',
      'requirements.txt',
      'CMakeLists.txt',
      'docs/src/Hero.tsx',
    ],
    ['README.md', 'docs/guide.mdx'],
  ],
  [
    'ui-changes',
    ['apps/dashboard/src/components/pipeline.tsx', 'styles.css', 'he/index.html', 'games/coin-run/world.js'],
    [
      'packages/loop/src/engine.ts',
      'apps/dashboard/src/lib/board.test.ts',
      'tests/e2e/home.spec.ts',
      'scripts/build.mjs',
      'README.md',
    ],
  ],
  [
    'server-changes',
    ['packages/loop/src/engine.ts', 'api/app.py', 'cmd/main.go'],
    ['src/App.tsx', 'src/a.test.ts', 'README.md', 'package.json', 'vite.config.ts', 'pkg/server_test.go'],
  ],
  [
    'test-changes',
    [
      'src/a.test.ts',
      'e2e/home.spec.ts',
      'tests/test_api.py',
      'pkg/server_test.go',
      'app/models/user_spec.rb',
      'api/test_views.py',
    ],
    ['src/a.ts', 'api/views.py'],
  ],
  [
    'docs-changes',
    ['README.md', 'docs/guide.rst', 'CHANGELOG.mdx'],
    ['src/a.ts', 'docs/src/Hero.tsx', 'notes.txt'],
  ],
  [
    'dependency-changes',
    ['package.json', 'apps/web/package-lock.json', 'requirements-dev.txt', 'go.sum', 'Cargo.lock'],
    ['src/package.ts', 'docs/requirements.md'],
  ],
  [
    'database-changes',
    ['db/migrations/0001_init.sql', 'prisma/schema.prisma', 'queries/report.sql'],
    ['src/db.ts'],
  ],
  [
    'infra-changes',
    ['.github/workflows/ci.yml', 'Dockerfile', 'deploy/fly.toml', 'main.tf', 'vercel.json'],
    ['src/deploy.ts'],
  ],
];

describe('runsOn', () => {
  it.each(CASES)('%s', (runs, yes, no) => {
    for (const f of yes) expect([f, runsOn(runs, diff(f))]).toEqual([f, true]);
    for (const f of no) expect([f, runsOn(runs, diff(f))]).toEqual([f, false]);
  });

  it('reads paths with spaces', () => {
    expect(runsOn('docs-changes', diff('docs/Getting started.md'))).toBe(true);
    expect(runsOn('ui-changes', diff('docs/Getting started.md'))).toBe(false);
  });

  it('a check that runs only on some changes does not run on an empty diff', () => {
    expect(runsOn('ui-changes', '')).toBe(false);
    expect(runsOn('always', '')).toBe(true);
  });
});
