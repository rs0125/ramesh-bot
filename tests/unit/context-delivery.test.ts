/** Real preparation and durable consumer, synthetic queue and capture-only WhatsApp transport. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { WAMessage } from '@whiskeysockets/baileys';
import { contextFixture, contextId, CONTEXT_CHAT } from '../fixtures/chat-context.js';
import { DurableMessages } from '../../src/infrastructure/whatsapp/durable-messages.js';
import { toGreetingCandidate } from '../../src/infrastructure/whatsapp/message.mapper.js';
import type { MessageJob } from '../../src/infrastructure/database/message-queue.repository.js';
import {
  authorizeDelivery,
  contextDeliveryBundle,
  getPersonalDelivery,
  getWriteDelivery,
  writeDeliveryBundle,
  compositeDeliverySchema,
} from '../../src/modules/messaging/delivery-evidence.js';
import { toolDeliverySchema } from '../../src/modules/assistant/tool-evidence.js';

async function deliver(f: ReturnType<typeof contextFixture>, afterHandoff = () => {}) {
  const stop = new AbortController();
  const timeout = setTimeout(() => stop.abort(), 5000);
  let stored: MessageJob | undefined,
    inboundClaimed = false,
    outboundClaimed = false;
  let terminal: string | undefined,
    preflights = 0;
  const sent: string[] = [];
  const queue = new DurableMessages(
    {
      async enqueue(id, _candidate, payload) {
        stored = {
          id,
          payload,
          direction: 'inbound',
          token: 'synthetic-lease',
          attempts: 1,
          receivedAt: new Date(),
        };
        return 'queued';
      },
      async claimInbound() {
        if (inboundClaimed) return null;
        inboundClaimed = true;
        return stored!;
      },
      async beginAgentRun() {
        return true;
      },
      async recordAgentEvent() {},
      async handoff(_job, replyPayload, _at, evidence) {
        stored = {
          ...stored!,
          direction: 'outbound',
          replyPayload,
          replyKind: evidence ? 'business' : 'conversation',
          businessEvidence: evidence,
        };
        afterHandoff();
        return true;
      },
      async claimOutbound() {
        if (stored?.direction !== 'outbound' || outboundClaimed) return null;
        outboundClaimed = true;
        return stored;
      },
      async replaceWithDeliveryNotice(_job, replyPayload) {
        stored = {
          ...stored!,
          replyPayload,
          replyKind: 'conversation',
          businessEvidence: undefined,
        };
        return true;
      },
      async beginSend() {
        return true;
      },
      async complete(_job, state) {
        terminal = state;
        stop.abort();
        return true;
      },
      async releaseUnsent() {
        terminal = 'RELEASED';
        stop.abort();
      },
    },
    {
      encryptionKey: randomBytes(32).toString('base64url'),
      agentRuns: true,
      maxAgeMs: 300000,
      capacity: 5,
      leaseMs: 90000,
      pollMs: 5,
      waitBeforeReply: async () => true,
      businessPreflight: async (message, evidence, signal) => {
        preflights++;
        return authorizeDelivery(evidence, {
          context: (receipt) => f.context.canDeliver(message.key, receipt, signal),
        });
      },
      prepareReply: f.service.prepare.bind(f.service),
    },
  );
  const original: WAMessage = {
    key: { id: contextId(100), remoteJid: CONTEXT_CHAT },
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: { conversation: '/pins' },
  };
  try {
    await queue.enqueue(original, toGreetingCandidate(original, [])!);
    await queue.consume(
      {
        botJids: [],
        on: () => () => {},
        async close() {},
        async saveCredentials() {},
        async reply(_message, text) {
          sent.push(text);
        },
      },
      stop.signal,
      () => {},
    );
  } finally {
    clearTimeout(timeout);
  }
  return { sent, terminal, preflights };
}

test('private pins require current delivery identity, including revocation and changed owner attributes', async (t) => {
  for (const mode of ['same', 'revoked', 'reassigned', 'changed_email'] as const)
    await t.test(mode, async () => {
      const f = contextFixture();
      await f.context.prepare(...f.turn(1, '/pin private: OWNER_ONE_PRIVATE_NOTE'));
      const result = await deliver(f, () => {
        if (mode === 'revoked') f.revoke();
        if (mode === 'reassigned') f.reassign();
        if (mode === 'changed_email') f.reassign(1, 'new-owner@example.test');
      });
      assert.equal(result.preflights, 1);
      assert.equal(result.terminal, 'SENT');
      assert.equal(result.sent.length, 1);
      assert.equal(result.sent[0]!.includes('OWNER_ONE_PRIVATE_NOTE'), mode === 'same');
    });
});

test('mixed memory/write/personal/business receipts preserve every authorization and handoff obligation', async () => {
  const f = contextFixture();
  const memory = { ...f.original, chatId: CONTEXT_CHAT };
  const personal = {
    kind: 'personal' as const,
    version: 1 as const,
    employeeId: 1,
    phoneE164: '+20000000000',
    runId: 'run',
    commandId: 'committed-personal-command',
  };
  const business = toolDeliverySchema.parse({
    kind: 'context_tools',
    version: 1,
    employeeId: 1,
    localDate: '2026-10-05',
    preparedAt: '2026-10-05T00:00:00Z',
    expiresAt: '2026-10-05T00:05:00Z',
    checks: [{ tool: 'read_warehouse', arguments: { id: 1 }, fingerprint: 'a'.repeat(64) }],
  });
  const mixed = compositeDeliverySchema.parse({
    kind: 'composite',
    version: 1,
    personal,
    business,
    businessText: 'Private business result.',
  });
  const write = {
    kind: 'business_write' as const,
    version: 1 as const,
    employeeId: 1,
    phoneE164: '+20000000000',
    chatId: CONTEXT_CHAT,
    runId: 'run',
    operations: [{ id: '11111111-1111-4111-8111-111111111111', version: 1 }],
    tools: ['update_crm_lead'],
    expiresAt: '2026-10-05T00:05:00Z',
  };
  const receipt = contextDeliveryBundle(
    memory,
    writeDeliveryBundle(write, mixed, 'Private result.'),
  );
  assert.deepEqual(getWriteDelivery(receipt), write);
  assert.deepEqual(getPersonalDelivery(receipt), personal);
  for (const deny of ['none', 'context', 'write', 'personal', 'business']) {
    const calls: string[] = [];
    const check = async (name: string) => {
      calls.push(name);
      return deny !== name;
    };
    const allowed = await authorizeDelivery(receipt, {
      context: () => check('context'),
      write: () => check('write'),
      personal: () => check('personal'),
      business: () => check('business'),
    });
    assert.equal(allowed, deny === 'none');
    const order = ['context', 'write', 'personal', 'business'];
    assert.deepEqual(
      calls,
      deny === 'none' ? [...order, 'context'] : order.slice(0, order.indexOf(deny) + 1),
    );
  }
  assert.equal(await authorizeDelivery(receipt, { business: async () => true }), false);
  assert.equal(
    await authorizeDelivery(
      { ...receipt, context: { ...memory, owner: 'invalid' } },
      {
        context: async () => true,
        business: async () => true,
      },
    ),
    false,
  );
  assert.throws(() => contextDeliveryBundle(memory, { ...personal, employeeId: 2 }));
  assert.equal(
    await f.context.canDeliver(
      { remoteJid: '30000000000@s.whatsapp.net' },
      memory,
      AbortSignal.timeout(1000),
    ),
    false,
  );
  assert.equal(
    await authorizeDelivery(contextDeliveryBundle(memory, business), {
      context: (binding) =>
        f.context.canDeliver({ remoteJid: CONTEXT_CHAT }, binding, AbortSignal.timeout(1000)),
      business: async () => {
        f.reassign();
        return true;
      },
    }),
    false,
    'owner changes during remote preflight are caught before delivery',
  );
});
