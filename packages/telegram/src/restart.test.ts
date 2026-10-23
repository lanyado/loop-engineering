import { describe, expect, it } from 'vitest';
import { runWithRestarts } from './restart.js';

const fatal = new Error('401 Unauthorized');

function setup() {
  const waits: number[] = [];
  const logs: string[] = [];
  const controller = new AbortController();
  const options = {
    signal: controller.signal,
    isFatal: (e: unknown) => e === fatal,
    log: (m: string) => logs.push(m),
    minDelayMs: 1000,
    maxDelayMs: 4000,
    sleep: (ms: number) => {
      waits.push(ms);
      return Promise.resolve();
    },
  };
  return { waits, logs, controller, options };
}

describe('runWithRestarts', () => {
  it('retries a failing start with capped exponential backoff, then runs', async () => {
    const t = setup();
    let attempts = 0;
    await runWithRestarts((started) => {
      attempts++;
      if (attempts <= 4) return Promise.reject(new Error('offline'));
      started();
      return Promise.resolve(); // polling stopped on purpose
    }, t.options);
    expect(attempts).toBe(5);
    expect(t.waits).toEqual([1000, 2000, 4000, 4000]);
    expect(t.logs[0]).toBe('[telegram] long polling failed, retrying in 1 s: Error: offline');
  });

  it('resets the backoff once an attempt has started', async () => {
    const t = setup();
    let attempts = 0;
    await runWithRestarts((started) => {
      attempts++;
      if (attempts === 1 || attempts === 2) return Promise.reject(new Error('down'));
      if (attempts === 3) {
        started();
        return Promise.reject(new Error('409 Conflict')); // ran, then died
      }
      return Promise.resolve();
    }, t.options);
    expect(t.waits).toEqual([1000, 2000, 1000]);
  });

  it('gives up on a fatal error and stops when aborted', async () => {
    const t = setup();
    let attempts = 0;
    await runWithRestarts(() => {
      attempts++;
      return Promise.reject(fatal);
    }, t.options);
    expect(attempts).toBe(1);
    expect(t.logs).toEqual(['[telegram] long polling stopped for good: Error: 401 Unauthorized']);

    const aborted = setup();
    aborted.controller.abort();
    let ran = false;
    await runWithRestarts(() => {
      ran = true;
      return Promise.resolve();
    }, aborted.options);
    expect(ran).toBe(false);
  });
});
