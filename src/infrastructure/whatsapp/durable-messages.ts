/** Drains separate agent-input and delivery queues while a WhatsApp session is connected. */
import { createHash, randomUUID } from 'node:crypto';
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
import { combinedTurn } from '../../modules/messaging/debounce.js';
import { MediaService, mediaOwner } from '../../modules/media/media.service.js';
import { toInboxCandidate } from './message.mapper.js';
import { encodeReply, decodeReply } from '../../modules/messaging/reply-payload.js';
import { renderVoiceReply, type VoiceReplyReference } from '../../modules/media/voice-reply.js';
import { currentUsageScope, withUsageScope } from '../../modules/usage/usage-scope.js';
import { cancellable } from '../../lib/cancellable.js';

export interface DurableMessageOptions {
  encryptionKey: string;
  maxAgeMs: number;
  capacity: number;
  leaseMs: number;
  pollMs: number;
  waitBeforeReply: BeforeReply;
  prepareReply?: PrepareReply;
  agentRuns?: boolean;
  media?: MediaService;
  accountId?: string;
  usageMode?: 'off' | 'observe' | 'enforce';
  onUsageAttributionFailure?: (
    reason: 'USAGE_IDENTITY_UNAVAILABLE' | 'USAGE_RUN_ATTRIBUTION_UNAVAILABLE',
  ) => void;
  usageEmployee?: (
    key: { remoteJid?: string | null; participant?: string | null; fromMe?: boolean | null },
    signal: AbortSignal,
  ) => Promise<number | undefined>;
  businessPreflight?: (
    message: Pick<WAMessage, 'key'>,
    evidence: unknown,
    signal: AbortSignal,
  ) => Promise<boolean>;
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
> &
  Partial<
    Pick<
      MessageQueueRepository,
      | 'enqueueAdmin'
      | 'beginAgentRun'
      | 'recordAgentEvent'
      | 'nextInboundDelay'
      | 'replaceWithDeliveryNotice'
      | 'usageRunId'
    >
  >;

export class DurableMessages {
  private readonly cipher;
  private wake?: () => void;
  private revision = 0;
  private readonly ingesting = new Map<string, Promise<string | undefined>>();
  private activeDownloads = 0;
  private readonly downloadWaiters = new Set<() => void>();
  private readonly stoppingDownloads = new AbortController();
  // Conversation memory is intentionally process-local. Persisted reply text survives restarts.
  private readonly sentCallbacks = new Map<string, { expiresAt: number; run: () => void }>();

  constructor(
    private readonly repository: DurableRepository,
    private readonly options: DurableMessageOptions,
  ) {
    this.cipher = authCipher(options.encryptionKey);
    this.stoppingDownloads.signal.addEventListener(
      'abort',
      () => {
        for (const wake of this.downloadWaiters) wake();
      },
      { once: true },
    );
  }

  private get usageEnabled() {
    return this.options.usageMode === 'observe' || this.options.usageMode === 'enforce';
  }

  /** Stop queue admission synchronously before waiting for the WhatsApp consumer to drain. */
  stopMediaIngress(): void {
    this.stoppingDownloads.abort();
  }

  async drainMediaIngress(): Promise<void> {
    await Promise.allSettled(this.ingesting.values());
  }

  private async downloadSlot(): Promise<() => void> {
    const signal = this.stoppingDownloads.signal;
    while (this.activeDownloads >= 3) {
      signal.throwIfAborted();
      await new Promise<void>((resolve) => {
        const ready = () => {
          this.downloadWaiters.delete(ready);
          resolve();
        };
        this.downloadWaiters.add(ready);
      });
    }
    signal.throwIfAborted();
    this.activeDownloads++;
    return () => {
      this.activeDownloads--;
      this.downloadWaiters.values().next().value?.();
    };
  }

  private usageFailure(reason: 'USAGE_IDENTITY_UNAVAILABLE' | 'USAGE_RUN_ATTRIBUTION_UNAVAILABLE') {
    // Log only a fixed event. Observer failures must not turn attribution into an access grant.
    try {
      this.options.onUsageAttributionFailure?.(reason);
    } catch {
      /* Best-effort diagnostics. */
    }
    if (this.options.usageMode === 'enforce') throw new Error(reason);
  }

