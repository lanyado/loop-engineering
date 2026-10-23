/** Counting semaphore: at most `size` holders; waiters are served in order. */
export class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(readonly size: number) {
    if (!Number.isInteger(size) || size < 1) throw new Error('semaphore size must be a positive integer');
  }

  get running(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiting.length;
  }

  async acquire(): Promise<() => void> {
    if (this.active >= this.size) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // The slot passes straight to the next waiter, if any.
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    };
  }
}
