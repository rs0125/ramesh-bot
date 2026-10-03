/** Best-effort delivery and explicitly requested read receipts, independent of answer generation. */
import type { WAMessage } from '@whiskeysockets/baileys';
import { TransportFeedback } from './transport-feedback.js';

type SendReceipt = (
  jid: string,
  participant: string | undefined,
  ids: string[],
  type: undefined | 'read',
) => Promise<void>;

export class DeliveryReceipts {
  private readonly feedback: TransportFeedback;

  constructor(
    private readonly send: SendReceipt,
    onFailure: () => void,
    maxPending = 100,
    timeoutMs = 5000,
  ) {
    this.feedback = new TransportFeedback(onFailure, maxPending, timeoutMs);
  }

  acknowledge(message: Pick<WAMessage, 'key'>): void {
    this.submit(message, undefined);
  }

  markRead(message: Pick<WAMessage, 'key'>): void {
    this.submit(message, 'read');
  }

  private submit(message: Pick<WAMessage, 'key'>, type: undefined | 'read'): void {
    const { remoteJid, participant, id, fromMe } = message.key;
    if (fromMe || !remoteJid || !id) return;
    this.feedback.submit(() => this.send(remoteJid, participant ?? undefined, [id], type));
  }

  async close(): Promise<void> {
    await this.feedback.close();
  }
}