  private async usageSubject(
    key: WAMessage['key'],
    candidate: GreetingCandidate,
    signal: AbortSignal,
  ): Promise<string> {
    const fallback = `sender:${createHash('sha256')
      .update(candidate.senderId ?? candidate.chatId)
      .digest('hex')}`;
    if (!this.usageEnabled) return fallback;
    try {
      if (!this.options.usageEmployee) throw new Error('USAGE_IDENTITY_RESOLVER_REQUIRED');
      const attributionSignal = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
      const employee = await cancellable(
        () => this.options.usageEmployee!(key, attributionSignal),
        attributionSignal,
      );
      if (employee === undefined) return fallback; // An actual unknown user still gets ordinary chat.
      if (!Number.isSafeInteger(employee) || employee <= 0)
        throw new Error('INVALID_USAGE_EMPLOYEE');
      return `employee:${employee}`;
    } catch {
      signal.throwIfAborted();
      this.usageFailure('USAGE_IDENTITY_UNAVAILABLE');
      return fallback;
    }
  }

  async enqueue(
    message: WAMessage,
    candidate: GreetingCandidate,
    session?: WhatsAppSession,
  ): Promise<'queued' | 'duplicate' | 'full' | 'ignored' | 'observed'> {
    if (candidate.fromMe || !Number.isFinite(candidate.sentAtMs) || candidate.sentAtMs <= 0)
      return 'ignored';
    // Admission/archival is independent of automatic reply eligibility.
    const replyEligible =
      (!candidate.isGroup || !!candidate.senderId) &&
      !!selectGreetingTarget(candidate, Date.now(), this.options.maxAgeMs) &&
      (!!toGreetingCandidate(message, []) ||
        (!!this.options.media && ['audio', 'image', 'document'].includes(candidate.kind ?? '')));
    const wire = proto.WebMessageInfo.encode(message).finish();
    if (wire.byteLength > 262144) throw new Error('Incoming message exceeds durable payload limit');
    const id = randomUUID();
    const receivedAt = new Date();
    const payload = this.cipher.seal('message', id, Buffer.from(wire));
    const result = await this.repository.enqueue(
      id,
      candidate,
      payload,
      this.options.maxAgeMs,
      this.options.capacity,
      {
        replyEligible,
        content: this.cipher.seal('inbox', id, {
          text: candidate.text ?? '',
          senderId: candidate.senderId ?? null,
          senderName: candidate.senderName || candidate.senderId?.split('@')[0] || 'Unknown sender',
          chatName: candidate.chatName ?? null,
          kind: candidate.kind ?? 'text',
        }),
      },
    );
    if (result === 'queued' && session && this.options.media)
      void this.ingest(message, candidate, session, receivedAt).catch(() => {});
    if (result === 'queued') {
      this.revision++;
      this.wake?.();
    }
    return result;
  }

  private async ingest(
    message: WAMessage,
    candidate: GreetingCandidate,
    session: WhatsAppSession,
    receivedAt?: Date,
    admittedRunId?: string,
  ): Promise<string | undefined> {
    if (
      !this.options.media ||
      !session.downloadMedia ||
      !['audio', 'image', 'document'].includes(candidate.kind ?? '')
    )
      return;
    const key = JSON.stringify([candidate.chatId, candidate.senderId, candidate.messageId]);
    const existing = this.ingesting.get(key);
    if (existing) return existing;
    const owner = mediaOwner(
      this.options.accountId ?? 'primary',
      candidate.chatId,
      candidate.senderId ?? candidate.chatId,
    );
    const work = (async () => {
      const store = this.options.media!.store;
      const findStored = () =>
        store.findSource
          ? store.findSource(owner, candidate.messageId)
          : store
              .get(owner)
              .then((rows) => rows.find((row) => row.source === candidate.messageId)?.id);
      const stored = await findStored();
      if (stored) return stored;
      const release = await this.downloadSlot();
      try {
        // Another ingress path may have persisted this source while this one waited.
        const duplicate = await findStored();
        if (duplicate) return duplicate;
        const signal = AbortSignal.any([this.stoppingDownloads.signal, AbortSignal.timeout(35000)]);
        signal.throwIfAborted();
        const upload = await session.downloadMedia!(message, signal);
        signal.throwIfAborted();
        if (!this.usageEnabled)
          return await this.options.media!.ingest(owner, candidate.messageId, upload, receivedAt);
        const upstream = currentUsageScope()?.scope;
        let runId = admittedRunId;
        if (!runId) {
          try {
            if (!this.repository.usageRunId) throw new Error('USAGE_MESSAGE_RESOLVER_REQUIRED');
            runId = await this.repository.usageRunId(candidate.chatId, candidate.messageId);
          } catch {
            this.usageFailure('USAGE_RUN_ATTRIBUTION_UNAVAILABLE');
            runId = createHash('sha256').update(key).digest('hex');
          }
        }
        const subjectId =
          (upstream?.runId === runId ? upstream.subjectId : undefined) ??
          (await this.usageSubject(message.key, candidate, signal));
        signal.throwIfAborted();
        return await withUsageScope({ runId, subjectId }, () =>
          this.options.media!.ingest(owner, candidate.messageId, upload, receivedAt),
        );
      } finally {
        // Hold the slot through durable persistence so decoded buffers cannot queue behind SQL.
        release();
      }
    })().finally(() => this.ingesting.delete(key));
    this.ingesting.set(key, work);
    return work;
  }

