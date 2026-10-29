import { describe, expect, it } from 'vitest';
import { ttydArgs, WebTerminals, type TtydLauncher, type WebTerminalSpec } from './web-terminals.js';

function fake() {
  const started: { spec: WebTerminalSpec; port: number; basePath: string }[] = [];
  const stopped: string[] = [];
  const exits = new Map<string, () => void>();
  const launch: TtydLauncher = (spec, port, basePath) => {
    started.push({ spec, port, basePath });
    let exit!: () => void;
    const exited = new Promise<void>((r) => (exit = r));
    exits.set(spec.key, exit);
    return Promise.resolve({ stop: () => void stopped.push(spec.key), exited });
  };
  let next = 7700;
  return { started, stopped, exits, terminals: new WebTerminals(launch, () => Promise.resolve(next++)) };
}

const spec = (key: string, argv = ['node', 'x']): WebTerminalSpec => ({ key, argv, writable: false });
const URL_RE = /^http:\/\/localhost:(\d+)\/([0-9a-f]{48})\/$/;

describe('WebTerminals', () => {
  it('starts one ttyd per key under a secret path and reuses it, even for simultaneous asks', async () => {
    const { started, terminals } = fake();
    const urls = await Promise.all([terminals.url(spec('a')), terminals.url(spec('a'))]);
    expect(urls[0]).toBe(urls[1]);
    const [, port, token] = URL_RE.exec(urls[0])!;
    expect(port).toBe('7700');
    expect(started[0]!.basePath).toBe(`/${token}`);
    const b = URL_RE.exec(await terminals.url(spec('b')))!;
    expect(b[1]).toBe('7701');
    expect(b[2]).not.toBe(token); // every terminal has its own secret
    expect(started).toHaveLength(2);
  });

  it('starts a fresh ttyd when the last one exited, and stops all on stopAll', async () => {
    const { started, stopped, exits, terminals } = fake();
    await terminals.url(spec('a'));
    exits.get('a')!();
    await new Promise((r) => setTimeout(r, 0));
    expect(URL_RE.exec(await terminals.url(spec('a')))![1]).toBe('7701');
    await terminals.url(spec('b'));
    terminals.stopAll();
    expect(stopped.sort()).toEqual(['a', 'b']);
    expect(started).toHaveLength(3);
  });

  it('replaces a terminal whose command changed, stopping the old one', async () => {
    const { started, stopped, terminals } = fake();
    const first = await terminals.url(spec('a', ['tmux', '@5']));
    const second = await terminals.url(spec('a', ['tmux', '@9']));
    expect(second).not.toBe(first);
    expect(stopped).toEqual(['a']);
    expect(started.map((s) => s.spec.argv[1])).toEqual(['@5', '@9']);
    expect(await terminals.url(spec('a', ['tmux', '@9']))).toBe(second);
  });

  it('stops one key, and starts nothing after stopAll', async () => {
    const { stopped, terminals } = fake();
    await terminals.url(spec('a'));
    terminals.stop('a');
    expect(stopped).toEqual(['a']);
    terminals.stopAll();
    await expect(terminals.url(spec('late'))).rejects.toThrow('stopping');
    expect(stopped).toEqual(['a']);
  });
});

describe('WebTerminals overlap', () => {
  it('stops a ttyd whose start was overtaken by another command or by stop()', async () => {
    const stopped: string[] = [];
    const release: (() => void)[] = [];
    const launch: TtydLauncher = (spec) =>
      new Promise((resolve) =>
        release.push(() =>
          resolve({
            stop: () => void stopped.push(String(spec.argv[0])),
            exited: new Promise<void>(() => {}),
          }),
        ),
      );
    const t = new WebTerminals(launch, () => Promise.resolve(7800));
    const first = t.url(spec('a', ['one']));
    const second = t.url(spec('a', ['two'])); // asked again while the first ttyd is still starting
    await new Promise((r) => setTimeout(r, 0));
    release.forEach((r) => r());
    await expect(first).rejects.toThrow('replaced');
    expect(await second).toMatch(/^http:\/\/localhost:7800\//);
    expect(stopped).toEqual(['one']);
    const third = t.url(spec('b'));
    await new Promise((r) => setTimeout(r, 0));
    t.stop('b');
    release.forEach((r) => r());
    await expect(third).rejects.toThrow();
    expect(stopped).toEqual(['one', 'node']);
  });

  it('starts nothing once stopped', async () => {
    const { started, terminals } = fake();
    terminals.stopAll();
    await expect(terminals.url(spec('a'))).rejects.toThrow('stopping');
    expect(started).toHaveLength(0);
  });
});

describe('ttydArgs', () => {
  const base = { key: 'k', argv: ['tmux', 'attach'] };
  it('binds loopback, checks the origin and serves under the secret path', () => {
    const args = ttydArgs({ ...base, writable: false }, 7700, '/abc', 'darwin');
    expect(args.slice(0, 2)).toEqual(['-i', 'lo0']);
    expect(args).toContain('-O');
    expect(args[args.indexOf('-b') + 1]).toBe('/abc');
    expect(args[args.indexOf('-p') + 1]).toBe('7700');
    expect(args).not.toContain('-W');
    expect(args.slice(-2)).toEqual(['tmux', 'attach']);
    expect(ttydArgs({ ...base, writable: false }, 1, '/x', 'linux')[1]).toBe('lo');
  });
  it('allows typing only for a writable terminal', () => {
    expect(ttydArgs({ ...base, writable: true }, 7700, '/abc')).toContain('-W');
  });
});
