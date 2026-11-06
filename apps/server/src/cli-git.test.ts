import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cliGit } from './cli-git.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('cliGit', () => {
  it("runs git with the git environment and SAFE_GIT, never the server's secrets", () => {
    const dir = mkdtempSync(join(tmpdir(), 'loop-cli-git-'));
    dirs.push(dir);
    const dump = join(dir, 'dump.txt');
    const fake = join(dir, 'git');
    writeFileSync(fake, `#!/bin/sh\n{ echo "ARGS $*"; /usr/bin/env; } > '${dump}'\necho ' out '\n`, {
      mode: 0o755,
    });
    const source = {
      PATH: process.env.PATH,
      HOME: '/srv/someone',
      DASHBOARD_TOKEN: 'leak-dashboard',
      MCP_TOKEN: 'leak-mcp',
      EMAIL_APP_PASSWORD: 'leak-email',
    };
    expect(cliGit(['rev-parse', '--show-toplevel'], dir, source, fake)).toBe('out');
    const seen = readFileSync(dump, 'utf8');
    expect(seen).toMatch(
      /^ARGS -c core\.hooksPath=\/dev\/null -c core\.fsmonitor=false .* rev-parse --show-toplevel$/m,
    );
    expect(seen).not.toContain('leak-');
    expect(seen).toContain('GIT_TERMINAL_PROMPT=0');
    expect(cliGit(['x'], dir, source, join(dir, 'missing'))).toBeNull();
  });
});
