import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createConnection, createServer } from 'node:net';
import { platform } from 'node:os';

/** What to show in a web terminal: the argv ttyd runs, and whether the viewer may type into it. */
export interface WebTerminalSpec {
  /** Names the terminal; asking again for the same key reuses the running ttyd. */
  key: string;
  argv: string[];
  writable: boolean;
}

/** Starts one ttyd serving `spec` on a loopback port; resolves once it accepts connections. */
export type TtydLauncher = (
  spec: WebTerminalSpec,
  port: number,
  /** The secret path the page is served under, e.g. "/3f9a…". */
  basePath: string,
) => Promise<{ stop(): void; exited: Promise<void> }>;

const THEME = JSON.stringify({
  background: '#0b0d12',
  foreground: '#d7dce5',
  cursor: '#7aa2ff',
  selectionBackground: '#2a3550',
});

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

const accepts = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('error', () => resolve(false));
  });

/**
 * ttyd's arguments. Loopback only; -O refuses a WebSocket from another origin, and the unguessable base
 * path keeps a web page (or a port scan, or DNS rebinding) from finding the terminal at all: ttyd has
 * no login of its own here.
 */
export function ttydArgs(
  spec: WebTerminalSpec,
  port: number,
  basePath: string,
  os: NodeJS.Platform = platform(),
): string[] {
  return [
    '-i',
    os === 'darwin' ? 'lo0' : 'lo',
    '-p',
    String(port),
    '-b',
    basePath,
    '-O',
    '-t',
    'fontSize=13',
    '-t',
    'fontFamily=ui-monospace, SFMono-Regular, Menlo, monospace',
    '-t',
    `theme=${THEME}`,
    ...(spec.writable ? ['-W'] : []),
    ...spec.argv,
  ];
}

export const ttydLauncher: TtydLauncher = async (spec, port, basePath) => {
  const child: ChildProcess = spawn('ttyd', ttydArgs(spec, port, basePath), { stdio: 'ignore' });
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
  });
  let dead = false;
  void exited.then(() => (dead = true));
  for (let i = 0; i < 50 && !dead; i++) {
    if (await accepts(port)) return { stop: () => void child.kill(), exited };
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error('ttyd did not start (is it installed? brew install ttyd)');
};

/**
 * The ttyd processes behind the dashboard's embedded terminals, one per key, started on first use and
 * stopped with the server. The browser reaches them at http://localhost:<port> (same machine only).
 */
export class WebTerminals {
  private readonly running = new Map<string, { url: string; sig: string; stop(): void }>();
  private readonly starting = new Map<string, { sig: string; url: Promise<string> }>();
  private stopped = false;

  constructor(
    private readonly launch: TtydLauncher = ttydLauncher,
    private readonly pickPort: () => Promise<number> = freePort,
  ) {}

  /**
   * The URL of the terminal for `spec`, starting it if it is not running. A running one whose command
   * differs (the agent moved to another tmux window) is stopped and replaced.
   */
  async url(spec: WebTerminalSpec): Promise<string> {
    const sig = JSON.stringify([spec.argv, spec.writable]);
    const live = this.running.get(spec.key);
    if (live?.sig === sig) return live.url;
    if (live) this.stop(spec.key);
    let pending = this.starting.get(spec.key);
    if (pending?.sig !== sig) {
      const url = this.start(spec, sig);
      pending = { sig, url };
      this.starting.set(spec.key, pending);
      const mine = pending;
      const clear = () => {
        if (this.starting.get(spec.key) === mine) this.starting.delete(spec.key);
      };
      url.then(clear, clear);
    }
    return pending.url;
  }

  private async start(spec: WebTerminalSpec, sig: string): Promise<string> {
    const port = await this.pickPort();
    const token = randomBytes(24).toString('hex');
    const terminal = await this.launch(spec, port, `/${token}`);
    if (this.stopped) {
      terminal.stop();
      throw new Error('the server is stopping');
    }
    const entry = { url: `http://localhost:${port}/${token}/`, sig, stop: () => terminal.stop() };
    this.running.set(spec.key, entry);
    void terminal.exited.then(() => {
      if (this.running.get(spec.key) === entry) this.running.delete(spec.key);
    });
    return entry.url;
  }

  /** Stops the terminal of one key (a session that ended), if it is running. */
  stop(key: string): void {
    this.running.get(key)?.stop();
    this.running.delete(key);
  }

  stopAll(): void {
    this.stopped = true;
    for (const t of this.running.values()) t.stop();
    this.running.clear();
  }
}