  async sendAsAdmin(id: string, chatId: string, text: string) {
    if (!this.repository.enqueueAdmin) throw new Error('Inbox storage unavailable');
    const result = await this.repository.enqueueAdmin(
      id,
      chatId,
      this.cipher.seal('inbox', id, {
        text,
        senderId: null,
        senderName: 'Ramesh',
        chatName: null,
        kind: 'text',
      }),
      this.cipher.seal('outbound-reply', id, text),
      this.options.capacity,
      createHash('sha256')
        .update(JSON.stringify([chatId, text]))
        .digest('hex'),
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
        else
          await this.idle(
            signal,
            revision,
            (await this.repository.nextInboundDelay?.(this.options.pollMs)) ?? this.options.pollMs,
          );
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
    return withUsageScope({ runId: job.id }, () =>
      this.processScoped(job, session, signal, report),
    );
  }

  private async processScoped(
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
      let message: WAMessage | undefined;
      const manual = job.origin === 'admin';
      try {
        if (!manual) {
          const wire = this.cipher.open('message', job.id, job.payload);
          if (!Buffer.isBuffer(wire)) throw new Error('Invalid queued message');
          message = proto.WebMessageInfo.decode(wire) as WAMessage;
        }
      } catch {
        await this.repository.complete(job, 'FAILED', 'invalid_encrypted_payload');
        this.sentCallbacks.delete(job.id);
        report('error');
        return;
      }
      let candidate = message ? toInboxCandidate(message, session.botJids) : null;
      const eligible = () =>
        manual || (candidate && selectGreetingTarget(candidate, Date.now(), this.options.maxAgeMs));
      if (!eligible()) {
        await this.repository.complete(job, 'EXPIRED', 'no_longer_eligible');
        this.sentCallbacks.delete(job.id);
        return;
      }
      if (job.direction === 'inbound') {
        if (!candidate || !message) throw new Error('Missing inbound message');
        if (this.usageEnabled) {
          // Covers fresh and restarted/pending media before any extractor or model can run.
          const scope = currentUsageScope()?.scope;
          if (!scope) throw new Error('USAGE_RUN_SCOPE_REQUIRED');
          scope.subjectId = await this.usageSubject(message.key, candidate, signal);
        }
        if (
          this.options.agentRuns &&
          (!this.repository.beginAgentRun ||
            !this.repository.recordAgentEvent ||
            !(await this.repository.beginAgentRun(job)))
        )
          throw new Error('Agent run could not be claimed');
        const originals = [{ id: job.id, message, candidate, receivedAt: job.receivedAt }];
        for (const member of job.members ?? []) {
          const wire = this.cipher.open('message', member.id, member.payload);
          if (!Buffer.isBuffer(wire)) throw new Error('INVALID_BATCH_PAYLOAD');
          const item = proto.WebMessageInfo.decode(wire) as WAMessage;
          const mapped = toInboxCandidate(item, session.botJids);
          if (
            !mapped ||
            mapped.chatId !== candidate.chatId ||
            mapped.senderId !== candidate.senderId
          )
            throw new Error('INVALID_BATCH_OWNER');
          originals.push({
            id: member.id,
            message: item,
            candidate: mapped,
            receivedAt: member.receivedAt,
          });
        }
        // Promise completion order must never become voice-note/conversation order.
        const attachments = await Promise.all(
          originals.map(async (item, index) => {
            try {
              const id = await this.ingest(
                item.message,
                item.candidate,
                session,
                item.receivedAt,
                job.id,
              );
              return { id };
            } catch {
              return { failure: `An attachment in message ${index + 1} could not be read.` };
            }
          }),
        );
        const mediaIds = attachments.flatMap((item) => (item.id ? [item.id] : []));
        const failures = attachments.flatMap((item) => (item.failure ? [item.failure] : []));
        if (originals.length > 1 || candidate.forwarded)
          candidate = {
            ...candidate,
            text: combinedTurn(
              originals.map((i, index) => ({
                id: i.id,
                text: i.candidate.text ?? '',
                forwarded: i.candidate.forwarded,
                mediaIds: attachments[index]?.id ? [attachments[index]!.id!] : [],
              })),
            ),
            batchMessageIds: originals.map((i) => i.candidate.messageId),
          };
        const mediaContext =
          (this.options.media
            ? await this.options.media.context(
                mediaOwner(
                  this.options.accountId ?? 'primary',
                  candidate.chatId,
                  candidate.senderId ?? candidate.chatId,
                ),
                mediaIds,
                candidate.text ?? '',
                signal,
              )
            : '') + (failures.length ? `\n${failures.join('\n')}` : '');
        const prepared = this.options.prepareReply
          ? await this.options.prepareReply(candidate, signal, {
              runId: job.id,
              mediaContext,
              key: {
                remoteJid: message.key.remoteJid,
                participant: message.key.participant,
                fromMe: message.key.fromMe,
              },
              ...(this.options.agentRuns
                ? {
                    record: async (kind, value) => {
                      await this.repository.recordAgentEvent!(
                        job,
                        kind,
                        this.cipher.seal(`agent-event:${kind}`, job.id, value),
                      );
                    },
                  }
                : {}),
            })
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
        const protectedReply = prepared.businessEvidence !== undefined;
        if (protectedReply && (!this.options.agentRuns || !this.options.businessPreflight))
          throw new Error('Business delivery is not configured');
        // Old senders accept only a string, so they fail closed on this versioned business payload.
        const voice = await this.options.media?.voiceReferences(
          mediaOwner(
            this.options.accountId ?? 'primary',
            candidate.chatId,
            candidate.senderId ?? candidate.chatId,
          ),
          mediaIds,
        );
        const payload = this.cipher.seal(
          'outbound-reply',
          job.id,
          encodeReply(prepared.text, protectedReply, voice),
        );
        const businessEvidence = protectedReply
          ? this.cipher.seal('business-delivery', job.id, prepared.businessEvidence)
          : undefined;
        if (await this.repository.handoff(job, payload, new Date(), businessEvidence)) {
          if (prepared.onSent)
            this.sentCallbacks.set(job.id, {
              expiresAt: candidate.sentAtMs + this.options.maxAgeMs,
              run: prepared.onSent,
            });
        } else await this.repository.releaseUnsent(job);
        return;
      }
      if (manual && (!job.chatId || !session.sendText)) {
        await this.repository.complete(job, 'FAILED', 'manual_send_unavailable');
        report('error');
        return;
      }
      let reply: unknown;
      let voice: VoiceReplyReference | undefined;
      try {
        const decoded = decodeReply(
          this.cipher.open('outbound-reply', job.id, job.replyPayload ?? ''),
          job.replyKind ?? 'conversation',
        );
        reply = decoded.text;
        voice = decoded.voice;
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
      if (job.replyKind === 'business') {
        const allowed =
          !manual &&
          message &&
          this.options.businessPreflight &&
          job.businessEvidence &&
          (await this.options.businessPreflight(
            message,
            this.cipher.open('business-delivery', job.id, job.businessEvidence),
            signal,
          ));
        if (!allowed) {
          this.sentCallbacks.delete(job.id);
          if (signal.aborted) {
            await this.repository.releaseUnsent(job, true);
            return;
          }
          const notice =
            "I couldn't verify the business data before sending this reply. Please try again.";
          const saved =
            !manual &&
            message &&
            this.repository.replaceWithDeliveryNotice &&
            (await this.repository.replaceWithDeliveryNotice(
              job,
              this.cipher.seal('outbound-reply', job.id, encodeReply(notice, false, voice)),
            ));
          if (!saved) {
            await this.repository.complete(job, 'EXPIRED', 'business_delivery_check_failed');
            report('error');
            return;
          }
          reply = notice;
          job.replyKind = 'conversation';
          job.businessEvidence = undefined;
        }
      }
      // Persist the point of no safe automatic retry BEFORE invoking the SDK.
      if (voice) {
        const expectedOwner =
          candidate &&
          mediaOwner(
            this.options.accountId ?? 'primary',
            candidate.chatId,
            candidate.senderId ?? candidate.chatId,
          );
        if (manual || voice.owner !== expectedOwner) throw new Error('VOICE_REPLY_OWNER_MISMATCH');
        reply = (await renderVoiceReply(reply as string, voice, this.options.media?.store)).text;
      }
      if (!(await this.repository.beginSend(job))) {
        await this.repository.releaseUnsent(job);
        return;
      }
      if (signal.aborted) {
        await this.repository.releaseUnsent(job, true);
        return;
      }
      sendInvoked = true;
      if (manual) await session.sendText!(job.chatId!, reply as string);
      else await session.reply(message!, reply as string);
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
