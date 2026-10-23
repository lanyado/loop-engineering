import { execFile } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ServerModule } from '../context.js';

/** A runner tmux target, "<session>:@<window id>". Anything else is refused before it reaches a shell. */
const TARGET = /^([A-Za-z0-9_-]+):(@\d+)$/;

export const DEFAULT_TERMINAL_DIR = join(homedir(), '.local', 'state', 'loop-engineering', 'terminals');

/** Opens a terminal window showing one tmux window. */
export type TerminalOpener = (target: string) => Promise<void>;

/** Opens a terminal window running one shell line; `name` (letters, digits, - and _) names its script. */
export type CommandOpener = (name: string, shellLine: string) => Promise<void>;

/**
 * macOS Terminal running `shellLine`, from a .command file (opening one needs no Automation
 * permission, unlike AppleScript).
 */
export function macCommandOpener(dir = DEFAULT_TERMINAL_DIR): CommandOpener {
  const run = promisify(execFile);
  return async (name, shellLine) => {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`bad terminal script name: ${name}`);
    const file = join(dir, `${name}.command`);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(file, `#!/bin/sh\nexec ${shellLine}\n`);
    await chmod(file, 0o700);
    await run('open', ['-a', 'Terminal', file]);
  };
}

/**
 * macOS Terminal attached to the session's tmux window. It joins the tmux session as a grouped
 * session (destroyed when its window closes), so each viewer picks its own window and never
 * switches another one.
 */
export function macTerminalOpener(open: CommandOpener = macCommandOpener()): TerminalOpener {
  return async (target) => {
    const match = TARGET.exec(target);
    if (!match) throw new Error(`not a tmux window target: ${target}`);
    const [, group, window] = match;
    await open(
      `${group}-${window!.slice(1)}`,
      `tmux new-session -t '${group}' \\; set-option destroy-unattached on \\; select-window -t '${window}'`,
    );
  };
}

export interface TerminalModuleOptions {
  /** Default: macTerminalOpener(). */
  open?: TerminalOpener;
}

/**
 * POST /api/sessions/:id/terminal opens a terminal on this Mac showing the session's agent, for the
 * dashboard's "Terminal" button. Only an active local session with a tmux window has one (409 otherwise).
 */
export function terminalModule(options: TerminalModuleOptions = {}): ServerModule {
  const open = options.open ?? macTerminalOpener();
  return {
    name: 'terminal',
    api(api, ctx) {
      api.post('/sessions/:id/terminal', async (c) => {
        const id = Number(c.req.param('id'));
        const session = Number.isInteger(id) ? ctx.store.sessions.get(id) : null;
        if (!session) return c.json({ error: 'no such session' }, 404);
        const target = session.tmuxTarget;
        if (session.status !== 'active' || !target || !TARGET.test(target)) {
          return c.json({ error: 'this session has no running terminal (it is paused or ended)' }, 409);
        }
        try {
          await open(target);
        } catch (error) {
          return c.json({ error: `could not open a terminal: ${String(error)}` }, 500);
        }
        return c.json({ opened: true });
      });
    },
  };
}
