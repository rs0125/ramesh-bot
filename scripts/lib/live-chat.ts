/** Real agent/data, capture-only queues. Never imports the application or any Baileys session factory. */
import { setTimeout as delay } from 'node:timers/promises';
import type { MediaUpload } from '../../src/modules/media/media.types.js';
import { MediaService, mediaOwner } from '../../src/modules/media/media.service.js';
import { randomUUID } from 'node:crypto';
import type { AssistantConfig } from '../../src/config/assistant.js';
import type { TextModel } from '../../src/modules/assistant/assistant.types.js';
import { AssistantService } from '../../src/modules/assistant/assistant.service.js';
import { renderVoiceReply } from '../../src/modules/media/voice-reply.js';
import type { BusinessReadService } from '../../src/modules/assistant/business-reads.js';
import type { EmployeeIdentity } from '../../src/modules/identity/employee-identity.js';
import {
  PlaygroundRepository,
  type CaptureInput,
} from '../../src/infrastructure/database/playground.repository.js';
import { SerialQueue } from '../../src/lib/serial-queue.js';
import type { LocalChatInput } from './local-chat.js';
import { withUsageScope } from '../../src/modules/usage/usage-scope.js';
import type { AgentCheckpointStore } from '../../src/modules/assistant/checkpoint.types.js';

export class LiveChat {
  private readonly queue = new SerialQueue(16);
  constructor(
    private readonly config: Pick<AssistantConfig, 'model' | 'timeoutMs' | 'usageMeter'>,
    private readonly model: TextModel,
    private readonly repo: PlaygroundRepository,
    private readonly access: {
      employee(signal: AbortSignal): Promise<EmployeeIdentity | null>;
      reads: BusinessReadService;
    },
    private readonly preflightMs: number,
    readonly media?: MediaService,
    private readonly checkpoints?: AgentCheckpointStore,
  ) {}

