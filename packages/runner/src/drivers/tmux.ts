import { exec, ExecError } from './exec.js';

export interface NewWindow {
  /** tmux session to put the window in; created if it does not exist. */
  session: string;
  name: string;
  cwd: string;
  /** Shell command the window runs; the window closes when it exits. */
  command: string;
}

export interface TmuxWindow {
  /** Stable target, "session:@windowId". */
  target: string;
  name: string;
  /** The pane's process exited but the window stayed (remain-on-exit). */
  dead: boolean;
}

export interface TmuxDriver {
  /** Opens a detached window (creating the tmux session first if needed) and returns its target. */
  newWindow(spec: NewWindow): Promise<string>;
  /** Types `text` literally, then presses Enter unless `enter` is false. */
  sendKeys(target: string, text: string, options?: { enter?: boolean }): Promise<void>;
  /** The last `lines` lines of the pane, wrapped lines joined. */
  capture(target: string, lines?: number): Promise<string>;
  /** Kills the window. A window that is already gone is not an error. */
  kill(target: string): Promise<void>;
  /** Windows of `session`; empty when the session or the tmux server does not exist. */
  list(session: string): Promise<TmuxWindow[]>;
}

const TARGET_FORMAT = '#{session_name}:#{window_id}';

/** True for tmux errors that only mean "nothing there": no server, session or window. */
function isMissing(err: unknown): boolean {
  return (
    err instanceof ExecError &&
    /no server running|can't find|error connecting|no such file|session not found|window not found/i.test(
      err.stderr,
    )
  );
}

export interface RealTmuxOptions {
  /** Dedicated server socket (`tmux -L <name>`), e.g. "loop-test" in tests. Default: tmux's default server. */
  socketName?: string;
  bin?: string;
}

export class RealTmuxDriver implements TmuxDriver {
  private readonly bin: string;
  private readonly base: string[];

  constructor(options: RealTmuxOptions = {}) {
    this.bin = options.bin ?? 'tmux';
    this.base = options.socketName ? ['-L', options.socketName] : [];
  }

  private async tmux(args: string[]): Promise<string> {
    return (await exec(this.bin, [...this.base, ...args])).stdout;
  }

  private async hasSession(session: string): Promise<boolean> {
    try {
      await this.tmux(['has-session', '-t', `=${session}`]);
      return true;
    } catch (err) {
      if (isMissing(err)) return false;
      throw err;
    }
  }

  async newWindow(spec: NewWindow): Promise<string> {
    const target = await this.createWindow(spec);
    // The runner identifies windows by name too; keep the agent (terminal title escapes) from renaming it.
    await this.tmux(['set-option', '-w', '-t', target, 'allow-rename', 'off']).catch(() => undefined);
    await this.tmux(['set-option', '-w', '-t', target, 'automatic-rename', 'off']).catch(() => undefined);
    return target;
  }

  private async createWindow(spec: NewWindow): Promise<string> {
    const common = ['-d', '-n', spec.name, '-c', spec.cwd, '-P', '-F', TARGET_FORMAT, spec.command];
    if (!(await this.hasSession(spec.session))) {
      try {
        return (await this.tmux(['new-session', '-s', spec.session, ...common])).trim();
      } catch (err) {
        // Another start created the session between the check and here; fall through to new-window.
        if (!(err instanceof ExecError && /duplicate session/i.test(err.stderr))) throw err;
      }
    }
    return (await this.tmux(['new-window', '-t', `=${spec.session}:`, ...common])).trim();
  }

  async sendKeys(target: string, text: string, options: { enter?: boolean } = {}): Promise<void> {
    if (text !== '') await this.tmux(['send-keys', '-t', target, '-l', text]);
    if (options.enter ?? true) await this.tmux(['send-keys', '-t', target, 'Enter']);
  }

  async capture(target: string, lines = 50): Promise<string> {
    return this.tmux(['capture-pane', '-p', '-J', '-t', target, '-S', `-${lines}`]);
  }

  async kill(target: string): Promise<void> {
    try {
      await this.tmux(['kill-window', '-t', target]);
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
  }

  async list(session: string): Promise<TmuxWindow[]> {
    let out: string;
    try {
      out = await this.tmux([
        'list-windows',
        '-t',
        `=${session}`,
        '-F',
        `${TARGET_FORMAT}\t#{window_name}\t#{pane_dead}`,
      ]);
    } catch (err) {
      if (isMissing(err)) return [];
      throw err;
    }
    return out
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => {
        const [target = '', name = '', dead = '0'] = l.split('\t');
        return { target, name, dead: dead === '1' };
      });
  }
}
