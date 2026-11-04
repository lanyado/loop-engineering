import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** scripts/heavy of this checkout, from packages/loop/src and packages/loop/dist alike. */
export const HEAVY_SCRIPT = fileURLToPath(new URL('../../../scripts/heavy', import.meta.url));

/** The machine-wide limit on heavy runs, which builders share through scripts/heavy. */
export interface HeavySlots {
  /** Resolves with the release once a slot is free; rejects with the signal's reason when aborted first. */
  acquire(signal: AbortSignal): Promise<() => void>;
}

/** Holds the slot until its stdin closes, so a crashed server can't keep one. */
const HOLD = 'echo ready; cat >/dev/null';

export class ScriptHeavySlots implements HeavySlots {
  constructor(private readonly script = HEAVY_SCRIPT) {}

  acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      // Inherited, a job's own LOOP_HEAVY_HELD would skip the wait.
      const env = { ...process.env };
      delete env.LOOP_HEAVY_HELD;
      const child = spawn(this.script, ['sh', '-c', HOLD], { stdio: ['pipe', 'pipe', 'ignore'], env });
      const onAbort = () => {
        child.kill();
        reject(signal.reason as Error);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      const settled = (release: () => void) => {
        signal.removeEventListener('abort', onAbort);
        resolve(release);
      };
      child.stdin.on('error', () => undefined);
      child.stdout.once('data', () => settled(() => child.stdin.end()));
      // A limit that can't run must never stop the jobs: they go ahead without a slot.
      child.once('error', () => settled(() => undefined));
      child.once('exit', () => settled(() => undefined));
    });
  }
}
