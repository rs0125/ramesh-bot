/** Best-effort transport acknowledgements, independent of read receipts and answer generation. */
import type { WAMessage } from '@whiskeysockets/baileys';

type SendReceipt = (
  jid: string,
  participant: string | undefined,
  ids: string[],
  type: undefined,
) => Promise<void>;

export class DeliveryReceipts {
  private readonly pending = new Set<Promise<void>>();
  private closed = false;

  constructor(
    private readonly send: SendReceipt,
    private readonly onFailure: () => void,
    private readonly maxPending = 100,
    private readonly timeoutMs = 5000,
  ) {}

  acknowledge(message: Pick<WAMessage, 'key'>): void {
    const { remoteJid, participant, id, fromMe } = message.key;
    if (this.closed || fromMe || !remoteJid || !id) return;
    if (this.pending.size >= this.maxPending) {
      this.onFailure();
      return;
    }
    let reported = false;
    const failed = () => {
      if (!reported) this.onFailure();
      reported = true;
    };
    const timer = setTimeout(failed, this.timeoutMs);
    timer.unref();
    // A timed-out socket write retains its slot until settlement. Repeated timeouts
    // cannot create an unbounded number of promises, or delay admitting a voice burst.
    const work = Promise.resolve()
      .then(() => this.send(remoteJid, participant ?? undefined, [id], undefined))
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
