import { plainPane } from '../input-box.js';
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
  /** Presses Esc: the one key that cancels a dialog without choosing any of its options. */
  pressEscape(target: string): Promise<void>;
  /** The last `lines` lines of the pane, wrapped lines joined, as plainPane reads them: no styles, no suggestion in the box. */
  capture(target: string, lines?: number): Promise<string>;
  /** Kills the window. A window that is already gone is not an error. */
  kill(target: string): Promise<void>;
  /** Windows of `session`; empty when the session or the tmux server does not exist. */
  list(session: string): Promise<TmuxWindow[]>;
  /** The running tmux server; null when none runs. */
  server(): Promise<TmuxServer | null>;
  /**
   * Keeps the window, with a dead pane, when its process exits (remain-on-exit), so an agent that
   * exited can be told from a window closed from outside. newWindow does this for its windows.
   */
  keepDeadPane(target: string): Promise<void>;
}

export interface TmuxServer {
  pid: number;
  /** Epoch ms, as tmux reports it (whole seconds). */
  startedAt: number;
}

const TARGET_FORMAT = '#{session_name}:#{window_id}';
const ENTER_GAP_MS = 300;

/**
 * Set on every agent window. The runner identifies windows by name too, so the agent (terminal
 * title escapes) must not rename it; remain-on-exit keeps the window, with a dead pane, when the
 * agent exits, so an agent that exited can be told from a window closed from outside.
 */
const WINDOW_OPTIONS: readonly (readonly [string, string])[] = [
  ['allow-rename', 'off'],
  ['automatic-rename', 'off'],
  ['remain-on-exit', 'on'],
];

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
    // tmux turns "." and ":" in a session name into "_", so "=<name>" would never find the session.
    if (/[.:]/.test(spec.session))
      throw new Error(
        `tmux session name "${spec.session}" has "." or ":", which tmux replaces: use another name`,
      );
    const common = ['-d', '-n', spec.name, '-c', spec.cwd, '-P', '-F', TARGET_FORMAT, spec.command];
    // The window's options are set in the same tmux command, which the server runs before anything
    // else: set by a later call, an agent that exits at once would take its window with it
    // (remain-on-exit not on yet). With -d the new window is not the current one, so the options
    // name it as the session's last window, where new-window -a puts it.
    const last = `=${spec.session}:{end}`;
    const options = WINDOW_OPTIONS.flatMap(([name, value]) => [
      ';',
      'set-option',
      '-w',
      '-t',
      last,
      name,
      value,
    ]);
    if (!(await this.hasSession(spec.session))) {
      try {
        return await this.create(['new-session', '-s', spec.session, ...common, ...options]);
      } catch (err) {
        // Another start created the session between the check and here; fall through to new-window.
        if (!(err instanceof ExecError && /duplicate session/i.test(err.stderr))) throw err;
      }
    }
    return await this.create(['new-window', '-a', '-t', last, ...common, ...options]);
  }

  /**
   * Runs a new-session/new-window command list. When a command after the window's creation fails,
   * the window already runs its command and printed its target: it is killed before the error is
   * thrown, so a launch the caller counts as failed never leaves an agent running.
   */
  private async create(args: string[]): Promise<string> {
    try {
      return (await this.tmux(args)).trim();
    } catch (err) {
      const made = err instanceof ExecError ? /^\S+:@\d+$/m.exec(err.stdout)?.[0] : undefined;
      if (made) await this.kill(made).catch(() => undefined);
      throw err;
    }
  }

  async keepDeadPane(target: string): Promise<void> {
    await this.tmux(['set-option', '-w', '-t', target, 'remain-on-exit', 'on']);
  }

  async pressEscape(target: string): Promise<void> {
    await this.tmux(['send-keys', '-t', target, 'Escape']);
  }

  async sendKeys(target: string, text: string, options: { enter?: boolean } = {}): Promise<void> {
    if (text !== '') await this.tmux(['send-keys', '-t', target, '-l', text]);
    if (!(options.enter ?? true)) return;
    // An Enter right behind the text reaches a TUI in the same read and can count as part of a paste
    // (a newline, not a submit); a short gap makes it a key press of its own.
    if (text !== '') await new Promise((done) => setTimeout(done, ENTER_GAP_MS));
    await this.tmux(['send-keys', '-t', target, 'Enter']);
  }

  async capture(target: string, lines = 50): Promise<string> {
    return plainPane(await this.tmux(['capture-pane', '-p', '-e', '-J', '-t', target, '-S', `-${lines}`]));
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

  async server(): Promise<TmuxServer | null> {
    let out: string;
    try {
      out = await this.tmux(['display-message', '-p', '#{pid} #{start_time}']);
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
    const [pid, start] = out.trim().split(' ').map(Number);
    return pid && pid > 0 && start ? { pid, startedAt: start * 1000 } : null;
  }
}
