import { spawn, type ChildProcess } from 'node:child_process';
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

/** ttyd on the loopback interface only (lo0 on macOS, lo elsewhere); nothing outside this machine can reach it. */
export const ttydLauncher: TtydLauncher = async (spec, port) => {
  const args = [
    '-i',
    platform() === 'darwin' ? 'lo0' : 'lo',
    '-p',
    String(port),
    '-t',
    'fontSize=13',
    '-t',
    'fontFamily=ui-monospace, SFMono-Regular, Menlo, monospace',
    '-t',
    `theme=${THEME}`,
    ...(spec.writable ? ['-W'] : []),
    ...spec.argv,
  ];
  const child: ChildProcess = spawn('ttyd', args, { stdio: 'ignore' });
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
  private readonly running = new Map<string, { port: number; stop(): void }>();
  private readonly starting = new Map<string, Promise<number>>();

  constructor(
    private readonly launch: TtydLauncher = ttydLauncher,
    private readonly pickPort: () => Promise<number> = freePort,
  ) {}

  /** The URL of the terminal for `spec`, starting it if it is not running. */
  async url(spec: WebTerminalSpec): Promise<string> {
    const live = this.running.get(spec.key);
    if (live) return `http://localhost:${live.port}`;
    let pending = this.starting.get(spec.key);
    if (!pending) {
      pending = this.start(spec).finally(() => this.starting.delete(spec.key));
      this.starting.set(spec.key, pending);
    }
    return `http://localhost:${await pending}`;
  }

  private async start(spec: WebTerminalSpec): Promise<number> {
    const port = await this.pickPort();
    const terminal = await this.launch(spec, port);
    this.running.set(spec.key, { port, stop: () => terminal.stop() });
    void terminal.exited.then(() => this.running.delete(spec.key));
    return port;
  }

  stopAll(): void {
    for (const t of this.running.values()) t.stop();
    this.running.clear();
  }
}
