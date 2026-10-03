/** Real receipt/queue recovery with synthetic identity and an in-memory transport only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { WAMessage } from '@whiskeysockets/baileys';
import { postgresTestsEnabled, temporaryMessageDatabase } from '../fixtures/message-database.js';
import { MessageQueueRepository } from '../../src/infrastructure/database/message-queue.repository.js';
import { PersonalRepository } from '../../src/infrastructure/database/personal.repository.js';
import { DurableMessages } from '../../src/infrastructure/whatsapp/durable-messages.js';
import type { WhatsAppSession } from '../../src/infrastructure/whatsapp/baileys-session.js';
import { toInboxCandidate } from '../../src/infrastructure/whatsapp/message.mapper.js';
import {
  AssistantService,
  UNAVAILABLE_REPLY,
} from '../../src/modules/assistant/assistant.service.js';
import { PersonalToolService } from '../../src/modules/scheduling/personal-tools.js';
import type { DurableMessageOptions } from '../../src/infrastructure/whatsapp/durable-messages.js';

test(
  'committed personal changes survive fallback output and bounded delivery reauthorization',
  { skip: !postgresTestsEnabled, timeout: 30000 },
  async (t) => {
    const db = await temporaryMessageDatabase();
    const encryptionKey = randomBytes(32).toString('base64url');
    const actor = {
      employeeId: 23,
      phoneE164: '+919000000023',
      chatId: '919000000023@s.whatsapp.net',
    };
    try {
      for (const recoverAuthority of [true, false]) {
        await t.test(
          recoverAuthority ? 'authorization recovers' : 'authorization stays denied',
          async () => {
            const account = `confirmation-${recoverAuthority}`;
            const queue = new MessageQueueRepository(db.runtime, account);
            const personal = new PersonalRepository(db.runtime, account, encryptionKey);
            const personalTools = new PersonalToolService(personal, async () => actor);
            let modelCalls = 0;
            const assistant = new AssistantService(
              { model: 'synthetic-no-model', timeoutMs: 5000 },
              {
                async complete() {
                  modelCalls++;
                  throw new Error('Receipt recovery must not call a model');
                },
              },
              undefined,
              undefined,
              undefined,
              undefined,
              { personalTools },
            );
            let authorized = false;
            const options: DurableMessageOptions = {
              encryptionKey,
              maxAgeMs: 300000,
              capacity: 10,
              leaseMs: 30000,
              pollMs: 5,
              agentRuns: true,
              waitBeforeReply: async () => true,
              businessPreflight: async () => authorized,
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
            const incoming: WAMessage = {
              key: { remoteJid: actor.chatId, fromMe: false, id: randomUUID() },
              messageTimestamp: Math.floor(Date.now() / 1000),
              message: { conversation: 'Remind me in 30 minutes to review the synthetic proposal' },
            };
            let applyCalls = 0;
            const first = new DurableMessages(queue, {
              ...options,
              prepareReply: async (_message, _signal, trusted) => {
                assert.ok(trusted?.checkpointLease);
                applyCalls++;
                await personal.applyBatch(
                  {
                    ...actor,
                    runId: trusted.runId,
                    leaseToken: trusted.checkpointLease.leaseToken,
                    requestTimeMs: trusted.commandMessages![0]!.receivedAtMs,
                  },
                  [
                    {
                      kind: 'reminder_create',
                      text: 'review the synthetic proposal',
                      schedule: {
                        dueAt: new Date(Date.now() + 1800000).toISOString(),
                        timezone: 'Asia/Kolkata',
                      },
                    },
                  ],
                );
                // Simulate the previous assistant catch path after a successful DB commit.
                return { text: UNAVAILABLE_REPLY };
              },
            });
            assert.equal(await first.enqueue(incoming, toInboxCandidate(incoming, [])!), 'queued');
            const runOnce = async (consumer: DurableMessages) => {
              const stop = new AbortController();
              const release = queue.releaseUnsent.bind(queue);
              const complete = queue.complete.bind(queue);
              queue.releaseUnsent = async (...args) => {
                await release(...args);
                stop.abort();
              };
              queue.complete = async (...args) => {
                const done = await complete(...args);
                stop.abort();
                return done;
              };
              try {
                await consumer.consume(
                  session,
                  AbortSignal.any([stop.signal, AbortSignal.timeout(5000)]),
                  () => {},
                );
                assert.equal(stop.signal.aborted, true, 'consumer reached a durable outcome');
              } finally {
                queue.releaseUnsent = release;
                queue.complete = complete;
              }
            };
            const messageState = async () =>
              (
                await db.admin.query(
                  `SELECT id,state,reply_kind,business_evidence_encrypted FROM public."ramesh-messages" WHERE account_id=$1`,
                  [account],
                )
              ).rows[0];
            const makeReady = async () => {
              for (const direction of ['inbound', 'outbound'])
                await db.admin.query(
                  `UPDATE public."ramesh-${direction}-queue" SET available_at=clock_timestamp() WHERE account_id=$1`,
                  [account],
                );
            };
            await runOnce(first);
            assert.equal((await messageState()).state, 'QUEUED');
            assert.equal(sent.length, 0);
            assert.equal(
              (
                await db.admin.query(
                  `SELECT count(*)::int n FROM public."ramesh-outbound-queue" WHERE account_id=$1`,
                  [account],
                )
              ).rows[0].n,
              0,
            );
            await makeReady();
            const recovering = new DurableMessages(queue, {
              ...options,
              prepareReply: async (...args) => {
                const reply = await assistant.prepare(...args);
                // Exercise the mixed-output envelope as well as the legacy personal receipt.
                return recoverAuthority
                  ? {
                      ...reply,
                      businessEvidence: {
                        kind: 'composite',
                        version: 1,
                        personal: reply.businessEvidence,
                        businessText: 'Synthetic business context.',
                        business: {
                          kind: 'context_tools',
                          version: 1,
                          employeeId: actor.employeeId,
                          localDate: new Date().toISOString().slice(0, 10),
                          preparedAt: new Date().toISOString(),
                          expiresAt: new Date(Date.now() + 300000).toISOString(),
                          checks: [
                            { tool: 'get_context', arguments: {}, fingerprint: 'a'.repeat(64) },
                          ],
                        },
                      },
                    }
                  : reply;
              },
            });
            await runOnce(recovering);
            const retained = await messageState();
            assert.equal(retained.state, 'READY_TO_SEND');
            assert.equal(retained.reply_kind, 'business');
            assert.ok(retained.business_evidence_encrypted);
            assert.equal(sent.length, 0, 'a failed authorization never sends a generic substitute');
            assert.equal(modelCalls, 0);
            assert.equal(applyCalls, 1);
            await db.admin.query(
              `UPDATE public."ramesh-outbound-queue" SET max_attempts=2 WHERE account_id=$1`,
              [account],
            );
            await makeReady();
            authorized = recoverAuthority;
            await runOnce(
              new DurableMessages(queue, {
                ...options,
                prepareReply: async () => {
                  throw new Error('Finalized confirmation must not regenerate');
                },
              }),
            );
            assert.equal((await messageState()).state, recoverAuthority ? 'SENT' : 'FAILED');
            assert.equal(sent.length, recoverAuthority ? 1 : 0);
            if (recoverAuthority)
              assert.match(sent[0]!, /Saved reminder: review the synthetic proposal/);
            for (const table of [
              'ramesh-reminders',
              'ramesh-assistant-commands',
              'ramesh-outbound-queue',
            ])
              assert.equal(
                (
                  await db.admin.query(
                    `SELECT count(*)::int n FROM public."${table}" WHERE account_id=$1`,
                    [account],
                  )
                ).rows[0].n,
                1,
                table,
              );
            assert.equal(modelCalls, 0);
            assert.equal(applyCalls, 1);
          },
        );
      }
    } finally {
      await db.close();
    }
  },
);
