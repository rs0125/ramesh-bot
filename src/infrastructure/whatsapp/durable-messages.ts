/** Drains separate agent-input and delivery queues while a WhatsApp session is connected. */
import { randomUUID } from 'node:crypto';
import { proto, type WAMessage } from '@whiskeysockets/baileys';
import { authCipher } from '../database/auth-store.js';
import { MessageQueueRepository, type MessageJob } from '../database/message-queue.repository.js';
import { selectGreetingTarget } from '../../modules/greetings/greeting.policy.js';
import type {
  BeforeReply,
  GreetingCandidate,
  PrepareReply,
} from '../../modules/greetings/greeting.types.js';
import type { WhatsAppSession } from './baileys-session.js';
import { toGreetingCandidate } from './message.mapper.js';

export interface DurableMessageOptions {
  encryptionKey: string;
  maxAgeMs: number;
  capacity: number;
  leaseMs: number;
  pollMs: number;
  waitBeforeReply: BeforeReply;
  prepareReply?: PrepareReply;
}

type DurableRepository = Pick<
  MessageQueueRepository,
  | 'enqueue'
  | 'claimInbound'
  | 'handoff'
  | 'claimOutbound'
  | 'releaseUnsent'
  | 'complete'
  | 'beginSend'
>;

export class DurableMessages {
  private readonly cipher;
  private wake?: () => void;
  private revision = 0;
  // Conversation memory is intentionally process-local. Persisted reply text survives restarts.
  private readonly sentCallbacks = new Map<string, { expiresAt: number; run: () => void }>();

  constructor(
    private readonly repository: DurableRepository,
    private readonly options: DurableMessageOptions,
  ) {
    this.cipher = authCipher(options.encryptionKey);
  }

  async enqueue(
    message: WAMessage,
    candidate: GreetingCandidate,
  ): Promise<'queued' | 'duplicate' | 'full' | 'ignored'> {
    if (!selectGreetingTarget(candidate, Date.now(), this.options.maxAgeMs)) return 'ignored';
    const wire = proto.WebMessageInfo.encode(message).finish();
    if (wire.byteLength > 262144) throw new Error('Incoming message exceeds durable payload limit');
    const id = randomUUID();
    const payload = this.cipher.seal('message', id, Buffer.from(wire));
    const result = await this.repository.enqueue(
      id,
      candidate,
      payload,
      this.options.maxAgeMs,
      this.options.capacity,
    );
    if (result === 'queued') {
      this.revision++;
      this.wake?.();
    }
    return result;
  }

  private async idle(
    signal: AbortSignal,
    revision: number,
    ms = this.options.pollMs,
  ): Promise<void> {
    if (signal.aborted || revision !== this.revision) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        if (this.wake === done) this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wake = done;
      signal.addEventListener('abort', done, { once: true });
    });
  }

  async consume(
    session: WhatsAppSession,
    signal: AbortSignal,
    report: (outcome: 'sent' | 'error') => void,
  ): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      const revision = this.revision;
      try {
        for (const [id, callback] of this.sentCallbacks)
          if (callback.expiresAt <= Date.now()) this.sentCallbacks.delete(id);
        // Deliver the previous reply before generating more work, preserving conversation order.
        const job =
          (await this.repository.claimOutbound(this.options.leaseMs)) ??
          (await this.repository.claimInbound(this.options.leaseMs));
        if (job) await this.process(job, session, signal, report);
        else await this.idle(signal, revision);
        failures = 0;
      } catch {
        report('error');
        // Fixed, bounded database polling; this never polls WhatsApp.
        await this.idle(
          signal,
          this.revision,
          Math.min(30000, this.options.pollMs * 2 ** Math.min(++failures, 5)),
        );
      }
    }
  }

  private async process(
    job: MessageJob,
    session: WhatsAppSession,
    signal: AbortSignal,
    report: (outcome: 'sent' | 'error') => void,
  ): Promise<void> {
    let sendInvoked = false;
    try {
      if (signal.aborted) {
        await this.repository.releaseUnsent(job, true);
        return;
      }
      let message: WAMessage;
      try {
        const wire = this.cipher.open('message', job.id, job.payload);
        if (!Buffer.isBuffer(wire)) throw new Error('Invalid queued message');
        message = proto.WebMessageInfo.decode(wire) as WAMessage;
      } catch {
        await this.repository.complete(job, 'FAILED', 'invalid_encrypted_payload');
        this.sentCallbacks.delete(job.id);
        report('error');
        return;
      }
      const candidate = toGreetingCandidate(message, session.botJids);
      const eligible = () =>
        candidate && selectGreetingTarget(candidate, Date.now(), this.options.maxAgeMs);
      if (!candidate || !eligible()) {
        await this.repository.complete(job, 'EXPIRED', 'no_longer_eligible');
        this.sentCallbacks.delete(job.id);
        return;
      }
      if (job.direction === 'inbound') {
        const prepared = this.options.prepareReply
          ? await this.options.prepareReply(candidate, signal)
          : { text: 'hello', onSent: undefined };
        if (signal.aborted) {
          await this.repository.releaseUnsent(job, true);
          return;
        }
        if (!eligible()) {
          await this.repository.complete(job, 'EXPIRED', 'message_too_old');
          return;
        }
        if (!prepared.text.trim() || prepared.text.length > 16000) {
          await this.repository.complete(job, 'FAILED', 'invalid_generated_reply');
          report('error');
          return;
        }
        const payload = this.cipher.seal('outbound-reply', job.id, prepared.text);
        if (await this.repository.handoff(job, payload)) {
          if (prepared.onSent)
            this.sentCallbacks.set(job.id, {
              expiresAt: candidate.sentAtMs + this.options.maxAgeMs,
              run: prepared.onSent,
            });
        } else await this.repository.releaseUnsent(job);
        return;
      }
      let reply: unknown;
      try {
        reply = this.cipher.open('outbound-reply', job.id, job.replyPayload ?? '');
        if (typeof reply !== 'string' || !reply.trim() || reply.length > 16000)
          throw new Error('Invalid saved reply');
      } catch {
        await this.repository.complete(job, 'FAILED', 'invalid_encrypted_reply');
        this.sentCallbacks.delete(job.id);
        report('error');
        return;
      }
      if (!(await this.options.waitBeforeReply(signal)) || signal.aborted) {
        await this.repository.releaseUnsent(job, true);
        return;
      }
      if (!eligible()) {
        await this.repository.complete(job, 'EXPIRED', 'message_too_old');
        this.sentCallbacks.delete(job.id);
        return;
      }
      // Persist the point of no safe automatic retry BEFORE invoking the SDK.
      if (!(await this.repository.beginSend(job))) {
        await this.repository.releaseUnsent(job);
        return;
      }
      if (signal.aborted) {
        await this.repository.releaseUnsent(job, true);
        return;
      }
      sendInvoked = true;
      await session.reply(message, reply);
      this.sentCallbacks.get(job.id)?.run();
      this.sentCallbacks.delete(job.id);
      if (await this.repository.complete(job, 'SENT')) report('sent');
      else report('error');
    } catch {
      // After the callback is invoked, a network/DB error cannot prove non-delivery.
      // If even this write fails, SENDING is recovered as UNCERTAIN when its lease expires.
      try {
        if (sendInvoked) {
          this.sentCallbacks.delete(job.id);
          await this.repository.complete(job, 'UNCERTAIN', 'send_or_status_failed');
        } else await this.repository.releaseUnsent(job, signal.aborted);
      } catch {
        /* Durable lease recovery owns work whose final write could not complete. */
      }
      report('error');
    }
  }
}
