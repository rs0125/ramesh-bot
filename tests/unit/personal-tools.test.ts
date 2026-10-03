/** Personal persistence through the real graph, with fake models, identity and repository only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AssistantService } from '../../src/modules/assistant/assistant.service.js';
import type {
  ModelRequest,
  TextModel,
  ToolSessionRequest,
} from '../../src/modules/assistant/assistant.types.js';
import type { TrustedReplyContext } from '../../src/modules/greetings/greeting.types.js';
import {
  PersonalToolService,
  renderList,
  renderReceipt,
  type PersonalRepositoryPort,
} from '../../src/modules/scheduling/personal-tools.js';
import {
  SchedulingError,
  type PersonalActor,
  type PersonalCommandContext,
  type PersonalCommandReceipt,
  type PersonalOperation,
  type PersonalRecord,
} from '../../src/modules/scheduling/scheduling.types.js';
import { planningResult } from '../fixtures/planning-model.js';
import type { AgentCheckpointStore } from '../../src/modules/assistant/checkpoint.types.js';

const now = Date.parse('2026-10-03T04:00:00Z');
const jid = '919999000111@s.whatsapp.net';
const actor: PersonalActor = { employeeId: 7, phoneE164: '+919999000111', chatId: jid };
const input = 'Add a task to review the lease and remind me in 30 days to review the lease.';
const trusted: TrustedReplyContext = {
  runId: 'personal-run',
  key: { remoteJid: jid },
  checkpointLease: { leaseToken: 'live-lease' },
  commandMessages: [{ id: 'member-1', text: input, receivedAtMs: now, forwarded: false }],
};
const message = {
  chatId: jid,
  messageId: 'message-1',
  sentAtMs: now,
  text: input,
  fromMe: false,
  isGroup: false,
  mentionsBot: false,
};
const result = (text: string) => ({ text, inputTokens: 1, outputTokens: 1 });
const signal = () => AbortSignal.timeout(5000);
const source = { messageId: 'member-1', quote: input };
const batch = {
  operations: [
    { kind: 'task_create', source, text: 'review the lease', alias: 'lease' },
    {
      kind: 'reminder_create',
      source,
      text: 'review the lease',
      time: { afterMinutes: 30 * 24 * 60 },
      taskRef: 'lease',
    },
  ],
};

function fakeModel(
  calls: Array<{ name: string; args: unknown }>,
  events: string[] = [],
  approved = true,
) {
  const requests: ModelRequest[] = [],
    sessions: ToolSessionRequest[] = [],
    outputs: unknown[] = [];
  const model: TextModel = {
    async complete(request) {
      events.push(request.stage);
      requests.push(request);
      return (
        planningResult(request) ??
        result(
          request.stage === 'verifier'
            ? JSON.stringify({
                supported: approved,
                feedback: approved ? '' : 'Not authorized by the user.',
                repair: 'format',
              })
            : 'The proposed personal change is ready for application review.',
        )
      );
    },
    startToolSession(request) {
      sessions.push(request);
      let index = 0;
      return {
        async next(remaining) {
          const call = remaining > 0 ? calls[index++] : undefined;
          return {
            ...result(call ? '' : 'The proposed personal change is ready for application review.'),
            calls: call
              ? [{ id: `call-${index}`, name: call.name, arguments: JSON.stringify(call.args) }]
              : [],
          };
        },
        accept(_id, output) {
          outputs.push(output);
        },
      };
    },
  };
  return { model, requests, sessions, outputs };
}

function harness(events: string[] = []) {
  let current: PersonalActor | null = actor;
  let receipt: PersonalCommandReceipt | null = null;
  let applyFailure = false;
  let listFailure = false;
  let afterCommit: (() => void) | undefined;
  const applied: PersonalOperation[][] = [];
  const contexts: PersonalCommandContext[] = [];
  const finalized: string[][] = [];
  const selected: unknown[][] = [];
  let listRecords: PersonalRecord[] = [
    {
      kind: 'task',
      id: 'original-second',
      text: 'Check the quote',
      state: 'open',
      version: 3,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    },
  ];
  const repository: PersonalRepositoryPort = {
    async getReceipt(context) {
      contexts.push(context);
      return receipt;
    },
    async applyBatch(context, operations) {
      events.push('commit');
      if (applyFailure) throw new Error('synthetic DB unavailable');
      contexts.push(context);
      applied.push(structuredClone(operations));
      receipt = {
        commandId: 'saved-command',
        runId: context.runId,
        records: operations.map((operation, index) => ({
          kind: operation.kind.startsWith('task_') ? 'task' : 'reminder',
          id: `saved-${index}`,
          text: 'text' in operation ? operation.text! : 'Check the quote',
          state:
            operation.kind === 'task_complete'
              ? 'done'
              : operation.kind.endsWith('_cancel')
                ? 'cancelled'
                : operation.kind.startsWith('task_')
                  ? 'open'
                  : 'scheduled',
          version: 1,
          createdAt: new Date(now).toISOString(),
          updatedAt: new Date(now).toISOString(),
          ...('schedule' in operation ? { schedule: operation.schedule } : {}),
        })),
      };
      afterCommit?.();
      return receipt;
    },
    async list() {
      if (listFailure) throw new Error('synthetic read unavailable');
      return { records: listRecords, selectionId: 'saved-selection', nextCursor: null };
    },
    async resolveSelection(...args) {
      selected.push(args);
      return { id: 'original-second', expectedVersion: 3 };
    },
    async finalizeSelections(_context, ids) {
      finalized.push(ids);
    },
  };
  const service = new PersonalToolService(
    repository,
    async () => current,
    () => now,
  );
  const assistant = (model: TextModel) =>
    new AssistantService(
      { model: 'offline-personal-fake', timeoutMs: 5000 },
      model,
      undefined,
      undefined,
      undefined,
      undefined,
      { now: () => now, personalTools: service },
    );
  return {
    service,
    assistant,
    applied,
    contexts,
    finalized,
    selected,
    setIdentity: (value: PersonalActor | null) => {
      current = value;
    },
    failApply: () => {
      applyFailure = true;
    },
    failList: () => {
      listFailure = true;
    },
    onCommit: (callback: () => void) => {
      afterCommit = callback;
    },
    setList: (value: PersonalRecord[]) => {
      listRecords = value;
    },
  };
}

test('personal tools work without CRM; task and long-future reminder commit once after verification', async () => {
  const events: string[] = [];
  const h = harness(events);
  const fake = fakeModel([{ name: 'personal_apply', args: batch }], events);
  const reply = await h.assistant(fake.model).prepare(message, signal(), trusted);
  assert.equal(reply.trace.outcome, 'completed');
  assert.deepEqual(
    fake.sessions[0]!.tools.map((tool) => tool.name),
    ['personal_list', 'personal_apply'],
  );
  assert.equal(fake.sessions[0]!.tools[1]!.annotations?.readOnlyHint, false);
  assert.equal(fake.sessions[0]!.tools[1]!.annotations?.idempotentHint, false);
  assert.equal(h.applied.length, 1);
  assert.equal(h.applied[0]!.length, 2);
  assert.ok(events.indexOf('commit') > events.lastIndexOf('verifier'));
  const reminder = h.applied[0]![1]!;
  assert.equal(reminder.kind, 'reminder_create');
  if (reminder.kind === 'reminder_create')
    assert.equal(reminder.schedule.dueAt, '2026-11-02T04:00:00.000Z');
  assert.match(reply.text, /Saved task: review the lease/);
  assert.match(reply.text, /2 November 2026/);
  assert.equal((reply.businessEvidence as { kind: string }).kind, 'personal');
  for (const stage of ['formatter', 'verifier']) {
    const body = JSON.parse(
      fake.requests.find((request) => request.stage === stage)!.messages[0]!.content,
    );
    assert.equal(body.personal_evidence[0].status, 'staged_not_committed');
    assert.deepEqual(body.evidence, []);
  }
});

test('committed recovery returns the durable receipt without any model invocation or another write', async () => {
  const h = harness();
  const before = await h
    .assistant(fakeModel([{ name: 'personal_apply', args: batch }]).model)
    .prepare(message, signal(), trusted);
  const never: TextModel = {
    async complete() {
      throw new Error('No model call permitted');
    },
  };
  const after = await h.assistant(never).prepare(message, signal(), trusted);
  assert.equal(after.text, before.text);
  assert.equal(h.applied.length, 1);
  assert.deepEqual(after.trace.stages, []);
});

test('a committed receipt is recovered before an expired model deadline, without renewing model work', async () => {
  const h = harness();
  await h
    .assistant(fakeModel([{ name: 'personal_apply', args: batch }]).model)
    .prepare(message, signal(), trusted);
  let checkpointBegins = 0;
  const checkpoints: AgentCheckpointStore = {
    async begin() {
      checkpointBegins++;
      return {
        metadata: {
          requestTimeMs: now,
          startedAtMs: Date.now() - 60000,
          deadlineAtMs: Date.now() - 1,
        },
        async read() {
          return undefined;
        },
        async save() {},
        async consume() {
          return true;
        },
        async policy() {
          return undefined;
        },
      };
    },
  };
  const never: TextModel = {
    async complete() {
      throw new Error('No model call permitted');
    },
  };
  const make = (personalTools: PersonalToolService) =>
    new AssistantService(
      { model: 'offline-personal-fake', timeoutMs: 5000 },
      never,
      undefined,
      undefined,
      undefined,
      undefined,
      { personalTools, checkpoints },
    );
  const recovered = await make(h.service).prepare(message, signal(), trusted);
  assert.match(recovered.text, /Saved task/);
  assert.equal(checkpointBegins, 0);
  assert.equal(h.applied.length, 1);
  const empty = harness();
  const expired = await make(empty.service).prepare(message, signal(), trusted);
  assert.equal(expired.trace.failureCode, 'DEADLINE_EXCEEDED');
  assert.equal(checkpointBegins, 1);
  assert.equal(empty.applied.length, 0);
});

test('relative time is anchored to the command-bearing member rather than first batched member', async () => {
  const h = harness();
  const shifted = {
    ...trusted,
    commandMessages: [
      { id: 'unrelated', text: 'Good morning.', receivedAtMs: now - 86400000, forwarded: false },
      ...trusted.commandMessages!,
    ],
  };
  const run = (await h.service.open(shifted, signal()))!;
  await run.execute('personal_apply', JSON.stringify(batch), signal());
  await run.finish(signal());
  const reminder = h.applied[0]![1]!;
  assert.equal(
    reminder.kind === 'reminder_create' && reminder.schedule.dueAt,
    '2026-11-02T04:00:00.000Z',
  );
});

test('a correction uses the later member clock while retaining exact user text from an earlier member', async () => {
  const h = harness();
  const correctedAt = now + 90000;
  const command = {
    ...trusted,
    commandMessages: [
      {
        id: 'first',
        text: 'Remind me in 20 minutes to call the owner.',
        receivedAtMs: now,
        forwarded: false,
      },
      {
        id: 'correction',
        text: 'Actually make that 40 minutes.',
        receivedAtMs: correctedAt,
        forwarded: false,
      },
    ],
  };
  const run = (await h.service.open(command, signal()))!;
  const proposal = {
    operations: [
      {
        kind: 'reminder_create',
        source: { messageId: 'correction', quote: 'Actually make that 40 minutes.' },
        text: 'call the owner',
        time: { afterMinutes: 40 },
      },
    ],
  };
  assert.equal((await run.execute('personal_apply', JSON.stringify(proposal), signal())).ok, true);
  await run.finish(signal());
  const saved = h.applied[0]![0]!;
  assert.equal(
    saved.kind === 'reminder_create' && saved.schedule.dueAt,
    new Date(correctedAt + 40 * 60000).toISOString(),
  );
  const forwarded = (await h.service.open(
    {
      ...command,
      commandMessages: command.commandMessages.map((member) =>
        member.id === 'first' ? { ...member, forwarded: true } : member,
      ),
    },
    signal(),
  ))!;
  assert.equal(
    (await forwarded.execute('personal_apply', JSON.stringify(proposal), signal())).code,
    'TEXT_MUST_BE_USER_AUTHORED',
  );
});

test('recurring lists show the next due date and snooze receipts retain the explicitly saved occurrence time', () => {
  const record: PersonalRecord = {
    kind: 'reminder',
    id: 'reminder',
    text: 'Review the pipeline',
    state: 'scheduled',
    version: 1,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    schedule: {
      dueAt: '2026-10-01T03:30:00.000Z',
      timezone: 'Asia/Kolkata',
      recurrence: { frequency: 'daily' },
    },
    nextDueAt: '2026-10-04T03:30:00.000Z',
    occurrenceId: 'old',
    occurrenceState: 'sent',
    occurrenceDueAt: '2026-10-03T03:30:00.000Z',
  };
  const list = renderList('reminder', { records: [record], selectionId: 'list', nextCursor: null });
  assert.match(list, /next 4 October 2026/);
  assert.match(list, /last occurrence sent/);
  assert.doesNotMatch(list, /1 October 2026|3 October 2026/);
  const snoozed = {
    ...record,
    occurrenceState: 'pending',
    occurrenceDueAt: '2026-10-05T04:00:00.000Z',
  };
  const receipt = renderReceipt({ commandId: 'snooze-command', runId: 'run', records: [snoozed] });
  assert.match(receipt, /5 October 2026/);
  assert.doesNotMatch(receipt, /4 October 2026/);
  const snoozedList = renderList('reminder', {
    records: [snoozed],
    selectionId: 'list',
    nextCursor: null,
  });
  assert.match(snoozedList, /next 4 October 2026/);
  assert.match(snoozedList, /pending notification 5 October 2026/);
});

test('forwarded instructions, missing trusted metadata and unknown/group identities cannot open writes', async () => {
  const h = harness();
  assert.equal(
    await h.service.open({ ...trusted, commandMessages: undefined }, signal()),
    undefined,
  );
  assert.equal(
    await h.service.open({ ...trusted, checkpointLease: undefined }, signal()),
    undefined,
  );
  assert.equal(
    await h.service.open(
      {
        ...trusted,
        commandMessages: trusted.commandMessages!.map((member) => ({ ...member, forwarded: true })),
      },
      signal(),
    ),
    undefined,
  );
  assert.equal(
    await h.service.open({ ...trusted, key: { remoteJid: 'group@g.us' } }, signal()),
    undefined,
  );
  h.setIdentity(null);
  assert.equal(await h.service.open(trusted, signal()), undefined);
  assert.equal(h.applied.length, 0);
});

test('protected/copied text and omitted business conditions cannot be saved as personal text', async () => {
  for (const kind of ['copied', 'conditional'] as const) {
    const h = harness();
    const command =
      kind === 'conditional'
        ? {
            ...trusted,
            commandMessages: [
              {
                id: 'member-1',
                text: 'Remind me to review the lease if the deal still has no follow-up.',
                receivedAtMs: now,
                forwarded: false,
              },
            ],
          }
        : trusted;
    const run = (await h.service.open(command, signal()))!;
    const proposal =
      kind === 'copied'
        ? { kind: 'task_create', source, text: 'Private CRM figure: 42 crore' }
        : {
            kind: 'reminder_create',
            source: { messageId: 'member-1', quote: 'review the lease' },
            text: 'review the lease',
            time: { afterMinutes: 60 },
          };
    const output = await run.execute(
      'personal_apply',
      JSON.stringify({ operations: [proposal] }),
      signal(),
    );
    assert.equal(output.ok, false);
    assert.equal(
      output.code,
      kind === 'copied' ? 'TEXT_MUST_BE_USER_AUTHORED' : 'CONDITIONAL_REMINDERS_UNAVAILABLE',
    );
    const reply = await run.finish(signal());
    assert.match(reply!.text, /couldn't save/);
    assert.equal(h.applied.length, 0);
  }
});

test('identical proposals stage once; a changed second batch never commits the earlier proposal', async () => {
  const h = harness();
  const run = (await h.service.open(trusted, signal()))!;
  await run.execute('personal_apply', JSON.stringify(batch), signal());
  await run.execute('personal_apply', JSON.stringify(batch), signal());
  const conflict = await run.execute(
    'personal_apply',
    JSON.stringify({ operations: [batch.operations[0]] }),
    signal(),
  );
  assert.equal(conflict.code, 'ONE_MUTATION_BATCH_PER_TURN');
  await run.finish(signal());
  assert.equal(h.applied.length, 0);
});

test('rejected review, storage failure and abort do not produce a successful mutation acknowledgement', async () => {
  const h = harness();
  const rejected = await h
    .assistant(fakeModel([{ name: 'personal_apply', args: batch }], [], false).model)
    .prepare(message, signal(), trusted);
  assert.equal(h.applied.length, 0);
  assert.doesNotMatch(rejected.text, /Saved task/);
  h.failApply();
  const unavailable = await h
    .assistant(fakeModel([{ name: 'personal_apply', args: batch }]).model)
    .prepare(message, signal(), trusted);
  assert.equal(unavailable.trace.outcome, 'unavailable');
  assert.doesNotMatch(unavailable.text, /Saved task/);
  const run = (await h.service.open(trusted, signal()))!;
  await run.execute('personal_apply', JSON.stringify(batch), signal());
  const aborted = AbortSignal.abort(new Error('cancelled'));
  await assert.rejects(run.finish(aborted), /cancelled/);
  assert.equal(h.applied.length, 0);
});

test('list presentation is deterministic and finalized only after successful review', async () => {
  const h = harness();
  const fake = fakeModel([{ name: 'personal_list', args: { kind: 'task' } }]);
  const reply = await h
    .assistant(fake.model)
    .prepare({ ...message, text: 'Show my tasks.' }, signal(), {
      ...trusted,
      commandMessages: [
        { id: 'member-1', text: 'Show my tasks.', receivedAtMs: now, forwarded: false },
      ],
    });
  assert.match(reply.text, /^Your tasks \(this page\):\n1\. Check the quote \[open\]/);
  assert.deepEqual(h.finalized, [['saved-selection']]);
  assert.equal(h.applied.length, 0);
  const rejected = harness();
  await rejected
    .assistant(fakeModel([{ name: 'personal_list', args: { kind: 'task' } }], [], false).model)
    .prepare(message, signal(), trusted);
  assert.deepEqual(rejected.finalized, []);
});

test('ordinal changes resolve the previous presented selection and use its observed version', async () => {
  const h = harness();
  const text = 'Mark the second task done.';
  const command = {
    ...trusted,
    commandMessages: [{ id: 'member-1', text, receivedAtMs: now, forwarded: false }],
  };
  const run = (await h.service.open(command, signal()))!;
  await run.execute(
    'personal_apply',
    JSON.stringify({
      operations: [
        {
          kind: 'task_complete',
          source: { messageId: 'member-1', quote: text },
          target: { selectionId: 'latest', ordinal: 2 },
        },
      ],
    }),
    signal(),
  );
  await run.finish(signal());
  assert.deepEqual(h.selected[0]!.slice(1), ['task', 'latest', 2]);
  assert.deepEqual(h.applied[0], [
    { kind: 'task_complete', id: 'original-second', expectedVersion: 3 },
  ]);
});

test('identity change blocks both commit and private delivery, including a reassigned phone', async () => {
  const h = harness();
  const run = (await h.service.open(trusted, signal()))!;
  await run.execute('personal_apply', JSON.stringify(batch), signal());
  h.setIdentity({ ...actor, employeeId: 8 });
  await assert.rejects(run.finish(signal()), SchedulingError);
  assert.equal(h.applied.length, 0);
  assert.equal(
    await h.service.canDeliver(
      trusted.key,
      {
        kind: 'personal',
        version: 1,
        employeeId: 7,
        phoneE164: actor.phoneE164,
        runId: trusted.runId,
      },
      signal(),
    ),
    false,
  );
  h.setIdentity(actor);
  assert.equal(
    await h.service.canDeliver(
      trusted.key,
      {
        kind: 'personal',
        version: 1,
        employeeId: 7,
        phoneE164: actor.phoneE164,
        runId: trusted.runId,
      },
      signal(),
    ),
    true,
  );
});

test('identity failure after committed mutation never claims nothing changed and receipt remains recoverable', async () => {
  const h = harness();
  h.onCommit(() => h.setIdentity(null));
  const reply = await h
    .assistant(fakeModel([{ name: 'personal_apply', args: batch }]).model)
    .prepare(message, signal(), trusted);
  assert.equal(h.applied.length, 1);
  assert.equal(reply.trace.outcome, 'unavailable');
  assert.doesNotMatch(reply.text, /nothing.*changed|not.*saved|Saved task/);
  h.setIdentity(actor);
  const never: TextModel = {
    async complete() {
      throw new Error('No model call permitted');
    },
  };
  const recovered = await h.assistant(never).prepare(message, signal(), trusted);
  assert.match(recovered.text, /Saved task: review the lease/);
  assert.equal(h.applied.length, 1);
});

test('plain when in reminder content and conditional cancellation are not business-condition creation', async () => {
  const h = harness();
  for (const [text, operation] of [
    [
      'Remind me in one hour to ask when the shipment arrives.',
      {
        kind: 'reminder_create',
        text: 'ask when the shipment arrives',
        time: { afterMinutes: 60 },
      },
    ],
    [
      'Cancel that reminder if it exists.',
      { kind: 'reminder_cancel', target: { id: 'existing', expectedVersion: 1 } },
    ],
  ] as const) {
    const run = (await h.service.open(
      {
        ...trusted,
        commandMessages: [{ id: 'member-1', text, receivedAtMs: now, forwarded: false }],
      },
      signal(),
    ))!;
    const output = await run.execute(
      'personal_apply',
      JSON.stringify({
        operations: [{ ...operation, source: { messageId: 'member-1', quote: text } }],
      }),
      signal(),
    );
    assert.equal(output.ok, true);
  }
});
