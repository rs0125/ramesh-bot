/** Generic write orchestration: synthetic tools/models, no remote writes or paid calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AssistantService } from '../../src/modules/assistant/assistant.service.js';
import {
  ConversationMemory,
  PRIVATE_HISTORY_REPLY,
} from '../../src/modules/assistant/conversation-memory.js';
import {
  getWriteDelivery,
  getPersonalDelivery,
} from '../../src/modules/messaging/delivery-evidence.js';
import type { BusinessReadService } from '../../src/modules/assistant/business-reads.js';
import type { TrustedReplyContext } from '../../src/modules/greetings/greeting.types.js';
import type { AgentCheckpointStore } from '../../src/modules/assistant/checkpoint.types.js';
import { CheckpointError } from '../../src/modules/assistant/checkpoint.types.js';
import { buildSalesGraph } from '../../src/modules/assistant/sales.graph.js';
import type {
  ModelRequest,
  TextModel,
  ToolSessionRequest,
} from '../../src/modules/assistant/assistant.types.js';
import type { ContextToolRun } from '../../src/modules/assistant/tool-executor.js';
import type { ToolDelivery, ToolEvidence } from '../../src/modules/assistant/tool-evidence.js';
import type {
  BusinessWriteReply,
  BusinessWriteRun,
  BusinessWriteService,
} from '../../src/modules/writes/write-tools.js';
import type {
  PersonalToolRun,
  PersonalToolService,
} from '../../src/modules/scheduling/personal-tools.js';

const now = Date.parse('2026-10-03T06:00:00Z');
const output = (text: string) => ({ text, inputTokens: 1, outputTokens: 1 });
const definition = (name: string) => ({
  name,
  description: `Synthetic ${name}`,
  inputSchema: { type: 'object', additionalProperties: false },
});
const writeDefinition = definition('create_example_record');
const exact = { name: 'Example reference', latitude: 0, longitude: 78.125 };
const input = {
  input: 'Check the reference, prepare the requested new record and give me the read result.',
  history: [],
  audience: 'dm' as const,
};
const receipt: BusinessWriteReply['delivery'] = {
  kind: 'business_write',
  version: 1,
  employeeId: 7,
  phoneE164: '+919999000111',
  chatId: '919999000111@s.whatsapp.net',
  runId: 'synthetic-write-run',
  operations: [{ id: 'd0aeeef7-de82-4e99-a39a-d7c41a7e53b0', version: 2 }],
  tools: [writeDefinition.name],
  expiresAt: '2099-01-01T00:00:00.000Z',
};
const events: string[] = [];

function writeRun(
  options: {
    employeeId?: number;
    historyOnly?: boolean;
    failFinalize?: boolean;
    executionMode?: 'direct_request' | 'confirmation';
  } = {},
) {
  let staged: Record<string, unknown> | undefined;
  let usedPrivateData = false;
  const evidence: unknown[] = [];
  const invocations: unknown[] = [];
  let finalized = 0;
  const preview = () =>
    staged
      ? `Proposed create_example_record\n${JSON.stringify(staged)}\nNot yet saved.`
      : undefined;
  const run = {
    employeeId: options.employeeId ?? 7,
    tools: [writeDefinition, definition('write_history')],
    remaining: 8,
    blocked: false,
    context: 'Authenticated tool metadata determines the write execution policy.',
    pendingExecutionMode: options.executionMode ?? 'confirmation',
    evidence,
    failures: [],
    get usedPrivateData() {
      return usedPrivateData;
    },
    deliveryReference: receipt,
    hasTool(name: string) {
      return this.tools.some((tool) => tool.name === name);
    },
    async execute(name: string, raw: string) {
      events.push(`stage:${name}`);
      const args = JSON.parse(raw);
      invocations.push({ name, args });
      this.remaining--;
      if (name === 'write_history') {
        usedPrivateData = true;
        const result = {
          ok: true,
          records: [{ state: 'SUCCEEDED', name: 'Private historical example' }],
        };
        evidence.push(result);
        return result;
      }
      staged = args;
      const result = { ok: true, status: 'draft_not_confirmable', arguments: args };
      evidence.splice(0, evidence.length, result);
      return result;
    },
    preview,
    async finalize() {
      finalized++;
      events.push(options.executionMode === 'direct_request' ? 'dispatch' : 'publish');
      if (options.failFinalize) throw new Error('AUTHORIZATION_CHANGED');
      return staged
        ? {
            text:
              options.executionMode === 'direct_request'
                ? 'Saved the requested record.'
                : `${preview()}\nReply confirm ABC123.`,
            delivery: receipt,
          }
        : undefined;
    },
  };
  return { run: run as unknown as BusinessWriteRun, invocations, finalized: () => finalized };
}

function readRun(employeeId = 7) {
  const evidence: ToolEvidence[] = [];
  const readCalls: string[] = [];
  const delivery: ToolDelivery = {
    kind: 'context_tools',
    version: 1,
    employeeId,
    localDate: '2026-10-03',
    preparedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60000).toISOString(),
    checks: [{ tool: 'read_example_reference', arguments: {}, fingerprint: 'a'.repeat(64) }],
  };
  const run = {
    employeeId,
    tools: [definition('read_example_reference')],
    evidence,
    context: {},
    guidance: '',
    remaining: 8,
    blocked: false,
    pagination: [],
    failures: [],
    retiredEvidenceIds: [],
    internalCrmIds: [],
    async execute(name: string) {
      readCalls.push(name);
      events.push(`read:${name}`);
      const result = { ok: true, data: exact, meta: {} };
      evidence.push({
        id: 'example-evidence',
        tool: name,
        arguments: {},
        result,
      } as unknown as ToolEvidence);
      return result;
    },
    delivery: () => (evidence.length ? delivery : undefined),
  };
  return { run: run as unknown as ContextToolRun, readCalls, delivery };
}

function model(
  calls: Array<{ name: string; args?: unknown }>,
  options: {
    approved?: boolean;
    supplement?: string;
    afterRejected?: { name: string; args: unknown };
  } = {},
) {
  const requests: ModelRequest[] = [];
  const sessions: ToolSessionRequest[] = [];
  let index = 0;
  let rejected = false;
  const fake: TextModel = {
    async complete(request) {
      requests.push(request);
      events.push(request.stage);
      if (request.stage === 'converser')
        return output(
          JSON.stringify({ route: 'work', workflow: 'general', objective: input.input, reply: '' }),
        );
      if (request.stage === 'planner') {
        const payload = JSON.parse(request.messages[0]!.content);
        return output(
          JSON.stringify({
            objective: input.input,
            successCriteria: ['Prepare a reviewed proposal without dispatch.'],
            steps: [
              {
                id: 'prepare',
                goal: input.input,
                dependsOn: [],
                toolNames: payload.tool_definitions.map((tool: { name: string }) => tool.name),
              },
            ],
          }),
        );
      }
      if (request.stage === 'verifier') {
        const approved = options.afterRejected ? rejected : options.approved !== false;
        rejected = true;
        return output(
          JSON.stringify({
            supported: approved,
            feedback: approved ? '' : 'Use the corrected name.',
            repair: options.afterRejected ? 'tools' : 'format',
          }),
        );
      }
      return output(
        request.jsonSchema
          ? JSON.stringify({ additional_reply: options.supplement ?? '' })
          : (options.supplement ?? 'The private historical example succeeded.'),
      );
    },
    startToolSession(request) {
      sessions.push(request);
      return {
        async next() {
          const call = calls[index];
          if (call) index++;
          return {
            ...output('Model prose must not replace the exact proposal.'),
            calls: call
              ? [{ id: String(index), name: call.name, arguments: JSON.stringify(call.args ?? {}) }]
              : [],
          };
        },
        accept() {},
        revise() {
          if (options.afterRejected) calls.push(options.afterRejected);
        },
      };
    },
  };
  return { fake, requests, sessions };
}

const payload = (requests: ModelRequest[], stage: string) =>
  JSON.parse(requests.find((request) => request.stage === stage)!.messages[0]!.content);

test('dynamic writes can follow reads but publish exact proposals only after independent review', async () => {
  events.length = 0;
  const writes = writeRun();
  const reads = readRun();
  const fake = model(
    [{ name: 'read_example_reference' }, { name: writeDefinition.name, args: exact }],
    { supplement: 'The reference is available.' },
  );
  const result = await buildSalesGraph(
    fake.fake,
    async () => ({ status: 'available', run: reads.run }),
    {
      writes: writes.run,
      now: () => now,
      onToolActivity: () => {
        events.push('tool_activity');
      },
    },
  ).invoke(input);
  assert.deepEqual(reads.readCalls, ['read_example_reference']);
  assert.deepEqual(writes.invocations, [{ name: writeDefinition.name, args: exact }]);
  assert.deepEqual(
    events.filter(
      (event) =>
        event === 'tool_activity' || event.startsWith('read:') || event.startsWith('stage:'),
    ),
    [
      'tool_activity',
      'tool_activity',
      'read:read_example_reference',
      'tool_activity',
      `stage:${writeDefinition.name}`,
    ],
  );
  assert.equal(writes.finalized(), 1);
  assert.ok(events.indexOf('verifier') < events.indexOf('publish'));
  assert.equal(
    result.reply,
    `The reference is available.\n\nProposed create_example_record\n${JSON.stringify(exact)}\nNot yet saved.\nReply confirm ABC123.`,
  );
  assert.equal(result.writeOtherText, 'The reference is available.');
  assert.equal(result.business?.delivery, reads.delivery);
  assert.deepEqual(
    payload(fake.requests, 'planner').tool_definitions.map((tool: { name: string }) => tool.name),
    ['read_example_reference', writeDefinition.name, 'write_history'],
  );
  assert.deepEqual(payload(fake.requests, 'verifier').business_write_evidence[0].arguments, exact);
  assert.equal(payload(fake.requests, 'verifier').evidence.length, 1);
  assert.equal(payload(fake.requests, 'verifier').business_write_execution_mode, 'confirmation');
});

test('direct writes dispatch after independent review and replace the unexecuted preview with the authoritative result', async () => {
  events.length = 0;
  const writes = writeRun({ executionMode: 'direct_request' });
  const reads = readRun();
  const fake = model([
    { name: 'read_example_reference' },
    { name: writeDefinition.name, args: exact },
  ]);
  const result = await buildSalesGraph(
    fake.fake,
    async () => ({ status: 'available', run: reads.run }),
    {
      writes: writes.run,
    },
  ).invoke(input);
  assert.equal(writes.finalized(), 1);
  assert.ok(events.indexOf('verifier') < events.indexOf('dispatch'));
  assert.equal(result.reply, 'Saved the requested record.');
  assert.doesNotMatch(result.reply, /confirm|Not yet saved|Proposed/i);
  assert.equal(result.write?.delivery, receipt);
  assert.deepEqual(reads.readCalls, ['read_example_reference']);
  assert.equal(
    result.business,
    undefined,
    'receipt-only delivery must not replay an old version invalidated by its own write',
  );
  assert.equal(payload(fake.requests, 'verifier').business_write_execution_mode, 'direct_request');
  assert.match(payload(fake.requests, 'verifier').answer, /Not yet saved/);
});

test('a separate read answer accompanying a direct write retains its full freshness checks', async () => {
  const writes = writeRun({ executionMode: 'direct_request' });
  const reads = readRun();
  const fake = model(
    [{ name: 'read_example_reference' }, { name: writeDefinition.name, args: exact }],
    {
      supplement: 'The reference is available.',
    },
  );
  const result = await buildSalesGraph(
    fake.fake,
    async () => ({ status: 'available', run: reads.run }),
    {
      writes: writes.run,
    },
  ).invoke(input);
  assert.equal(result.reply, 'The reference is available.\n\nSaved the requested record.');
  assert.equal(result.business?.delivery, reads.delivery);
  assert.equal(result.write?.delivery, receipt);
});

test('direct policy cannot bypass an unsuccessful verifier review', async () => {
  const writes = writeRun({ executionMode: 'direct_request' });
  const fake = model([{ name: writeDefinition.name, args: exact }], { approved: false });
  const result = await buildSalesGraph(fake.fake, async () => ({ status: 'denied' }), {
    writes: writes.run,
  }).invoke(input);
  assert.equal(writes.finalized(), 0);
  assert.equal(result.write, undefined);
  assert.doesNotMatch(result.reply, /Saved the requested record|78\.125/);
});

test('rejected proposals never become confirmable and their exact data is withheld', async () => {
  const writes = writeRun();
  const fake = model([{ name: writeDefinition.name, args: exact }], { approved: false });
  const result = await buildSalesGraph(fake.fake, async () => ({ status: 'denied' }), {
    writes: writes.run,
  }).invoke(input);
  assert.equal(writes.finalized(), 0);
  assert.equal(result.write, undefined);
  assert.doesNotMatch(result.reply, /ABC123|78\.125|Example reference/);
  assert.equal(result.unavailable, true);
});

test('review repairs replace the draft and publish only the final verified arguments', async () => {
  const writes = writeRun();
  const corrected = { ...exact, name: 'Corrected example' };
  const fake = model([{ name: writeDefinition.name, args: exact }], {
    afterRejected: { name: writeDefinition.name, args: corrected },
  });
  const result = await buildSalesGraph(fake.fake, async () => ({ status: 'denied' }), {
    writes: writes.run,
  }).invoke(input);
  assert.equal(writes.invocations.length, 2);
  assert.equal(writes.finalized(), 1);
  assert.match(result.reply, /Corrected example/);
  assert.doesNotMatch(result.reply, /Example reference/);
});

test('identity disagreement fails before any model or tool is exposed', async () => {
  const writes = writeRun({ employeeId: 8 });
  const fake = model([]);
  await assert.rejects(
    buildSalesGraph(fake.fake, async () => ({ status: 'available', run: readRun().run }), {
      writes: writes.run,
    }).invoke(input),
    /WRITE_IDENTITY_CHANGED/,
  );
  assert.equal(fake.requests.length, 0);
  assert.equal(writes.invocations.length, 0);
});

test('private write history protects synthesized prose without duplicating or substituting it', async () => {
  const writes = writeRun({ historyOnly: true });
  const fake = model([{ name: 'write_history' }], {
    supplement: 'The private historical example succeeded.',
  });
  const result = await buildSalesGraph(fake.fake, async () => ({ status: 'denied' }), {
    writes: writes.run,
  }).invoke(input);
  assert.equal(result.reply, 'The private historical example succeeded.');
  assert.equal(result.write?.text, '');
  assert.equal(result.write?.delivery, receipt);
  assert.equal(result.writeOtherText, '');
});

test('mixed personal result, read answer and business proposal keep independent receipts', async () => {
  const writes = writeRun();
  const reads = readRun();
  const personalReceipt = {
    kind: 'personal' as const,
    version: 1 as const,
    employeeId: 7,
    phoneE164: '+919999000111',
    runId: 'personal-test',
  };
  const personal = {
    employeeId: 7,
    tools: [],
    remaining: 0,
    context: 'Personal test result.',
    evidence: [],
    failures: [],
    blocked: false,
    pendingOperations: [],
    usedPrivateData: true,
    usedPrivateReads: false,
    deliveryReference: personalReceipt,
    hasTool: () => false,
    preview: () => 'Proposed personal task.',
    saveContext: async () => {},
    finish: async () => ({ text: 'Task saved: review the lease.', delivery: personalReceipt }),
  } as unknown as PersonalToolRun;
  const fake = model(
    [{ name: 'read_example_reference' }, { name: writeDefinition.name, args: exact }],
    { supplement: 'The reference is available.' },
  );
  const result = await buildSalesGraph(
    fake.fake,
    async () => ({ status: 'available', run: reads.run }),
    { writes: writes.run, personal },
  ).invoke(input);
  assert.match(
    result.reply,
    /^The reference is available\.\n\nTask saved: review the lease\.\n\nProposed create_example_record/,
  );
  assert.equal(result.composite?.businessText, 'The reference is available.');
  assert.equal(result.composite?.personal.runId, 'personal-test');
  assert.equal(
    result.writeOtherText,
    'The reference is available.\n\nTask saved: review the lease.',
  );
});

test('publication authorization failure never returns a confirmable model-generated proposal', async () => {
  const writes = writeRun({ failFinalize: true });
  const fake = model([{ name: writeDefinition.name, args: exact }]);
  await assert.rejects(
    buildSalesGraph(fake.fake, async () => ({ status: 'denied' }), { writes: writes.run }).invoke(
      input,
    ),
    /AUTHORIZATION_CHANGED/,
  );
});

test('private write tools are never exposed in a group even if a caller passes a run', async () => {
  const writes = writeRun();
  const fake = model([]);
  await assert.rejects(
    buildSalesGraph(fake.fake, async () => ({ status: 'denied' }), { writes: writes.run }).invoke({
      ...input,
      audience: 'group',
    }),
    /WRITE_AUDIENCE_NOT_ALLOWED/,
  );
  assert.equal(fake.requests.length, 0);
});

test('an oversize exact proposal is rejected before publication instead of truncating arguments', async () => {
  const writes = writeRun();
  const fake = model([
    { name: writeDefinition.name, args: { ...exact, notes: 'x'.repeat(16000) } },
  ]);
  await assert.rejects(
    buildSalesGraph(fake.fake, async () => ({ status: 'denied' }), { writes: writes.run }).invoke(
      input,
    ),
    /Invalid sales reply/,
  );
  assert.equal(writes.finalized(), 0);
});

const message = {
  chatId: receipt.chatId,
  messageId: 'direct-write-message',
  sentAtMs: now,
  text: input.input,
  fromMe: false,
  isGroup: false,
  mentionsBot: false,
};
const trusted: TrustedReplyContext = {
  key: { remoteJid: receipt.chatId },
  runId: receipt.runId,
  checkpointLease: { leaseToken: 'test-live-lease' },
  commandMessages: [
    { id: message.messageId, text: message.text, receivedAtMs: now, forwarded: false },
  ],
};

test('direct confirmation recovery runs before checkpoint/model and never opens a second proposal session', async () => {
  let recovered = 0;
  const service = {
    async recover(value: TrustedReplyContext) {
      recovered++;
      assert.equal(value, trusted);
      return { text: 'Saved: synthetic record.', delivery: receipt };
    },
    async open() {
      assert.fail('Recovered commands must not open a model session');
    },
  } as unknown as BusinessWriteService;
  const assistant = new AssistantService(
    { model: 'offline-write-fake', timeoutMs: 5000 },
    {
      async complete() {
        assert.fail('Recovery must not use a model');
      },
    },
    undefined,
    undefined,
    undefined,
    undefined,
    {
      businessWrites: service,
      checkpoints: {
        async begin() {
          assert.fail('Recovery precedes an expired checkpoint');
        },
      } as unknown as AgentCheckpointStore,
    },
  );
  const reply = await assistant.prepare(message, undefined, trusted);
  assert.equal(recovered, 1);
  assert.equal(reply.text, 'Saved: synthetic record.');
  assert.deepEqual(getWriteDelivery(reply.businessEvidence), receipt);
  assert.equal(reply.trace.stages.length, 0);
});

test('assistant protects proposal text while recalling only the separate verified read answer', async () => {
  const writes = writeRun();
  const reads = readRun();
  const fake = model(
    [{ name: 'read_example_reference' }, { name: writeDefinition.name, args: exact }],
    { supplement: 'The reference is available.' },
  );
  const memory = new ConversationMemory(() => now);
  const service = {
    async recover() {
      return undefined;
    },
    async open() {
      return writes.run;
    },
  } as unknown as BusinessWriteService;
  const business = {
    toolLoop: true,
    async openTools() {
      return { status: 'available', run: reads.run };
    },
  } as unknown as BusinessReadService;
  const assistant = new AssistantService(
    { model: 'offline-write-fake', timeoutMs: 5000 },
    fake.fake,
    memory,
    undefined,
    undefined,
    business,
    { now: () => now, businessWrites: service },
  );
  const reply = await assistant.prepare(message, undefined, trusted);
  assert.equal(reply.trace.outcome, 'completed');
  assert.deepEqual(getWriteDelivery(reply.businessEvidence), receipt);
  await reply.onSent?.();
  const saved = memory.get(createHash('sha256').update(message.chatId).digest('hex')).at(-1)!;
  assert.equal(saved.content, PRIVATE_HISTORY_REPLY);
  assert.equal(saved.protectedReply?.text, 'The reference is available.');
  assert.doesNotMatch(JSON.stringify(saved), /ABC123|78\.125|Proposed create/);
});

test('assistant never recalls private write-history prose using business read permission alone', async () => {
  const writes = writeRun({ historyOnly: true });
  const reads = readRun();
  const fake = model([{ name: 'read_example_reference' }, { name: 'write_history' }], {
    supplement: 'The private historical example succeeded.',
  });
  const memory = new ConversationMemory(() => now);
  const service = {
    async recover() {
      return undefined;
    },
    async open() {
      return writes.run;
    },
  } as unknown as BusinessWriteService;
  const business = {
    toolLoop: true,
    async openTools() {
      return { status: 'available', run: reads.run };
    },
  } as unknown as BusinessReadService;
  const assistant = new AssistantService(
    { model: 'offline-write-fake', timeoutMs: 5000 },
    fake.fake,
    memory,
    undefined,
    undefined,
    business,
    { now: () => now, businessWrites: service },
  );
  const reply = await assistant.prepare(message, undefined, trusted);
  assert.equal(reply.text, 'The private historical example succeeded.');
  assert.deepEqual(getWriteDelivery(reply.businessEvidence), receipt);
  await reply.onSent?.();
  const saved = memory.get(createHash('sha256').update(message.chatId).digest('hex')).at(-1)!;
  assert.equal(saved.content, PRIVATE_HISTORY_REPLY);
  assert.equal(saved.protectedReply, undefined);
});

test('mixed crash recovery retains both authoritative receipts before checkpoint or model work', async () => {
  const personalDelivery = {
    kind: 'personal' as const,
    version: 1 as const,
    employeeId: receipt.employeeId,
    phoneE164: receipt.phoneE164,
    runId: trusted.runId!,
    commandId: 'committed-personal-command',
  };
  const calls: string[] = [];
  const writes = {
    async recover() {
      calls.push('write-recover');
      return { text: 'Review the pending business change.', delivery: receipt };
    },
    async open() {
      assert.fail('Recovery must not start another write session');
    },
  } as unknown as BusinessWriteService;
  const personal = {
    async open() {
      calls.push('personal-open');
      return {
        employeeId: receipt.employeeId,
        async recover() {
          calls.push('personal-recover');
          return { text: 'Task saved: check the lease.', delivery: personalDelivery };
        },
      };
    },
  } as unknown as PersonalToolService;
  const assistant = new AssistantService(
    { model: 'offline-write-fake', timeoutMs: 5000 },
    {
      async complete() {
        assert.fail('Durable recovery must not use a model');
      },
    },
    undefined,
    undefined,
    undefined,
    undefined,
    {
      businessWrites: writes,
      personalTools: personal,
      checkpoints: {
        async begin() {
          assert.fail('Recovery must not reopen an expired checkpoint');
        },
      } as unknown as AgentCheckpointStore,
    },
  );
  const reply = await assistant.prepare(message, undefined, trusted);
  assert.equal(reply.text, 'Task saved: check the lease.\n\nReview the pending business change.');
  assert.deepEqual(getWriteDelivery(reply.businessEvidence), receipt);
  assert.deepEqual(getPersonalDelivery(reply.businessEvidence), personalDelivery);
  assert.deepEqual(calls, ['write-recover', 'personal-open', 'personal-recover']);
  assert.equal(reply.trace.stages.length, 0);
});

test('business recovery survives unrelated personal lookup failure without losing its receipt', async () => {
  for (const failureAt of ['open', 'recover']) {
    const assistant = new AssistantService(
      { model: 'offline-write-fake', timeoutMs: 5000 },
      {
        async complete() {
          assert.fail('Recovered writes must not call a model');
        },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      {
        businessWrites: {
          async recover() {
            return { text: 'Saved: synthetic record.', delivery: receipt };
          },
          async open() {
            assert.fail('No new proposal session after recovery');
          },
        } as unknown as BusinessWriteService,
        personalTools: {
          async open() {
            if (failureAt === 'open') throw new Error('personal unavailable');
            return {
              employeeId: receipt.employeeId,
              async recover() {
                throw new Error('personal unavailable');
              },
            };
          },
        } as unknown as PersonalToolService,
      },
    );
    const reply = await assistant.prepare(message, undefined, trusted);
    assert.equal(reply.text, 'Saved: synthetic record.');
    assert.deepEqual(getWriteDelivery(reply.businessEvidence), receipt);
    assert.equal(reply.trace.stages.length, 0);
  }
});

test('optional write discovery outage leaves independently authorized reads available', async () => {
  const reads = readRun();
  const fake = model([{ name: 'read_example_reference' }], {
    supplement: 'The reference is available.',
  });
  const assistant = new AssistantService(
    { model: 'offline-write-fake', timeoutMs: 5000 },
    fake.fake,
    undefined,
    undefined,
    undefined,
    {
      toolLoop: true,
      async openTools() {
        return { status: 'available', run: reads.run };
      },
    } as unknown as BusinessReadService,
    {
      businessWrites: {
        async recover() {
          return undefined;
        },
        async open() {
          throw new Error('write catalogue unavailable');
        },
      } as unknown as BusinessWriteService,
    },
  );
  const reply = await assistant.prepare(message, undefined, trusted);
  assert.equal(reply.text, 'The reference is available.');
  assert.deepEqual(reads.readCalls, ['read_example_reference']);
  assert.equal(getWriteDelivery(reply.businessEvidence), undefined);
});

test('write recovery and discovery isolation preserve caller cancellation and checkpoint failures', async () => {
  for (const stage of ['recover', 'open']) {
    for (const failure of ['abort', 'checkpoint']) {
      const controller = new AbortController();
      const fail = () => {
        if (failure === 'abort') {
          controller.abort();
          controller.signal.throwIfAborted();
        }
        throw new CheckpointError();
      };
      const assistant = new AssistantService(
        { model: 'offline-write-fake', timeoutMs: 5000 },
        {
          async complete() {
            assert.fail('No model after authority failure');
          },
        },
        undefined,
        undefined,
        undefined,
        undefined,
        {
          businessWrites: {
            async recover() {
              if (stage === 'recover') return fail();
              return undefined;
            },
            async open() {
              return fail();
            },
          } as unknown as BusinessWriteService,
        },
      );
      await assert.rejects(
        assistant.prepare(message, controller.signal, trusted),
        failure === 'abort' ? { name: 'AbortError' } : CheckpointError,
      );
    }
  }
});
