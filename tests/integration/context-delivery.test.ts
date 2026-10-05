/** Synthetic local PostgreSQL only; the WhatsApp transport is a capture stub. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { WAMessage } from '@whiskeysockets/baileys';
import { postgresTestsEnabled, temporaryMessageDatabase } from '../fixtures/message-database.js';
import { ChatContext, contextScope } from '../../src/modules/assistant/chat-context.js';
import { AssistantService } from '../../src/modules/assistant/assistant.service.js';
import { ChatContextRepository } from '../../src/infrastructure/database/chat-context.repository.js';
import { InboxRepository } from '../../src/infrastructure/database/inbox.repository.js';
import { MessageQueueRepository } from '../../src/infrastructure/database/message-queue.repository.js';
import { authCipher } from '../../src/infrastructure/database/auth-store.js';
import { DurableMessages } from '../../src/infrastructure/whatsapp/durable-messages.js';
import { toInboxCandidate } from '../../src/infrastructure/whatsapp/message.mapper.js';
import {
  authorizeDelivery,
  contextDeliveryBundleSchema,
} from '../../src/modules/messaging/delivery-evidence.js';
import type { WhatsAppSession } from '../../src/infrastructure/whatsapp/baileys-session.js';

test(
  'encrypted memory replies survive restart and require current identity at delivery',
  {
    skip: !postgresTestsEnabled,
    timeout: 90000,
  },
  async (t) => {
    const db = await temporaryMessageDatabase();
    const encryptionKey = randomBytes(32).toString('base64url');
    const cipher = authCipher(encryptionKey),
      chatId = '20000000000@s.whatsapp.net';
    try {
      for (const mode of ['same', 'revoked', 'reassigned', 'disabled'] as const)
        await t.test(mode, async () => {
          const account = randomUUID();
          let actor: { employeeId: number; phoneE164: string } | null = {
            employeeId: 1,
            phoneE164: '+20000000000',
          };
          const model = {
            async complete(): Promise<never> {
              assert.fail('Commands do not require a model');
            },
          };
          const createContext = () =>
            new ChatContext({
              model,
              store: new ChatContextRepository(db.runtime, account, encryptionKey),
              source: new InboxRepository(db.runtime, account, encryptionKey),
              resolve: async () => (actor ? contextScope(account, chatId, actor) : null),
            });
          const assistant = new AssistantService(
            { model: 'synthetic-no-api', timeoutMs: 15000 },
            model,
            undefined,
            undefined,
            undefined,
            undefined,
            { conversationContext: createContext() },
          );
          const repo = new MessageQueueRepository(db.runtime, account);
          const original: WAMessage = {
            key: { id: randomUUID(), remoteJid: chatId, fromMe: false },
            message: { conversation: '/pin private: SYNTHETIC_PRIVATE_NOTE' },
            messageTimestamp: Math.floor(Date.now() / 1000),
          };
          let prepared: Awaited<ReturnType<AssistantService['prepare']>> | undefined;
          const options = {
            encryptionKey,
            maxAgeMs: 300000,
            capacity: 10,
            leaseMs: 45000,
            pollMs: 5,
            waitBeforeReply: async () => true,
            agentRuns: true,
            prepareReply: async (...args: Parameters<AssistantService['prepare']>) => {
              prepared = await assistant.prepare(...args);
              return prepared;
            },
            businessPreflight: (
              message: Pick<WAMessage, 'key'>,
              evidence: unknown,
              signal: AbortSignal,
            ) =>
              authorizeDelivery(evidence, {
                context: (receipt) => createContext().canDeliver(message.key, receipt, signal),
              }),
          };
          const sent: string[] = [];
          const session: WhatsAppSession = {
            botJids: [],
            on: () => () => {},
            async close() {},
            async saveCredentials() {},
            async reply(_message, text) {
              sent.push(text);
            },
          };
          const stopped = new AbortController();
          const handoff = repo.handoff.bind(repo);
          repo.handoff = async (...args) => {
            const saved = await handoff(...args);
            stopped.abort();
            return saved;
          };
          const first = new DurableMessages(repo, options);
          assert.equal(await first.enqueue(original, toInboxCandidate(original, [])!), 'queued');
          await first.consume(
            session,
            AbortSignal.any([stopped.signal, AbortSignal.timeout(20000)]),
            () => assert.fail('Not yet delivered'),
          );
          const row = async () =>
            (
              await db.admin.query('SELECT * FROM public."ramesh-messages" WHERE account_id=$1', [
                account,
              ])
            ).rows[0];
          const frozen = await row();
          assert.equal(prepared?.trace.outcome, 'completed', prepared?.trace.failureCode);
          assert.equal(frozen.state, 'READY_TO_SEND');
          assert.equal(frozen.reply_kind, 'business');
          assert.equal(sent.length, 0);
          assert.doesNotMatch(JSON.stringify(frozen), /SYNTHETIC_PRIVATE_NOTE/);
          assert.ok(
            contextDeliveryBundleSchema.safeParse(
              cipher.open('business-delivery', frozen.id, frozen.business_evidence_encrypted),
            ).success,
          );
          if (mode === 'revoked') actor = null;
          if (mode === 'reassigned') actor = { employeeId: 2, phoneE164: '+20000000000' };
          const restart = new DurableMessages(new MessageQueueRepository(db.runtime, account), {
            ...options,
            prepareReply: async () =>
              assert.fail('Must deliver the frozen reply without regeneration'),
            businessPreflight: mode === 'disabled' ? undefined : options.businessPreflight,
          });
          const stopDelivery = new AbortController();
          await restart.consume(
            session,
            AbortSignal.any([stopDelivery.signal, AbortSignal.timeout(15000)]),
            () => stopDelivery.abort(),
          );
          assert.equal((await row()).state, 'SENT');
          assert.equal(sent.length, 1);
          assert.equal(sent[0]!.includes('SYNTHETIC_PRIVATE_NOTE'), mode === 'same');
        });
    } finally {
      await db.close();
    }
  },
);
