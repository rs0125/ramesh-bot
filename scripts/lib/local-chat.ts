/** SQLite test path with a capture-only transport. This module never creates a WhatsApp socket. */
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WAMessage } from '@whiskeysockets/baileys';
import type { PrismaClient } from '@prisma/client';
import type { AssistantConfig } from '../../src/config/assistant.js';
import { createPrismaClient } from '../../src/infrastructure/database/prisma.js';
import { PrismaGreetingRepository } from '../../src/infrastructure/database/greeting.repository.js';
import { toGreetingCandidate } from '../../src/infrastructure/whatsapp/message.mapper.js';
import { GreetingService } from '../../src/modules/greetings/greeting.service.js';
import {
  AssistantService,
  type AssistantReply,
} from '../../src/modules/assistant/assistant.service.js';
import type { TextModel } from '../../src/modules/assistant/assistant.types.js';
import { SerialQueue } from '../../src/lib/serial-queue.js';
import type { createFollowupFixture } from './followup-fixture.js';

export interface LocalChatInput {
  conversation: string;
  sender?: string;
  group?: boolean;
  text: string;
  messageId?: string;
  forwarded?: boolean;
  mediaIds?: string[];
}

export class LocalChat {
  private readonly queue = new SerialQueue(16);
  private readonly assistant: AssistantService;
  constructor(
    config: Pick<AssistantConfig, 'model' | 'timeoutMs'>,
    model: TextModel,
    private readonly db: PrismaClient,
    private readonly fixture?: ReturnType<typeof createFollowupFixture>,
  ) {
    this.assistant = new AssistantService(
      config,
      model,
      undefined,
      undefined,
      undefined,
      fixture?.service,
    );
  }

  private message(input: LocalChatInput) {
    if (
      ![input.conversation, input.sender ?? 'me'].every((part) =>
        /^[a-zA-Z0-9_-]{1,100}$/.test(part),
      )
    )
      throw new Error('Invalid simulated identity');
    // Deliberately non-numeric IDs; these cannot address a real WhatsApp contact.
    const sender = `local-${input.sender ?? 'me'}@s.whatsapp.net`;
    const chatId = `local-${input.conversation}@${input.group ? 'g.us' : 's.whatsapp.net'}`;
    const message: WAMessage = {
      key: {
        id: input.messageId ?? randomUUID(),
        remoteJid: chatId,
        participant: input.group ? sender : undefined,
        fromMe: false,
      },
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: input.group
        ? {
            extendedTextMessage: {
              text: input.text,
              contextInfo: { mentionedJid: ['local-ramesh@s.whatsapp.net'] },
            },
          }
        : { conversation: input.text },
    };
    const candidate = toGreetingCandidate(message, ['local-ramesh@s.whatsapp.net']);
    if (!candidate) throw new Error('Enter a text message');
    return { candidate, key: message.key };
  }

  send(input: LocalChatInput, signal?: AbortSignal): Promise<AssistantReply & { outcome: string }> {
    return new Promise((resolveReply, reject) => {
      if (
        !this.queue.push(async () => {
          signal?.throwIfAborted();
          const { candidate: message, key } = this.message(input);
          let prepared: AssistantReply | undefined;
          let text: string | undefined;
          const service = new GreetingService(
            new PrismaGreetingRepository(this.db),
            300_000,
            Date.now,
            async () => true,
            async (candidate, abort) => {
              prepared = await this.assistant.prepare(candidate, abort, {
                runId: randomUUID(),
                key,
              });
              return prepared;
            },
          );
          const outcome = await service.handle(
            message,
            async (reply) => {
              if (
                prepared?.businessEvidence !== undefined &&
                !(await this.fixture?.service.canDeliver(
                  key,
                  prepared.businessEvidence,
                  signal ?? new AbortController().signal,
                ))
              )
                throw new Error('Fixture delivery was suppressed');
              text = reply;
            },
            signal,
          );
          signal?.throwIfAborted();
          if (!prepared || text === undefined) throw new Error(`Message ${outcome}`);
          resolveReply({ ...prepared, text, outcome });
        }, reject)
      )
        reject(new Error('Local chat is busy. Try again shortly.'));
    });
  }

  clear(input: Omit<LocalChatInput, 'text'>) {
    this.assistant.clear(this.message({ ...input, text: 'reset' }).candidate);
  }
  drain() {
    return this.queue.drain();
  }
}

export async function openLocalChatDatabase(path: string) {
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
  const root = fileURLToPath(new URL('../../', import.meta.url));
  await promisify(execFile)(
    process.execPath,
    [resolve(root, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
    { cwd: root, timeout: 60_000, env: { ...process.env, DATABASE_URL: `file:${absolute}` } },
  );
  const db = createPrismaClient(`file:${absolute}`);
  await db.$connect();
  return db;
}
