import { planningResult } from '../fixtures/planning-model.js';
/** Real PostgreSQL capture queues with a synthetic read adapter. No production or WhatsApp connection. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { temporaryMessageDatabase, postgresTestsEnabled } from '../fixtures/message-database.js';
import { applyPlaygroundSchema } from '../../scripts/playground-schema.js';
import { PlaygroundRepository } from '../../src/infrastructure/database/playground.repository.js';
import { LiveChat } from '../../scripts/lib/live-chat.js';
import { BusinessReadService } from '../../src/modules/assistant/business-reads.js';
import { followupEvidence } from '../../scripts/lib/followup-fixture.js';
import type { ModelRequest } from '../../src/modules/assistant/assistant.types.js';
import { PostgresEmployeeRoster } from '../../src/infrastructure/database/employee-roster.js';
import { EmployeeIdentityResolver } from '../../src/modules/identity/employee-identity.js';
import { createSalesFixture, FIXTURE_EMPLOYEE } from '../../scripts/lib/sales-fixture.js';
import { toolDeliverySchema } from '../../src/modules/assistant/tool-evidence.js';
import { PRIVATE_HISTORY_REPLY } from '../../src/modules/assistant/conversation-memory.js';

test(
  'live-data harness queue isolation, atomic capture and private replay',
  { skip: !postgresTestsEnabled, timeout: 30000 },
  async (t) => {
    const database = await temporaryMessageDatabase();
    let pool: Pool | undefined;
    try {
      await database.admin.query(
        'CREATE TABLE public."VerifiedNumber" (id integer PRIMARY KEY,phone_number text,email text,is_active boolean,internal_note text)',
      );
      await database.admin.query('ALTER TABLE public."VerifiedNumber" ENABLE ROW LEVEL SECURITY');
      await database.admin.query(
        `INSERT INTO public."VerifiedNumber" VALUES (23,'+919000000023','fixture@example.com',true,'private')`,
      );
      const password = 'ramesh_playground_tests_password_1234567890';
      const admin = await database.admin.connect();
      try {
        await admin.query('BEGIN');
        await applyPlaygroundSchema(admin, password);
        await applyPlaygroundSchema(admin, password);
        await admin.query('COMMIT');
      } finally {
        admin.release();
      }
      const url = new URL(database.url);
      url.username = 'ramesh_playground';
      url.password = password;
      pool = new Pool({ connectionString: url.href, max: 2, ssl: false });
      const key = randomBytes(32).toString('base64url');
      const repo = new PlaygroundRepository(pool, randomUUID(), 23, key);
      await t.test(
        'runtime cannot touch live queues, production worker cannot read capture queues',
        async () => {
          await repo.health();
          const identity = await new EmployeeIdentityResolver(
            new PostgresEmployeeRoster(pool!),
          ).resolveEmployee(23, AbortSignal.timeout(5000));
          assert.equal(identity?.employeeId, 23);
          await assert.rejects(
            pool!.query('SELECT * FROM public."VerifiedNumber"'),
            /permission denied/,
          );
          await assert.rejects(
            pool!.query('SELECT * FROM public."ramesh-inbound-queue"'),
            /permission denied/,
          );
          await assert.rejects(
            pool!.query(
              'INSERT INTO public."ramesh-outbound-queue" (message_id,account_id,payload_encrypted) VALUES ($1,$2,$3)',
              [randomUUID(), 'primary', 'blocked'],
            ),
            /permission denied/,
          );
          await assert.rejects(
            database.runtime.query('SELECT * FROM public."ramesh-test-outbound-queue"'),
            /permission denied/,
          );
          await assert.rejects(
            pool!.query('UPDATE public."VerifiedNumber" SET is_active=false'),
            /permission denied/,
          );
          await assert.rejects(
            new PlaygroundRepository(database.runtime, randomUUID(), 23, key).health(),
            /DEDICATED_LOGIN/,
          );
          await database.admin.query(
            'GRANT SELECT ON public."ramesh-outbound-queue" TO ramesh_playground',
          );
          await assert.rejects(repo.health(), /ISOLATION/);
          await database.admin.query(
            'REVOKE SELECT ON public."ramesh-outbound-queue" FROM ramesh_playground',
          );
          await repo.health();
        },
      );
      const state = { active: true, calls: 0 };
      const employee = {
        employeeId: 23,
        phoneE164: '+919000000023',
        email: 'fixture@example.com',
        active: true,
      };
      const access = {
        employee: async () => (state.active ? employee : null),
        reads: new BusinessReadService(
          async (key) =>
            state.active && key.remoteJid === '919000000023@s.whatsapp.net'
              ? {
                  employeeId: 23,
                  search: async () => {
                    state.calls++;
                    return followupEvidence();
                  },
                }
              : null,
          [23],
        ),
      };
      const modelCalls: ModelRequest[] = [];
      const chat = new LiveChat(
        { model: 'fixture', timeoutMs: 3000 },
        {
          async complete(request) {
            const planning = planningResult(request);
            if (planning) return planning;
            modelCalls.push(request);
            return {
              text:
                request.stage === 'formatter'
                  ? 'Hey.'
                  : JSON.stringify({
                      intent:
                        request.messages.at(-1)!.content === 'hello'
                          ? 'chat'
                          : 'assigned_followups_today',
                      language: 'en',
                      draft: 'Hey.',
                    }),
              inputTokens: 1,
              outputTokens: 1,
            };
          },
        },
        repo,
        access,
        2000,
      );
      await t.test(
        'real graph captures once, replays without generation, excludes private history and suppresses after revocation',
        async () => {
          const input = {
            conversation: 'one',
            sender: 'me',
            text: 'my follow-ups today',
            messageId: randomUUID(),
          };
          const reply = await chat.send(input);
          assert.equal(reply.outcome, 'captured');
          assert.match(reply.text, /Fixture Acme/);
          assert.equal(state.calls, 2);
          const again = await chat.send(input);
          assert.equal(again.text, reply.text);
          assert.equal(modelCalls.length, 1);
          assert.equal(state.calls, 3);
          const stored = (
            await database.admin.query(
              'SELECT * FROM public."ramesh-test-outbound-queue" WHERE message_id=$1',
              [input.messageId],
            )
          ).rows;
          assert.equal(stored.length, 1);
          assert.equal(stored[0].transport, 'capture');
          assert.equal(stored[0].state, 'CAPTURED');
          assert.ok(!JSON.stringify(stored).includes('Fixture Acme'));
          assert.equal(
            (
              await database.admin.query(
                'SELECT count(*)::int AS n FROM public."ramesh-outbound-queue"',
              )
            ).rows[0].n,
            0,
          );
          await chat.send({ ...input, text: 'hello', messageId: randomUUID() });
          assert.ok(!JSON.stringify(modelCalls.at(-2)!.messages).includes('Fixture Acme'));
          await assert.rejects(chat.send({ ...input, text: 'different request' }), /CONFLICT/);
          state.active = false;
          const revoked = await chat.send(input);
          assert.equal(revoked.outcome, 'suppressed');
          assert.ok(!revoked.text.includes('Fixture Acme'));
          assert.equal(modelCalls.length, 3);
          state.active = true;
          assert.equal(
            (await chat.send(input)).outcome,
            'suppressed',
            'suppression is irreversible for that saved result',
          );
        },
      );
      await t.test('unknown identities and groups never reach the read adapter', async () => {
        const before = state.calls;
        for (const input of [
          { sender: 'teammate', group: false },
          { sender: 'me', group: true },
        ]) {
          const reply = await chat.send({
            conversation: randomUUID(),
            text: 'my follow-ups today',
            ...input,
          });
          assert.ok(!reply.text.includes('Fixture Acme'));
          assert.equal(reply.businessEvidence, undefined);
        }
        assert.equal(state.calls, before);
      });
      await t.test(
        'general sales loop persists all-date evidence, reauthorizes replay and keeps private replies out of history',
        async () => {
          const fixture = createSalesFixture();
          let sessions = 0;
          const general = new LiveChat(
            { model: 'fixture', timeoutMs: 5000 },
            {
              startToolSession() {
                sessions++;
                let step = 0;
                return {
                  async next() {
                    return {
                      text:
                        step++ === 0
                          ? ''
                          : 'Fixture Acme Storage and Fixture Beacon Retail. Verify recorded requirements.',
                      inputTokens: 1,
                      outputTokens: 1,
                      calls:
                        step === 1
                          ? [
                              {
                                id: 'call-1',
                                name: 'search_crm_leads',
                                arguments: '{"view":"assigned","sort":"follow_up_asc","limit":10}',
                              },
                            ]
                          : [],
                    };
                  },
                  accept() {},
                };
              },
              async complete(request) {
                const planning = planningResult(request);
                if (planning) return planning;
                return {
                  text:
                    request.stage === 'verifier'
                      ? '{"supported":true,"feedback":""}'
                      : 'Fixture Acme Storage and Fixture Beacon Retail. Created: Not recorded. Last updated: Not recorded. Verify recorded requirements.',
                  inputTokens: 1,
                  outputTokens: 1,
                };
              },
            },
            repo,
            {
              employee: async () => (fixture.state.active ? FIXTURE_EMPLOYEE : null),
              reads: fixture.service,
            },
            2000,
          );
          try {
            const input = {
              conversation: 'general-sales',
              text: 'show all follow ups',
              messageId: randomUUID(),
            };
            const reply = await general.send(input);
            assert.equal(reply.outcome, 'captured');
            const receipt = toolDeliverySchema.parse(reply.businessEvidence);
            assert.deepEqual(receipt.checks[0]!.arguments, {
              view: 'assigned',
              sort: 'follow_up_asc',
              limit: 10,
            });
            assert.equal(fixture.state.calls.length, 2);
            assert.equal((await general.send(input)).text, reply.text);
            assert.equal(sessions, 1);
            assert.equal(fixture.state.calls.length, 3);
            const eventRows = (
              await database.admin.query(
                'SELECT kind,payload_encrypted FROM public."ramesh-test-agent-events" WHERE message_id=$1',
                [input.messageId],
              )
            ).rows;
            assert.deepEqual(eventRows.map((r) => r.kind).sort(), [
              'tool_started',
              'tool_succeeded',
            ]);
            assert.ok(!JSON.stringify(eventRows).includes('Fixture Acme'));
            const nextId = randomUUID();
            await repo.enqueue({
              id: nextId,
              conversation: input.conversation,
              sender: 'me',
              group: false,
              text: 'what about tomorrow?',
            });
            const next = (await repo.claim(nextId, 45000))!;
            const history = await repo.history(next);
            assert.deepEqual(
              history.map(({ role, content }) => ({ role, content })),
              [
                { role: 'user', content: 'show all follow ups' },
                { role: 'assistant', content: PRIVATE_HISTORY_REPLY },
              ],
            );
            assert.equal(history[1]?.protectedReply?.text, reply.text);
            assert.deepEqual(history[1]?.protectedReply?.receipt, receipt);
            fixture.state.active = false;
            assert.equal((await general.send(input)).outcome, 'suppressed');
            assert.ok(
              (await repo.history(next)).every((item) => item.protectedReply === undefined),
            );
            assert.equal(sessions, 1);
          } finally {
            await general.drain();
          }
        },
      );
      await t.test(
        'durable capture context keeps the last 32 messages and respects conversation boundaries',
        async () => {
          const conversation = `history-${randomUUID()}`;
          for (let i = 0; i < 17; i++) {
            const id = randomUUID();
            await repo.enqueue({
              id,
              conversation,
              sender: 'me',
              group: false,
              text: `history turn ${i}`,
            });
            const job = (await repo.claim(id, 45000))!;
            await repo.finalize(job, {
              text: `reply ${i}`,
              trace: {
                runId: id,
                model: 'fixture',
                promptVersion: 'fixture',
                durationMs: 1,
                stages: [],
                outcome: 'completed',
              },
            });
          }
          const anchorId = randomUUID();
          await repo.enqueue({
            id: anchorId,
            conversation,
            sender: 'me',
            group: false,
            text: 'current message',
          });
          const anchor = (await repo.claim(anchorId, 45000))!;
          const history = await repo.history(anchor);
          assert.equal(history.length, 32);
          assert.equal(history[0]?.content, 'history turn 1');
          assert.equal(history.at(-1)?.content, 'reply 16');
          assert.deepEqual(await repo.history({ ...anchor, conversation: randomUUID() }), []);
          assert.deepEqual(await repo.history({ ...anchor, sender: 'teammate' }), []);
        },
      );
      await t.test(
        'stale leases cannot append receipts or finalize, and failed handoff rolls back',
        async () => {
          const input = {
            id: randomUUID(),
            conversation: 'fenced',
            sender: 'me' as const,
            group: false,
            text: 'fixture',
          };
          await repo.enqueue(input);
          const old = (await repo.claim(input.id, 45000))!;
          await repo.record(old, 'tool_started', { synthetic: true });
          await database.admin.query(
            'UPDATE public."ramesh-test-inbound-queue" SET lease_until=clock_timestamp()-interval \'1 second\' WHERE id=$1',
            [input.id],
          );
          const current = (await repo.claim(input.id, 45000))!;
          await assert.rejects(repo.record(old, 'tool_succeeded', {}), /LEASE_EXPIRED/);
          const value = {
            text: 'captured',
            trace: {
              runId: input.id,
              model: 'fixture',
              promptVersion: 'test',
              durationMs: 0,
              stages: [],
              outcome: 'completed' as const,
            },
          };
          await assert.rejects(repo.finalize(old, value), /LEASE_EXPIRED/);
          await database.admin.query(
            'REVOKE INSERT ON public."ramesh-test-outbound-queue" FROM ramesh_playground',
          );
          try {
            await assert.rejects(repo.finalize(current, value), /permission denied/);
          } finally {
            await database.admin.query(
              'GRANT INSERT ON public."ramesh-test-outbound-queue" TO ramesh_playground',
            );
          }
          assert.equal(
            (
              await database.admin.query(
                'SELECT state FROM public."ramesh-test-inbound-queue" WHERE id=$1',
                [input.id],
              )
            ).rows[0].state,
            'PROCESSING',
          );
          await repo.finalize(current, value);
          await assert.rejects(
            pool!.query(
              'UPDATE public."ramesh-test-outbound-queue" SET transport=\'baileys\' WHERE message_id=$1',
              [input.id],
            ),
            /check constraint/,
          );
          await assert.rejects(
            pool!.query('DELETE FROM public."ramesh-test-agent-events"'),
            /permission denied/,
          );
          await database.admin.query(
            'UPDATE public."ramesh-test-inbound-queue" SET created_at=clock_timestamp()-interval \'25 hours\' WHERE id=$1',
            [input.id],
          );
          await repo.clean();
          assert.equal(await repo.output(input.id), null);
          assert.equal(
            (
              await database.admin.query(
                'SELECT 1 FROM public."ramesh-test-agent-events" WHERE message_id=$1',
                [input.id],
              )
            ).rowCount,
            0,
          );
        },
      );
      await chat.drain();
    } finally {
      await pool?.end();
      await database.close();
    }
  },
);
