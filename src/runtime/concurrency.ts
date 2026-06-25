export class AsyncLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.active++;
        void Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            this.active--;
            this.drain();
          });
      };

      if (this.active < this.limit) {
        start();
      } else {
        this.queue.push(start);
      }
    });
  }

  private drain(): void {
    const next = this.queue.shift();
    if (next && this.active < this.limit) {
      next();
    }
  }
}

export class SingleFlight {
  private readonly pending = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const existing = this.pending.get(key) as Promise<T> | undefined;
    if (existing) return existing;

    const promise = task().finally(() => {
      this.pending.delete(key);
    });
    this.pending.set(key, promise);
    return promise;
  }
}
