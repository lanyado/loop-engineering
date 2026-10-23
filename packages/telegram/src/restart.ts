import { setTimeout as delay } from 'node:timers/promises';

export interface RestartOptions {
  /** Aborting stops the loop (including a wait between attempts). */
  signal: AbortSignal;
  /** Errors that retrying cannot fix, e.g. a revoked token (401). The loop gives up on them. */
  isFatal: (error: unknown) => boolean;
  log: (message: string) => void;
  /** First wait after a failure; doubles up to maxDelayMs. Reset once an attempt starts. */
  minDelayMs?: number;
  maxDelayMs?: number;
  /** Injected in tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  delay(ms, undefined, { signal, ref: false }).catch(() => undefined);

/**
 * Keeps a long-running task (long polling) alive: `run` gets a `started` callback and resolves
 * when the task ends on purpose. If it rejects, the error is logged and `run` is retried after a
 * capped exponential backoff, until `signal` aborts or the error is fatal.
 */
export async function runWithRestarts(
  run: (started: () => void) => Promise<void>,
  options: RestartOptions,
): Promise<void> {
  const min = options.minDelayMs ?? 5_000;
  const max = options.maxDelayMs ?? 5 * 60_000;
  const sleep = options.sleep ?? defaultSleep;
  let wait = min;
  while (!options.signal.aborted) {
    try {
      await run(() => {
        wait = min;
      });
      return;
    } catch (error) {
      if (options.signal.aborted) return;
      if (options.isFatal(error)) {
        options.log(`[telegram] long polling stopped for good: ${String(error)}`);
        return;
      }
      options.log(
        `[telegram] long polling failed, retrying in ${Math.round(wait / 1000)} s: ${String(error)}`,
      );
      await sleep(wait, options.signal);
      wait = Math.min(max, wait * 2);
    }
  }
}
