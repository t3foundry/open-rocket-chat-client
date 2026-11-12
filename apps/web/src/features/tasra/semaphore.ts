/**
 * A simple counting semaphore for limiting concurrent async operations.
 *
 * Used to cap the number of parallel Tasra decryption requests so the gateway
 * is never flooded by a room load that unpacks a hundred messages at once.
 */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.available = permits;
  }

  /** Acquires a permit, waiting if none is available. */
  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /** Releases a permit, waking one waiter if any. */
  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.available++;
    }
  }

  /**
   * Runs `fn` once a permit is available, releasing it when done (or on error).
   * The returned promise settles with `fn`'s result.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}