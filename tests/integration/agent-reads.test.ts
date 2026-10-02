/** Real PostgreSQL journal/outbox transactions with synthetic CRM and capture-only delivery. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { WAMessage } from '@whiskeysockets/baileys';
import { postgresTestsEnabled, temporaryMessageDatabase } from '../fixtures/message-database.js';
import { MessageQueueRepository } from '../../src/infrastructure/database/message-queue.repository.js';
import { InboxRepository } from '../../src/infrastructure/database/inbox.repository.js';
import { authCipher } from '../../src/infrastructure/database/auth-store.js';
import { DurableMessages } from '../../src/infrastructure/whatsapp/durable-messages.js';
import { toInboxCandidate } from '../../src/infrastructure/whatsapp/message.mapper.js';
import type { WhatsAppSession } from '../../src/infrastructure/whatsapp/baileys-session.js';
import { AssistantService } from '../../src/modules/assistant/assistant.service.js';
import { createFollowupFixture } from '../../scripts/lib/followup-fixture.js';

test(
  'private CRM reads survive restart and recheck delivery authority',
  { skip: !postgresTestsEnabled, timeout: 30000 },
  async (t) => {
    const database = await temporaryMessageDatabase();
    const key = randomBytes(32).toString('base64url');
    const cipher = authCipher(key);
    const chatId = '20000000000@s.whatsapp.net';
    const botJids = ['10000000000@s.whatsapp.net'];
    const message = (): WAMessage => ({
      key: { id: randomUUID(), remoteJid: chatId, fromMe: false },
      message: { conversation: 'Show my follow-ups for today' },
      messageTimestamp: Math.floor(Date.now() / 1000),
    });
    const row = async (account: string) =>
      (
        await database.admin.query(
          'SELECT * FROM public."ramesh-messages" WHERE account_id=$1 ORDER BY created_at LIMIT 1',
          [account],
        )
      ).rows[0];
    try {
      for (const mode of ['send', 'revoked', 'changed', 'disabled'] as const) {
        await t.test(`restart after finalization: ${mode}`, async () => {
          const account = `business-${mode}`;
          const repo = new MessageQueueRepository(database.runtime, account);
          const fixture = createFollowupFixture();
          let generations = 0;
          const assistant = new AssistantService(
            { model: 'fake', timeoutMs: 2000 },
            {
              async complete() {
                generations++;
                return {
                  text: JSON.stringify({
                    intent: 'assigned_followups_today',
                    language: 'en',
                    draft: '',
                  }),
                  inputTokens: 1,
                  outputTokens: 1,
                };
              },
            },
            undefined,
            undefined,
            undefined,
            fixture.service,
          );
          const options = {
            encryptionKey: key,
            maxAgeMs: 300000,
            capacity: 10,
            leaseMs: 45000,
            pollMs: 5,
            waitBeforeReply: async () => true,
            agentRuns: true,
            prepareReply: assistant.prepare.bind(assistant),
            businessPreflight: (
              original: Pick<WAMessage, 'key'>,
              evidence: unknown,
              signal: AbortSignal,
            ) => fixture.service.canDeliver(original.key, evidence, signal),
          };
          const sent: string[] = [];
          const session: WhatsAppSession = {
            botJids,
            on: () => () => {},
            async close() {},
            async saveCredentials() {},
            async reply(original, text) {
              assert.equal(original.key.remoteJid, chatId);
              sent.push(text);
            },
          };
          const first = new DurableMessages(repo, options);
          const incoming = message();
          const candidate = toInboxCandidate(incoming, botJids)!;
          assert.equal(await first.enqueue(incoming, candidate), 'queued');
          assert.equal(await first.enqueue(incoming, candidate), 'duplicate');
          const stopped = new AbortController();
          const handoff = repo.handoff.bind(repo);
          repo.handoff = async (...args) => {
            const saved = await handoff(...args);
            stopped.abort();
            return saved;
          };
          await first.consume(
            session,
            AbortSignal.any([stopped.signal, AbortSignal.timeout(5000)]),
            (outcome) => assert.fail(outcome),
          );
          assert.equal(sent.length, 0);
          const saved = await row(account);
          assert.equal(saved.state, 'READY_TO_SEND');
          assert.equal(saved.reply_kind, 'business');
          assert.ok(!JSON.stringify(saved).includes('Fixture Acme'));
          const encryptedReply = cipher.open('outbound-reply', saved.id, saved.reply_encrypted);
          assert.equal(typeof encryptedReply, 'object', 'older string-only senders fail closed');
          const events = (
            await database.admin.query(
              'SELECT * FROM public."ramesh-agent-events" WHERE run_id=$1 ORDER BY id',
              [saved.id],
            )
          ).rows;
          assert.deepEqual(
            events.map((event) => event.kind),
            ['tool_started', 'tool_succeeded', 'finalized'],
          );
          assert.ok(!JSON.stringify(events).includes('Fixture Acme'));
          assert.match(
            JSON.stringify(
              cipher.open('agent-event:tool_succeeded', saved.id, events[1].payload_encrypted),
            ),
            /Fixture Acme/,
          );
          assert.equal(
            (
              await database.admin.query(
                'SELECT state FROM public."ramesh-agent-runs" WHERE id=$1',
                [saved.id],
              )
            ).rows[0].state,
            'finalized',
          );
          assert.equal(generations, 1);

          if (mode === 'revoked') fixture.state.active = false;
          if (mode === 'changed') fixture.state.empty = true;
          const restart = new DurableMessages(
            new MessageQueueRepository(database.runtime, account),
            {
              ...options,
              prepareReply: async () => {
                assert.fail('Finalized reply must not be regenerated');
              },
              businessPreflight: mode === 'disabled' ? undefined : options.businessPreflight,
            },
          );
          const stopDelivery = new AbortController();
          const consuming = restart.consume(
            session,
            AbortSignal.any([stopDelivery.signal, AbortSignal.timeout(5000)]),
            (outcome) => assert.equal(outcome, 'sent'),
          );
          try {
            const deadline = Date.now() + 4000;
            while ((await row(account)).state === 'READY_TO_SEND' && Date.now() < deadline)
              await sleep(10);
          } finally {
            stopDelivery.abort();
            await consuming;
          }
          const delivered = await row(account);
          assert.equal(delivered.state, mode === 'send' ? 'SENT' : 'EXPIRED');
          assert.equal(sent.length, mode === 'send' ? 1 : 0);
          if (mode !== 'send') assert.equal(delivered.reason, 'business_delivery_not_authorized');
          else assert.match(sent[0]!, /Fixture Acme/);
          assert.equal(generations, 1);
          assert.equal(
            (
              await database.admin.query(
                'SELECT count(*)::int AS n FROM public."ramesh-outbound-queue" WHERE message_id=$1',
                [saved.id],
              )
            ).rows[0].n,
            1,
          );

          const inbox = new InboxRepository(database.runtime, account, key);
          assert.ok(!JSON.stringify(await inbox.messages(chatId)).includes('Fixture Acme'));
          assert.match(JSON.stringify(await inbox.messages(chatId)), /Private CRM reply/);
          const next = message();
          await first.enqueue(next, toInboxCandidate(next, botJids)!);
          const history = await inbox.context(toInboxCandidate(next, botJids)!);
          assert.ok(
            !JSON.stringify(history.map(({ role, content }) => ({ role, content }))).includes(
              'Fixture Acme',
            ),
          );
          assert.ok(
            history
              .filter((item) => item.role === 'assistant')
              .every((item) => item.content.includes('Private content is omitted')),
          );
          // Retention cascades to the append-only event log without granting event DELETE to the worker.
          await database.admin.query(
            'UPDATE public."ramesh-messages" SET finished_at=clock_timestamp()-interval \'31 days\' WHERE id=$1',
            [saved.id],
          );
          await repo.clean();
          assert.equal(
            (
              await database.admin.query(
                'SELECT 1 FROM public."ramesh-agent-events" WHERE run_id=$1',
                [saved.id],
              )
            ).rowCount,
            0,
          );
        });
      }

      await t.test(
        'journal writes and business handoff are fenced by the current inbound lease',
        async () => {
          const repo = new MessageQueueRepository(database.runtime, 'journal-fencing');
          const incoming = message();
          await repo.enqueue(
            randomUUID(),
            toInboxCandidate(incoming, botJids)!,
            'opaque',
            300000,
            10,
          );
          const old = (await repo.claimInbound(45000))!;
          await assert.rejects(
            repo.handoff(old, 'opaque-reply', new Date(), 'opaque-evidence'),
            /fenced agent run/,
          );
          assert.equal(
            (
              await database.admin.query(
                'SELECT 1 FROM public."ramesh-outbound-queue" WHERE message_id=$1',
                [old.id],
              )
            ).rowCount,
            0,
          );
          assert.equal((await row('journal-fencing')).state, 'PROCESSING');
          assert.equal(await repo.beginAgentRun(old), true);
          await repo.recordAgentEvent(old, 'tool_started', 'encrypted-receipt');
          await database.admin.query(
            'UPDATE public."ramesh-inbound-queue" SET lease_until=clock_timestamp()-interval \'1 second\' WHERE message_id=$1',
            [old.id],
          );
          const current = (await repo.claimInbound(45000))!;
          assert.equal(current.attempts, 2);
          assert.equal(await repo.beginAgentRun(old), false);
          await assert.rejects(
            repo.recordAgentEvent(old, 'tool_succeeded', 'stale'),
            /lease expired/,
          );
          assert.equal(await repo.handoff(old, 'stale', new Date(), 'stale-evidence'), false);
          assert.equal(await repo.beginAgentRun(current), true);
          await repo.recordAgentEvent(current, 'tool_succeeded', 'new-receipt');
          assert.equal(await repo.handoff(current, 'reply', new Date(), 'evidence'), true);
          const run = (
            await database.admin.query('SELECT * FROM public."ramesh-agent-runs" WHERE id=$1', [
              old.id,
            ])
          ).rows[0];
          assert.equal(run.attempt, 2);
          assert.equal(run.state, 'finalized');
          await assert.rejects(
            database.runtime.query('UPDATE public."ramesh-agent-events" SET kind=kind'),
            /permission denied/,
          );
          await assert.rejects(
            database.runtime.query('DELETE FROM public."ramesh-agent-events"'),
            /permission denied/,
          );
          const other = new MessageQueueRepository(database.runtime, 'other-account');
          await assert.rejects(
            other.recordAgentEvent(current, 'tool_failed', 'wrong-account'),
            /lease expired/,
          );
        },
      );
    } finally {
      await database.close();
    }
  },
);
