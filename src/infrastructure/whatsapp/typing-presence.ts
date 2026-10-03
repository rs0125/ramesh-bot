/** Per-chat, coalesced presence. Presence failure never delays a response or opens another socket. */
type Presence = 'composing' | 'paused';
interface ChatPresence {
  users: Set<symbol>;
  desired: Presence;
  sent?: Presence;
  pending?: Promise<void>;
  refresh?: NodeJS.Timeout;
}

export class TypingPresence {
  private readonly chats = new Map<string, ChatPresence>();
  private readonly stops = new Set<() => void>();
  private closed = false;

  constructor(
    private readonly send: (chatId: string, presence: Presence) => Promise<unknown>,
    private readonly onFailure: () => void,
    private readonly refreshMs = 8000,
    private readonly maxDurationMs = 300000,
    private readonly maxChats = 16,
  ) {}

  start(chatId: string, signal: AbortSignal): () => void {
    if (
      this.closed ||
      signal.aborted ||
      !chatId ||
      (this.chats.size >= this.maxChats && !this.chats.has(chatId))
    )
      return () => {};
    const entry: ChatPresence = this.chats.get(chatId) ?? {
      users: new Set<symbol>(),
      desired: 'paused',
    };
    this.chats.set(chatId, entry);
    const owner = Symbol();
    entry.users.add(owner);
    entry.desired = 'composing';
    this.flush(chatId, entry);
    if (!entry.refresh) {
      entry.refresh = setInterval(() => {
        if (entry.users.size && !entry.pending) {
          entry.sent = undefined;
          this.flush(chatId, entry);
        }
      }, this.refreshMs);
      entry.refresh.unref();
    }
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      this.stops.delete(stop);
      clearTimeout(deadline);
      signal.removeEventListener('abort', stop);
      entry.users.delete(owner);
      if (!entry.users.size) {
        clearInterval(entry.refresh);
        entry.refresh = undefined;
        entry.desired = 'paused';
        this.flush(chatId, entry);
      }
    };
    const deadline = setTimeout(stop, this.maxDurationMs);
    deadline.unref();
    signal.addEventListener('abort', stop, { once: true });
    this.stops.add(stop);
    return stop;
  }

  private flush(chatId: string, entry: ChatPresence): void {
    if (entry.pending || entry.sent === entry.desired) return;
    const presence = entry.desired;
    entry.pending = Promise.resolve()
      .then(() => this.send(chatId, presence))
      .then(() => undefined)
      .catch(() => {
        try {
          this.onFailure();
        } catch {
          /* Diagnostics are optional too. */
        }
      })
      .finally(() => {
        entry.pending = undefined;
        entry.sent = presence;
        if (entry.desired !== presence) this.flush(chatId, entry);
        else if (!entry.users.size) this.chats.delete(chatId);
      });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const stop of this.stops) stop();
    for (const [chatId, entry] of this.chats) {
      entry.users.clear();
      clearInterval(entry.refresh);
      entry.desired = 'paused';
      this.flush(chatId, entry);
    }
    // A stalled write keeps its single slot until socket shutdown; WhatsApp presence also expires.
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.allSettled(
          [...this.chats.values()].map(async (entry) => {
            while (entry.pending) await entry.pending;
          }),
        ),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 1000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
