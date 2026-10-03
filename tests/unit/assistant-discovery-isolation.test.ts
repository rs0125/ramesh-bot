/** Local tool discovery failure must not turn independent personal work into an outage. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { AssistantService } from '../../src/modules/assistant/assistant.service.js';
import type { TextModel } from '../../src/modules/assistant/assistant.types.js';
import {
  PersonalToolService,
  type PersonalRepositoryPort,
} from '../../src/modules/scheduling/personal-tools.js';
import type { PersonalCommandReceipt } from '../../src/modules/scheduling/scheduling.types.js';
import { BusinessWriteService } from '../../src/modules/writes/write-tools.js';
import type { WriteRepositoryPort } from '../../src/modules/writes/write.types.js';
import { getPersonalDelivery } from '../../src/modules/messaging/delivery-evidence.js';

test('actual write catalogue failure still allows an independently authorized personal commit', async () => {
  const now = Date.now(),
    actor = { employeeId: 7, phoneE164: '+919000000007', chatId: '919000000007@s.whatsapp.net' };
  const source = {
    id: randomUUID(),
    text: 'Add a task to call Acme',
    receivedAtMs: now,
    forwarded: false,
    kind: 'text',
    currentTurn: true,
  };
  const trusted = {
    runId: randomUUID(),
    key: { remoteJid: actor.chatId },
    checkpointLease: { leaseToken: randomUUID() },
    commandMessages: [source],
  };
  let committed: PersonalCommandReceipt | null = null;
  let commitCount = 0,
    discoveryCalls = 0;
  const personal = new PersonalToolService(
    {
      async getReceipt() {
        return committed;
      },
      async saveContext() {},
      async applyBatch(ctx, operations) {
        commitCount++;
        assert.equal(operations[0]?.kind, 'task_create');
        committed = {
          commandId: randomUUID(),
          runId: ctx.runId,
          records: [
            {
              kind: 'task',
              id: randomUUID(),
              text: 'call Acme',
              state: 'open',
              version: 1,
              createdAt: new Date(now).toISOString(),
              updatedAt: new Date(now).toISOString(),
            },
          ],
        };
        return committed;
      },
      async list() {
        assert.fail('No list requested');
      },
      async recall() {
        assert.fail('No recall requested');
      },
      async resolveSelection() {
        assert.fail('No existing selection used');
      },
      async finalizeSelections() {},
    } satisfies PersonalRepositoryPort,
    async () => actor,
    () => now,
  );
  const writes = new BusinessWriteService(
    {
      async authorizeSource() {
        return source;
      },
      async findByRun() {
        return null;
      },
    } as unknown as WriteRepositoryPort,
    async () => ({
      actor,
      writer: {
        employeeId: actor.employeeId,
        async describe() {
          discoveryCalls++;
          throw new Error('context engine unavailable');
        },
        async discover() {
          assert.fail('No write dispatch');
        },
        async call() {
          assert.fail('No remote write requested');
        },
      },
    }),
    () => now,
  );
  const output = (text: string) => ({ text, inputTokens: 0, outputTokens: 0 });
  const model: TextModel = {
    async complete(request) {
      if (request.stage === 'converser')
        return output(
          JSON.stringify({
            route: 'work',
            workflow: 'personal',
            objective: source.text,
            reply: '',
          }),
        );
      if (request.stage === 'verifier')
        return output(JSON.stringify({ supported: true, feedback: '', repair: 'none' }));
      assert.fail(`Unexpected stage ${request.stage}`);
    },
    startToolSession(request) {
      assert.ok(request.tools.some((tool) => tool.name === 'personal_apply'));
      assert.ok(!request.tools.some((tool) => tool.name === 'write_history'));
      let count = 0;
      return {
        async next() {
          return {
            ...output(''),
            calls:
              count++ === 0
                ? [
                    {
                      id: 'personal',
                      name: 'personal_apply',
                      arguments: JSON.stringify({
                        operations: [
                          {
                            kind: 'task_create',
                            text: 'call Acme',
                            source: { messageId: source.id, quote: source.text },
                          },
                        ],
                      }),
                    },
                  ]
                : [],
          };
        },
        accept(_id, value) {
          assert.equal((value as { ok: boolean }).ok, true);
        },
      };
    },
  };
  const assistant = new AssistantService(
    { model: 'no-provider', timeoutMs: 5000 },
    model,
    undefined,
    undefined,
    undefined,
    undefined,
    { personalTools: personal, businessWrites: writes },
  );
  const reply = await assistant.prepare(
    {
      chatId: actor.chatId,
      messageId: source.id,
      text: source.text,
      sentAtMs: now,
      fromMe: false,
      isGroup: false,
      mentionsBot: false,
    },
    undefined,
    trusted,
  );
  assert.equal(discoveryCalls, 1);
  assert.equal(commitCount, 1);
  assert.match(reply.text, /Saved task: call Acme/);
  assert.ok(getPersonalDelivery(reply.businessEvidence)?.commandId);
});