  private validate(input: LocalChatInput) {
    if (
      !/^[A-Za-z0-9_-]{1,100}$/.test(input.conversation) ||
      !['me', 'teammate'].includes(input.sender ?? 'me') ||
      !input.text.trim() ||
      input.text.length > 6000 ||
      (input.mediaIds?.length ?? 0) > 1 ||
      input.mediaIds?.some((id) => !/^[a-f0-9-]{36}$/i.test(id))
    )
      throw new Error('INVALID_CAPTURE_INPUT');
  }
  owner(input: Pick<LocalChatInput, 'conversation' | 'sender' | 'group'>) {
    return mediaOwner(
      `${this.repo.namespace}:${this.repo.employeeId}`,
      `${input.conversation}:${!!input.group}`,
      input.sender ?? 'me',
    );
  }
  async upload(input: Omit<LocalChatInput, 'text'>, file: MediaUpload, sourceId: string) {
    this.validate({ ...input, text: 'attachment' });
    if (!this.media || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(sourceId))
      throw new Error('MEDIA_UPLOAD_UNAVAILABLE');
    // Uploads precede chat admission in this GUI; they have separate stable runs but
    // share the employee/account/campaign budget with the eventual conversation.
    return withUsageScope(
      { runId: `upload:${sourceId}`, subjectId: `employee:${this.repo.employeeId}` },
      () => this.media!.ingest(this.owner(input), sourceId, file),
    );
  }
  async send(input: LocalChatInput, caller?: AbortSignal) {
    this.validate(input);
    const id = input.messageId ?? randomUUID();
    if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id))
      throw new Error('INVALID_CAPTURE_ID');
    const item: CaptureInput = {
      id,
      conversation: input.conversation,
      sender: input.sender === 'teammate' ? 'teammate' : 'me',
      group: !!input.group,
      text: input.text,
      forwarded: input.forwarded,
      mediaIds: input.mediaIds,
    };
    await this.repo.clean();
    await this.repo.enqueue(item);
    return new Promise<Awaited<ReturnType<LiveChat['process']>>>((resolve, reject) => {
      if (!this.queue.push(async () => resolve(await this.process(item, caller)), reject))
        reject(new Error('PLAYGROUND_BUSY'));
    });
  }
  private async process(item: CaptureInput, caller?: AbortSignal) {
    const signal = AbortSignal.any([
      ...(caller ? [caller] : []),
      AbortSignal.timeout(this.config.timeoutMs + this.preflightMs + 120000),
    ]);
    let batch = await this.repo.batch(item.id);
    while (batch.availableAt.getTime() > Date.now()) {
      await delay(Math.min(250, batch.availableAt.getTime() - Date.now()), undefined, { signal });
      batch = await this.repo.batch(item.id);
    }
    const id = batch.id;
    return withUsageScope({ runId: id, subjectId: `employee:${this.repo.employeeId}` }, () =>
      this.processScoped(item, id, signal),
    );
  }
  private async processScoped(item: CaptureInput, id: string, signal: AbortSignal) {
    const actor = await this.access.employee(signal);
    const chatId = item.group
      ? 'test-group@g.us'
      : item.sender === 'me' && actor
        ? `${actor.phoneE164.slice(1)}@s.whatsapp.net`
        : 'test-unknown@s.whatsapp.net';
    const key = { remoteJid: chatId, fromMe: false };
    let saved = await this.repo.output(id);
    if (!saved) {
      const job = await this.repo.claim(id, this.config.timeoutMs + 120000);
      if (!job) throw new Error('CAPTURE_REQUEST_BUSY_OR_EXPIRED');
      try {
        const assistant = new AssistantService(
          this.config,
          this.model,
          undefined,
          undefined,
          () => this.repo.history(job),
          this.access.reads,
          { checkpoints: this.checkpoints },
        );
        const reply = await assistant.prepare(
          {
            chatId,
            messageId: id,
            text: job.text,
            batchMessageIds: job.memberIds,
            fromMe: false,
            isGroup: job.group,
            mentionsBot: job.group,
            sentAtMs: job.createdAt.getTime(),
          },
          signal,
          {
            runId: id,
            checkpointLease: { leaseToken: job.token },
            key,
            record: (kind, value) => this.repo.record(job, kind, value),
            mediaContext: this.media
              ? await this.media.context(this.owner(item), job.mediaIds ?? [], job.text, signal)
              : undefined,
          },
        );
        signal.throwIfAborted();
        await this.repo.finalize(job, {
          text: reply.text,
          voice: await this.media?.voiceReferences(this.owner(item), job.mediaIds ?? []),
          trace: reply.trace,
          ...(reply.businessEvidence === undefined
            ? {}
            : { businessEvidence: reply.businessEvidence }),
        });
      } catch (error) {
        await this.repo.release(job, signal.aborted);
        throw error;
      }
      saved = await this.repo.output(id);
    }
    if (!saved) throw new Error('CAPTURE_OUTPUT_MISSING');
    if (
      saved.state === 'SUPPRESSED' ||
      (saved.reply.businessEvidence !== undefined &&
        !(await this.access.reads.canDeliver(
          key,
          saved.reply.businessEvidence,
          AbortSignal.any([signal, AbortSignal.timeout(this.preflightMs)]),
        )))
    ) {
      await this.repo.suppress(id);
      return {
        text: 'This saved business reply is no longer current or authorized. Ask again for a fresh result.',
        businessEvidence: undefined,
        trace: saved.reply.trace,
        outcome: 'suppressed',
        queueId: id,
      };
    }
    signal.throwIfAborted();
    const { voice, ...reply } = saved.reply;
    if (voice && voice.owner !== this.owner(item)) throw new Error('VOICE_REPLY_OWNER_MISMATCH');
    return {
      ...reply,
      ...(await renderVoiceReply(reply.text, voice, this.media?.store)),
      outcome: 'captured',
      queueId: id,
    };
  }
  async clear(input: Omit<LocalChatInput, 'text'>) {
    await this.media?.clear(this.owner(input));
    return this.repo.clear(input.conversation, input.sender ?? 'me', !!input.group);
  }
  async drain() {
    await this.queue.drain();
    await this.media?.drain();
  }
}
