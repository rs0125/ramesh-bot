/** Bounded FIFO work queue: admission is synchronous, and drain observes admitted work. */
export class SerialQueue {
  private tail = Promise.resolve();
  private pending = 0;
  constructor(private readonly capacity: number) {}

  get size(): number {
    return this.pending;
  }

  push(work: () => Promise<void>, onError: (error: unknown) => void): boolean {
    if (this.pending >= this.capacity) return false;
    this.pending++;
    this.tail = this.tail
      .then(work)
      .catch(onError)
      .finally(() => {
        this.pending--;
      });
    return true;
  }

  drain(): Promise<void> {
    return this.tail;
  }
}
