import { describe, expect, it } from 'vitest';
import { Semaphore } from './semaphore.js';

describe('Semaphore', () => {
  it('admits at most size holders and serves waiters in order', async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];
    const first = await sem.acquire();
    const second = sem.acquire().then((release) => {
      order.push(2);
      release();
    });
    const third = sem.acquire().then((release) => {
      order.push(3);
      release();
    });
    expect(sem.queued).toBe(2);
    first();
    first(); // releasing twice is a no-op
    await Promise.all([second, third]);
    expect(order).toEqual([2, 3]);
    expect(sem.running).toBe(0);
  });
});
