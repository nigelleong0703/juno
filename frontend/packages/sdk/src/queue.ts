/**
 * A single-consumer queue the event stream pushes into and a turn pulls from. Items already queued are
 * delivered before a failure, so nothing received before `fail` is lost.
 */
export class AsyncQueue<T> {
  private readonly items: T[] = [];
  private waiter: { resolve: (item: T) => void; reject: (error: unknown) => void } | null = null;
  private failure: { error: unknown } | null = null;

  push(item: T): void {
    if (this.failure !== null) return;
    if (this.waiter !== null) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.resolve(item);
      return;
    }
    this.items.push(item);
  }

  fail(error: unknown): void {
    if (this.failure !== null) return;
    this.failure = { error };
    if (this.waiter !== null) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.reject(error);
    }
  }

  next(): Promise<T> {
    const queued = this.items.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.failure !== null) return Promise.reject(this.failure.error);
    return new Promise<T>((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }
}
