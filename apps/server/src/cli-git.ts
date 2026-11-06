import { execFileSync } from 'node:child_process';
import { gitEnvironment, SAFE_GIT } from '@loop-engineering/runner';

/**
 * git for the command-line tools (`add-project`, `loop init`), in a repo the user names: stdout
 * trimmed, or null when it fails. They run after loadRootEnv(), so process.env holds the server's
 * secrets; git gets only the git environment (gitEnvironment) and SAFE_GIT, with a time limit.
 */
export function cliGit(
  args: string[],
  cwd: string | undefined,
  source: Record<string, string | undefined> = process.env,
  bin = 'git',
): string | null {
  try {
    return execFileSync(bin, [...SAFE_GIT, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: gitEnvironment(source),
      timeout: 30_000,
    }).trim();
  } catch {
    return null;
  }
}
