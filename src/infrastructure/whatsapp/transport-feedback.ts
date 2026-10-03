/** Bounded, best-effort socket feedback. It never gates durable processing or closes a socket. */
export class TransportFeedback {
  private readonly pending = new Set<Promise<void>>();
  private closed = false;

  constructor(
    private readonly onFailure: () => void,
    private readonly maxPending = 100,
    private readonly timeoutMs = 5000,
  ) {}

  submit(send: () => Promise<unknown>): void {
    if (this.closed) return;
    let reported = false;
    const failed = () => {
      if (reported) return;
      reported = true;
      try {
        this.onFailure();
      } catch {
        /* Feedback and diagnostics cannot interrupt the user's request. */
      }
    };
    if (this.pending.size >= this.maxPending) {
      failed();
      return;
    }
    const timer = setTimeout(failed, this.timeoutMs);
    timer.unref();
    // Keep timed-out writes counted until they settle, so a stalled socket cannot
    // accumulate unlimited promises. Feedback never resets or retries a business action.
    const work = Promise.resolve()
      .then(send)
      .then(() => undefined)
      .catch(failed)
      .finally(() => {
        clearTimeout(timer);
        this.pending.delete(work);
      });
    this.pending.add(work);
  }

  async close(): Promise<void> {
    this.closed = true;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...this.pending]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
