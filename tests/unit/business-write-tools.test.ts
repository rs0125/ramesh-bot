/** Application confirmation boundaries with a fake durable repository and fake remote writer. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BusinessWriteService } from '../../src/modules/writes/write-tools.js';
import {
  WriteStorageError,
  type WriteActor,
  type WriteCommandContext,
  type WriteOperation,
  type WriteRepositoryPort,
  type WriteSourceMessage,
} from '../../src/modules/writes/write.types.js';
import type {
  BoundContextWriter,
  ContextToolDefinition,
} from '../../src/modules/context-engine/context.types.js';
import type { TrustedReplyContext } from '../../src/modules/greetings/greeting.types.js';

const now = Date.parse('2026-10-03T06:00:00Z');
const actor: WriteActor = {
  employeeId: 7,
  phoneE164: '+919999000111',
  chatId: '919999000111@s.whatsapp.net',
};
const uuid = { type: 'string', format: 'uuid' };
function tool(
  name: string,
  effect: string,
  properties: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): ContextToolDefinition {
  return {
    name,
    description: `Synthetic ${name}`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { operation_id: uuid, ...properties },
      required: ['operation_id', ...Object.keys(properties)],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        operation_id: uuid,
        outcome: { type: 'string' },
        code: { type: 'string' },
        message: { type: 'string' },
        meta: { type: 'object', additionalProperties: false, properties: {} },
      },
      required: ['operation_id', 'outcome', 'code', 'message', 'meta'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: effect === 'compensate',
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: {
      'wareongo/context-write-v1': {
        requiredScopes: ['example:write'],
        sourceFamily: 'example',
        effect,
        idempotencyArgument: 'operation_id',
        ...extra,
      },
    },
  };
}
const create = tool(
  'create_example',
  'create',
  {
    name: { type: 'string', minLength: 1, maxLength: 200 },
  },
  { auditHistory: 'actor_scoped' },
);
const rollback = tool(
  'rollback_example',
  'compensate',
  { original_operation_id: uuid },
  {
    compensates: create.name,
    originalOperationArgument: 'original_operation_id',
    auditHistory: 'actor_scoped',
  },
);
const crm = tool('update_example_crm', 'update', {
  record_id: uuid,
  expected_version: { type: 'integer', minimum: 1 },
  stage: { type: 'string', enum: ['review', 'won'] },
});
const signal = () => AbortSignal.timeout(5000);

function harness() {
  const operations = new Map<string, WriteOperation>();
  const sources = new Map<string, WriteSourceMessage>();
  const calls: Array<{ tool: string; args: Record<string, unknown>; operationId: string }> = [];
  const proposals: WriteOperation[] = [];
  let definitions = [create, rollback, crm].map((t) => structuredClone(t));
  let currentActor = { ...actor };
  let allowed = true,
    capture = false,
    unknown = false,
    discoveryUnavailable = false;
  let approveCount = 0,
    publishCount = 0,
    discoveryCount = 0;
  const owned = (a: WriteActor, id: string) => {
    const op = operations.get(id);
    return op &&
      op.employeeId === a.employeeId &&
      op.phoneE164 === a.phoneE164 &&
      op.chatId === a.chatId
      ? structuredClone(op)
      : null;
  };
  const transition = (id: string, state: WriteOperation['state']) => {
    const value = operations.get(id)!;
    value.state = state;
    value.version++;
    return structuredClone(value);
  };
  const repository: WriteRepositoryPort = {
    async authorizeSource(ctx) {
      if (capture) throw new WriteStorageError('WRITE_LEASE_LOST');
      const source = sources.get(ctx.sourceMessageId);
      if (!source || source.forwarded !== false)
        throw new WriteStorageError('WRITE_DIRECT_SOURCE_REQUIRED');
      return structuredClone(source);
    },
    async readSources(_ctx, ids) {
      return [...sources.values()]
        .filter((s) => !ids || ids.includes(s.id))
        .map((s) => structuredClone(s));
    },
    async propose(ctx, payload) {
      const previous = [...operations.values()].find((op) => op.proposalRunId === ctx.runId);
      const id = previous?.operationId ?? randomUUID();
      const op: WriteOperation = {
        ...actor,
        operationId: id,
        accountId: 'test',
        state: 'DRAFT',
        version: (previous?.version ?? 0) + 1,
        payload: {
          ...structuredClone(payload),
          arguments: { ...payload.arguments, [payload.idempotencyArgument]: id },
        },
        confirmationCode: 'ABCDEF12',
        proposalRunId: ctx.runId,
        sourceMessageId: ctx.sourceMessageId,
        approvalRunId: null,
        approvalSourceMessageId: null,
        deliveryMode: 'production',
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 3600000).toISOString(),
        dispatchAttempts: 0,
        hasUncertainAttempt: false,
      };
      operations.set(id, op);
      proposals.push(structuredClone(op));
      return structuredClone(op);
    },
    async findByRun(ctx) {
      return [...operations.values()].find((op) => op.proposalRunId === ctx.runId) ?? null;
    },
    async publish(_ctx, id) {
      publishCount++;
      return transition(id, 'PROPOSED');
    },
    async findByCode(a, code) {
      const op = [...operations.values()].find((op) => op.confirmationCode === code);
      return op ? owned(a, op.operationId) : null;
    },
    async approve(ctx, id) {
      assert.notEqual(ctx.runId, operations.get(id)!.proposalRunId);
      approveCount++;
      const op = transition(id, 'APPROVED');
      operations.get(id)!.approvalRunId = ctx.runId;
      return op;
    },
    async claim(_ctx, id) {
      return { operation: transition(id, 'DISPATCHING'), dispatchToken: randomUUID() };
    },
    async finish(_ctx, id, _token, result) {
      const op = operations.get(id)!;
      op.result = structuredClone(result);
      op.hasUncertainAttempt ||= result.outcome === 'outcome_unknown';
      return transition(
        id,
        result.outcome === 'outcome_unknown'
          ? 'UNKNOWN'
          : result.outcome === 'created' ||
              result.outcome === 'replayed' ||
              result.outcome === 'rolled_back'
            ? 'SUCCEEDED'
            : 'REJECTED',
      );
    },
    async cancel(ctx, id, expectedVersion) {
      const operation = owned(ctx, id);
      if (!operation || operation.version !== expectedVersion)
        throw new WriteStorageError('WRITE_STATE_CONFLICT');
      if (
        !['DRAFT', 'PROPOSED', 'APPROVED'].includes(operation.state) ||
        operation.hasUncertainAttempt
      )
        throw new WriteStorageError('WRITE_CANNOT_CANCEL_DISPATCHED');
      return transition(id, 'CANCELLED');
    },
    async receiptLookup(a, id) {
      return owned(a, id);
    },
    async listRecent(a) {
      return [...operations.values()].flatMap((op) => {
        const result = owned(a, op.operationId);
        return result ? [result] : [];
      });
    },
    async auditRecent() {
      return [];
    },
  };
  const writer: BoundContextWriter = {
    get employeeId() {
      return currentActor.employeeId;
    },
    async discover() {
      discoveryCount++;
      if (discoveryUnavailable) throw new Error('Synthetic discovery outage');
      return structuredClone(definitions);
    },
    async describe() {
      discoveryCount++;
      if (discoveryUnavailable) throw new Error('Synthetic discovery outage');
      return { tools: structuredClone(definitions), context: {} };
    },
    async call(name, args, operationId) {
      calls.push({ tool: name, args: structuredClone(args), operationId });
      return {
        operation_id: operationId,
        outcome: unknown ? 'outcome_unknown' : name === rollback.name ? 'rolled_back' : 'created',
        code: unknown ? 'OUTCOME_UNKNOWN' : 'OK',
        message: 'Synthetic outcome.',
      };
    },
  };
  const service = new BusinessWriteService(
    repository,
    async () => (allowed ? { actor: { ...currentActor }, writer } : null),
    () => now,
  );
  function trusted(
    text: string,
    options: { forwarded?: boolean; kind?: string; extra?: string } = {},
  ): TrustedReplyContext {
    const id = randomUUID();
    const member = { id, text, receivedAtMs: now, forwarded: options.forwarded ?? false };
    sources.set(id, { ...member, kind: options.kind ?? 'text', currentTurn: true });
    return {
      runId: randomUUID(),
      key: { remoteJid: actor.chatId },
      checkpointLease: { leaseToken: randomUUID() },
      commandMessages: [
        member,
        ...(options.extra
          ? [{ id: randomUUID(), text: options.extra, receivedAtMs: now, forwarded: false }]
          : []),
      ],
    };
  }
  async function proposed() {
    const request = trusted('Save a point called Example.');
    const run = (await service.open(request, signal()))!;
    const result = await run.execute(create.name, JSON.stringify({ name: 'Example' }), signal());
    assert.equal((result as { ok: boolean }).ok, true);
    const reply = (await run.finalize(signal()))!;
    return { request, run, reply, operation: [...operations.values()].at(-1)! };
  }
  return {
    service,
    trusted,
    proposed,
    operations,
    calls,
    proposals,
    repository,
    sources,
    counts: () => ({ approveCount, publishCount, discoveryCount }),
    revoke: () => {
      allowed = false;
    },
    useCapture: () => {
      capture = true;
    },
    useUnknown: (value: boolean) => {
      unknown = value;
    },
    changeDefinitions: (next: ContextToolDefinition[]) => {
      definitions = structuredClone(next);
    },
    failDiscovery: () => {
      discoveryUnavailable = true;
    },
    changeActor: (next: WriteActor) => {
      currentActor = { ...next };
    },
  };
}

test('staging, reviewed publication and delivery checks never call the remote write port', async () => {
  const h = harness();
  const { request, run, reply, operation } = await h.proposed();
  assert.equal(h.calls.length, 0);
  assert.equal(operation.state, 'PROPOSED');
  assert.equal(h.counts().publishCount, 1);
  assert.equal(await h.service.canDeliver(request.key, reply.delivery, signal()), true);
  assert.equal(h.calls.length, 0);
  assert.equal(
    run.tools.find((t) => t.name === create.name)!.inputSchema.properties &&
      'operation_id' in
        (run.tools.find((t) => t.name === create.name)!.inputSchema.properties as object),
    false,
  );
  assert.match(reply.text, /Example/);
});

test('a later exact direct text confirmation dispatches frozen arguments once', async () => {
  const h = harness();
  const { operation } = await h.proposed();
  const confirmation = h.trusted('confirm ABCDEF12');
  const result = await h.service.recover(confirmation, signal());
  assert.match(result!.text, /^Saved:/);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]!.operationId, operation.operationId);
  assert.deepEqual(h.calls[0]!.args, operation.payload.arguments);
  await h.service.recover(confirmation, signal());
  assert.equal(h.calls.length, 1);
});

for (const unavailable of ['empty catalogue', 'discovery outage'] as const) {
  test(`local cancellation and its receipt remain available during ${unavailable}`, async () => {
    const h = harness();
    const { operation, reply: proposal } = await h.proposed();
    if (unavailable === 'empty catalogue') h.changeDefinitions([]);
    else h.failDiscovery();
    const before = h.counts().discoveryCount;
    const command = h.trusted('cancel ABCDEF12');
    const reply = await h.service.recover(command, signal());
    assert.ok(reply);
    assert.match(reply.text, /cancelled/i);
    assert.equal(h.operations.get(operation.operationId)!.state, 'CANCELLED');
    assert.equal(reply.delivery.localCancellation, true);
    assert.deepEqual(reply.delivery.tools, []);
    assert.deepEqual(reply.delivery.toolContracts, {});
    assert.deepEqual(reply.delivery.operations, [
      { id: operation.operationId, version: h.operations.get(operation.operationId)!.version },
    ]);
    assert.doesNotMatch(JSON.stringify(reply), /Example|create_example|arguments|summary/);
    assert.equal(await h.service.canDeliver(command.key, reply.delivery, signal()), true);
    const repeated = await h.service.recover(command, signal());
    assert.match(repeated!.text, /cancelled/i);
    assert.deepEqual(repeated!.delivery.operations, reply.delivery.operations);
    assert.equal(h.counts().discoveryCount, before);
    assert.equal(await h.service.canDeliver(command.key, proposal.delivery, signal()), false);
    assert.equal(h.calls.length, 0);
    assert.equal(h.counts().approveCount, 0);
  });
}

test('local cancellation remains actor-bound and cannot authorize delivery of a pending proposal', async () => {
  const h = harness();
  const { operation, reply: proposal } = await h.proposed();
  const command = h.trusted('cancel ABCDEF12');
  h.changeDefinitions([]);
  const forged = {
    ...proposal.delivery,
    localCancellation: true,
    tools: [],
    toolContracts: {},
  };
  assert.equal(await h.service.canDeliver(command.key, forged, signal()), false);
  h.changeActor({ ...actor, employeeId: actor.employeeId + 1 });
  const denied = await h.service.recover(command, signal());
  assert.match(denied!.text, /could not find/i);
  assert.deepEqual(denied!.delivery.operations, []);
  assert.equal(h.operations.get(operation.operationId)!.state, 'PROPOSED');
  h.changeActor(actor);
  const cancelled = await h.service.recover(command, signal());
  assert.ok(cancelled);
  assert.equal(
    await h.service.canDeliver(
      command.key,
      { ...cancelled.delivery, tools: [create.name] },
      signal(),
    ),
    false,
  );
  assert.equal(
    await h.service.canDeliver(
      command.key,
      {
        ...cancelled.delivery,
        operations: [
          { id: operation.operationId, version: proposal.delivery.operations[0]!.version },
        ],
      },
      signal(),
    ),
    false,
  );
  h.changeActor({ ...actor, employeeId: actor.employeeId + 1 });
  assert.equal(await h.service.canDeliver(command.key, cancelled.delivery, signal()), false);
  h.revoke();
  assert.equal(await h.service.recover(command, signal()), undefined);
  assert.equal(h.calls.length, 0);
});

test('restoring remote tools cannot confirm a locally cancelled proposal', async () => {
  const h = harness();
  const { operation } = await h.proposed();
  h.changeDefinitions([]);
  await h.service.recover(h.trusted('cancel ABCDEF12'), signal());
  h.changeDefinitions([create, rollback, crm]);
  for (const action of ['confirm', 'retry']) {
    const reply = await h.service.recover(h.trusted(`${action} ABCDEF12`), signal());
    assert.match(reply!.text, /cancelled/i);
  }
  assert.equal(h.operations.get(operation.operationId)!.state, 'CANCELLED');
  assert.equal(h.counts().approveCount, 0);
  assert.equal(h.calls.length, 0);
});

test('delivery rechecks the exact current history policy, not just the tool name', async () => {
  const h = harness();
  const { request, reply } = await h.proposed();
  assert.equal(await h.service.canDeliver(request.key, reply.delivery, signal()), true);
  const changed = structuredClone(create);
  delete (changed._meta!['wareongo/context-write-v1'] as Record<string, unknown>).auditHistory;
  h.changeDefinitions([changed, rollback, crm]);
  assert.equal(await h.service.canDeliver(request.key, reply.delivery, signal()), false);
  assert.equal(h.calls.length, 0);
});

test('forwarded, caption and capture-only commands cannot dispatch', async () => {
  const h = harness();
  await h.proposed();
  assert.equal(
    await h.service.recover(h.trusted('confirm ABCDEF12', { forwarded: true }), signal()),
    undefined,
  );
  for (const kind of ['image', 'video', 'document', 'audio']) {
    const result = await h.service.recover(h.trusted('confirm ABCDEF12', { kind }), signal());
    assert.match(result!.text, /type|directly/);
  }
  h.useCapture();
  assert.equal(await h.service.recover(h.trusted('confirm ABCDEF12'), signal()), undefined);
  assert.equal(h.calls.length, 0);
  assert.equal(h.counts().approveCount, 0);
});

test('batched changed intent, loose prose, retry before approval and unpublished drafts cannot dispatch', async () => {
  const h = harness();
  const request = h.trusted('Save Example.');
  const run = (await h.service.open(request, signal()))!;
  await run.execute(create.name, JSON.stringify({ name: 'Example' }), signal());
  assert.match(
    (await h.service.recover(h.trusted('confirm ABCDEF12'), signal()))!.text,
    /not passed review/,
  );
  await run.finalize(signal());
  assert.equal(
    await h.service.recover(h.trusted('yes please confirm ABCDEF12'), signal()),
    undefined,
  );
  // Confirmation must be the only current direct member, even if a preceding instruction says the same thing.
  const batched = h.trusted('also save another point');
  const direct = h.trusted('confirm ABCDEF12');
  const combined = {
    ...direct,
    commandMessages: [batched.commandMessages![0]!, ...direct.commandMessages!],
  };
  assert.match((await h.service.recover(combined, signal()))!.text, /by itself/);
  assert.match(
    (await h.service.recover(h.trusted('retry ABCDEF12'), signal()))!.text,
    /Nothing has been changed/,
  );
  assert.equal(h.calls.length, 0);
});

test('revoked access or changed schemas prevent publication, dispatch and stale delivery', async () => {
  const h = harness();
  const { request, reply } = await h.proposed();
  const changed = structuredClone(create);
  changed.inputSchema.required = ['operation_id', 'name', 'new_required'];
  h.changeDefinitions([changed, rollback, crm]);
  const result = await h.service.recover(h.trusted('confirm ABCDEF12'), signal());
  assert.match(result!.text, /changed/);
  assert.equal(h.calls.length, 0);
  h.revoke();
  assert.equal(await h.service.canDeliver(request.key, reply.delivery, signal()), false);
  assert.equal(await h.service.recover(h.trusted('confirm ABCDEF12'), signal()), undefined);
  const h2 = harness();
  const run = (await h2.service.open(h2.trusted('Save Example.'), signal()))!;
  await run.execute(create.name, JSON.stringify({ name: 'Example' }), signal());
  h2.revoke();
  await assert.rejects(run.finalize(signal()), /WRITE_ACCESS_CHANGED/);
  assert.equal(h2.counts().publishCount, 0);
});

test('unknown outcomes retry only the same operation ID and frozen arguments', async () => {
  const h = harness();
  const { operation } = await h.proposed();
  h.useUnknown(true);
  const result = await h.service.recover(h.trusted('confirm ABCDEF12'), signal());
  assert.match(result!.text, /may already have completed/);
  assert.equal(h.operations.get(operation.operationId)!.state, 'UNKNOWN');
  h.useUnknown(false);
  const retried = await h.service.recover(h.trusted('retry ABCDEF12'), signal());
  assert.match(retried!.text, /^Saved:/);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[1], h.calls[0]);
  assert.equal(h.proposals.length, 1);
});

test('future CRM update tools stage generically with exact target and expected version', async () => {
  const h = harness();
  const run = (await h.service.open(h.trusted('Mark that opportunity won.'), signal()))!;
  const args = { record_id: randomUUID(), expected_version: 4, stage: 'won' };
  const result = await run.execute(crm.name, JSON.stringify(args), signal());
  assert.equal((result as { ok: boolean }).ok, true);
  const reply = (await run.finalize(signal()))!;
  assert.match(reply.text, /expected version: 4/);
  assert.match(reply.text, new RegExp(args.record_id));
  assert.deepEqual(h.proposals[0]!.payload.arguments, {
    ...args,
    operation_id: h.proposals[0]!.operationId,
  });
  assert.equal(h.calls.length, 0);
});

test('rollback binds the owned successful original and displays its actual target', async () => {
  const h = harness();
  const { operation } = await h.proposed();
  await h.service.recover(h.trusted('confirm ABCDEF12'), signal());
  const run = (await h.service.open(
    h.trusted('Undo the Example point because it was the wrong point.'),
    signal(),
  ))!;
  const result = await run.execute(
    rollback.name,
    JSON.stringify({ original_operation_id: operation.operationId }),
    signal(),
  );
  assert.equal((result as { ok: boolean }).ok, true);
  const reply = (await run.finalize(signal()))!;
  assert.match(reply.text, /Example/);
  assert.equal(
    [...h.operations.values()].at(-1)!.payload.reason,
    'Undo the Example point because it was the wrong point.',
  );
  const compensation = [...h.operations.values()].at(-1)!;
  assert.equal(compensation.payload.parentOperationId, operation.operationId);
  assert.equal(
    compensation.payload.parentExpectedVersion,
    h.operations.get(operation.operationId)!.version,
  );
  assert.notEqual(compensation.operationId, operation.operationId);
  assert.equal(h.calls.length, 1);
});

test('rollback cannot target unresolved or unowned operations', async () => {
  const h = harness();
  const { operation } = await h.proposed();
  const run = (await h.service.open(h.trusted('Undo that point.'), signal()))!;
  for (const id of [operation.operationId, randomUUID()]) {
    const result = await run.execute(
      rollback.name,
      JSON.stringify({ original_operation_id: id }),
      signal(),
    );
    assert.equal((result as { ok: boolean }).ok, false);
    assert.equal((result as { code: string }).code, 'WRITE_ROLLBACK_TARGET_UNAVAILABLE');
  }
  assert.equal(h.proposals.length, 1);
  assert.equal(h.calls.length, 0);
});

test('history followed by a proposal retains both authorization dependencies and never dispatches', async () => {
  const h = harness();
  const { operation } = await h.proposed();
  await h.service.recover(h.trusted('confirm ABCDEF12'), signal());
  const run = (await h.service.open(
    h.trusted('Check the old result and prepare Another.'),
    signal(),
  ))!;
  const history = (await run.execute('write_history', '{}', signal())) as {
    ok: boolean;
    operations: unknown[];
  };
  assert.equal(history.ok, true);
  assert.equal(history.operations.length, 1);
  assert.equal(run.usedPrivateData, true);
  await run.execute(create.name, JSON.stringify({ name: 'Another' }), signal());
  const reply = (await run.finalize(signal()))!;
  assert.equal(reply.delivery.operations.length, 2);
  assert.ok(reply.delivery.operations.some((op) => op.id === operation.operationId));
  assert.equal(h.calls.length, 1);
  assert.equal(h.operations.size, 2);
});

const pointTool = tool(
  'create_example_point',
  'create',
  {
    name: { type: 'string', minLength: 1 },
    latitude: { type: 'number' },
    longitude: { type: 'number' },
  },
  { coordinateArguments: { latitude: 'latitude', longitude: 'longitude' } },
);
function pin(
  h: ReturnType<typeof harness>,
  latitude: number,
  longitude: number,
  historical = false,
) {
  const id = randomUUID();
  const location = { kind: 'static' as const, latitude, longitude, name: 'Forwarded source label' };
  h.sources.set(id, {
    id,
    text: 'Source data only',
    kind: 'location',
    receivedAtMs: now,
    currentTurn: !historical,
    forwarded: historical ? null : true,
    location,
  });
  return { id, messageId: id, receivedAtMs: now, forwarded: true, location };
}

test('single current native pin binds exact coordinates including zero without granting intent', async () => {
  const h = harness();
  h.changeDefinitions([pointTool]);
  const source = pin(h, 0, 78.125);
  const trusted = { ...h.trusted('Save the shared pin as Example.'), locationMessages: [source] };
  const run = (await h.service.open(trusted, signal()))!;
  const mismatch = (await run.execute(
    pointTool.name,
    JSON.stringify({ name: 'Example', latitude: 1, longitude: 78.125 }),
    signal(),
  )) as { ok: boolean; code: string };
  assert.equal(mismatch.code, 'WRITE_LOCATION_SOURCE_MISMATCH');
  assert.equal(h.proposals.length, 0);
  const accepted = (await run.execute(
    pointTool.name,
    JSON.stringify({ name: 'Example', latitude: 0, longitude: 78.125 }),
    signal(),
  )) as { ok: boolean };
  assert.equal(accepted.ok, true);
  assert.match(JSON.stringify(h.proposals[0]!.payload.source), new RegExp(source.id));
  assert.equal(h.calls.length, 0);
});

test('multiple current pins require explicit source selection and historical pins preserve their coordinates', async () => {
  const h = harness();
  h.changeDefinitions([pointTool]);
  const first = pin(h, 0, 78.125),
    second = pin(h, 1, 79);
  const current = {
    ...h.trusted('Save the second pin as Example.'),
    locationMessages: [first, second],
  };
  const run = (await h.service.open(current, signal()))!;
  const unclear = (await run.execute(
    pointTool.name,
    JSON.stringify({ name: 'Example', latitude: 1, longitude: 79 }),
    signal(),
  )) as { code: string };
  assert.equal(unclear.code, 'WRITE_LOCATION_SELECTION_REQUIRED');
  const accepted = (await run.execute(
    pointTool.name,
    JSON.stringify({
      name: 'Example',
      latitude: 1,
      longitude: 79,
      _source_message_ids: [second.id],
    }),
    signal(),
  )) as { ok: boolean };
  assert.equal(accepted.ok, true);
  const historical = pin(h, 2, 80, true);
  const later = (await h.service.open(h.trusted('Save the earlier shared pin.'), signal()))!;
  const mismatch = (await later.execute(
    pointTool.name,
    JSON.stringify({
      name: 'Historical example',
      latitude: 3,
      longitude: 80,
      _source_message_ids: [historical.id],
    }),
    signal(),
  )) as { code: string };
  assert.equal(mismatch.code, 'WRITE_LOCATION_SOURCE_MISMATCH');
  const unavailable = (await later.execute(
    pointTool.name,
    JSON.stringify({
      name: 'Historical example',
      latitude: 2,
      longitude: 80,
      _source_message_ids: [randomUUID()],
    }),
    signal(),
  )) as { code: string };
  assert.equal(unavailable.code, 'WRITE_SOURCE_UNAVAILABLE');
  assert.equal(h.calls.length, 0);
});

test('a failed correction clears the superseded draft and cannot publish the older action', async () => {
  const h = harness();
  const run = (await h.service.open(h.trusted('Save Example.'), signal()))!;
  assert.equal(
    (
      (await run.execute(create.name, JSON.stringify({ name: 'Example' }), signal())) as {
        ok: boolean;
      }
    ).ok,
    true,
  );
  assert.match(run.preview()!, /Example/);
  const invalid = (await run.execute(create.name, JSON.stringify({ name: '' }), signal())) as {
    ok: boolean;
  };
  assert.equal(invalid.ok, false);
  assert.equal(run.preview(), undefined);
  assert.equal(await run.finalize(signal()), undefined);
  assert.equal(h.counts().publishCount, 0);
  assert.equal(h.calls.length, 0);
});

test('generic CRM write permission does not expose historical records or authorize compensation', async () => {
  const h = harness();
  const undoCrm = tool(
    'undo_example_crm',
    'compensate',
    { original_operation_id: uuid },
    { compensates: crm.name, originalOperationArgument: 'original_operation_id' },
  );
  h.changeDefinitions([crm, undoCrm]);
  const first = (await h.service.open(h.trusted('Move the opportunity to review.'), signal()))!;
  const args = { record_id: randomUUID(), expected_version: 2, stage: 'review' };
  assert.equal(
    ((await first.execute(crm.name, JSON.stringify(args), signal())) as { ok: boolean }).ok,
    true,
  );
  await first.finalize(signal());
  await h.service.recover(h.trusted('confirm ABCDEF12'), signal());
  const original = [...h.operations.values()][0]!;
  assert.equal(original.state, 'SUCCEEDED');
  original.payload.summary = 'Secret old opportunity label';
  const recovered = await h.service.recover(h.trusted('confirm ABCDEF12'), signal());
  assert.doesNotMatch(recovered!.text, /Secret old opportunity label/);
  assert.match(recovered!.text, /audit records/);
  const later = (await h.service.open(
    h.trusted('Show my changes and undo that CRM update.'),
    signal(),
  ))!;
  const history = (await later.execute('write_history', '{}', signal())) as {
    ok: boolean;
    operations: unknown[];
  };
  assert.equal(history.ok, true);
  assert.deepEqual(history.operations, []);
  const compensation = (await later.execute(
    undoCrm.name,
    JSON.stringify({ original_operation_id: original.operationId }),
    signal(),
  )) as { ok: boolean };
  assert.equal(compensation.ok, false);
  assert.equal(h.proposals.length, 1);
  assert.equal(h.calls.length, 1);
});
