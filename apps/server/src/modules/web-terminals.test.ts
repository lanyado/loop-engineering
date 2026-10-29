import { describe, expect, it } from 'vitest';
import { WebTerminals, type TtydLauncher, type WebTerminalSpec } from './web-terminals.js';

function fake() {
  const started: [WebTerminalSpec, number][] = [];
  const stopped: string[] = [];
  const exits = new Map<string, () => void>();
  const launch: TtydLauncher = (spec, port) => {
    started.push([spec, port]);
    let exit!: () => void;
    const exited = new Promise<void>((r) => (exit = r));
    exits.set(spec.key, exit);
    return Promise.resolve({ stop: () => void stopped.push(spec.key), exited });
  };
  let next = 7700;
  return { started, stopped, exits, terminals: new WebTerminals(launch, () => Promise.resolve(next++)) };
}

const spec = (key: string): WebTerminalSpec => ({ key, argv: ['node', 'x'], writable: false });

describe('WebTerminals', () => {
  it('starts one ttyd per key and reuses it, even for simultaneous asks', async () => {
    const { started, terminals } = fake();
    const urls = await Promise.all([terminals.url(spec('a')), terminals.url(spec('a'))]);
    expect(urls).toEqual(['http://localhost:7700', 'http://localhost:7700']);
    expect(await terminals.url(spec('b'))).toBe('http://localhost:7701');
    expect(started).toHaveLength(2);
  });

  it('starts a fresh ttyd when the last one exited, and stops all on stopAll', async () => {
    const { started, stopped, exits, terminals } = fake();
    await terminals.url(spec('a'));
    exits.get('a')!();
    await new Promise((r) => setTimeout(r, 0));
    expect(await terminals.url(spec('a'))).toBe('http://localhost:7701');
    await terminals.url(spec('b'));
    terminals.stopAll();
    expect(stopped.sort()).toEqual(['a', 'b']);
    expect(started).toHaveLength(3);
  });
});
