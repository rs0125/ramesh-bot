/** Exact native-reply commands are deterministic; models and live transport are forbidden. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PersonalToolService,
  type PersonalRepositoryPort,
} from '../../src/modules/scheduling/personal-tools.js';
import {
  SchedulingError,
  type PersonalCommandReceipt,
  type PersonalOperation,
  type PersonalRecord,
} from '../../src/modules/scheduling/scheduling.types.js';
import type { TrustedReplyContext } from '../../src/modules/greetings/greeting.types.js';
import { AssistantService } from '../../src/modules/assistant/assistant.service.js';

const now = Date.parse('2026-10-04T04:00:00Z');
const actor = { employeeId: 23, phoneE164: '+919000000023', chatId: '919000000023@s.whatsapp.net' };
const target: PersonalRecord = {
  kind: 'reminder',
  id: 'reminder-a',
  text: 'Review the synthetic proposal',
  state: 'scheduled',
  version: 3,
  createdAt: new Date(now).toISOString(),
  updatedAt: new Date(now).toISOString(),
  occurrenceId: 'occurrence-a',
  occurrenceState: 'sent',
  occurrenceDueAt: new Date(now - 60000).toISOString(),
  schedule: {
    dueAt: new Date(now - 60000).toISOString(),
    timezone: 'Asia/Kolkata',
    recurrence: { frequency: 'daily' },
  },
  nextDueAt: new Date(now + 86400000).toISOString(),
  taskId: 'task-a',
};
function fixture(options: { missing?: boolean; fail?: boolean; revoke?: boolean } = {}) {
  const operations: PersonalOperation[][] = [],
    lookedUp: string[] = [];
  let receipt: PersonalCommandReceipt | null = null,
    resolutions = 0;
  const repository: PersonalRepositoryPort = {
    async getReceipt() {
      return receipt;
    },
    async resolveReminderQuote(_ctx, key) {
      lookedUp.push(key);
      return options.missing ? null : target;
    },
    async applyBatch(ctx, ops) {
      if (options.fail) throw new SchedulingError('PERSONAL_QUOTED_REMINDER_UNAVAILABLE');
      operations.push(ops);
      receipt = {
        commandId: 'saved-command',
        runId: ctx.runId,
        records: [
          {
            ...target,
            ...(ops[0]?.kind === 'reminder_acknowledge'
              ? { occurrenceAcknowledgedAt: new Date(now).toISOString() }
              : {
                  occurrenceState: 'pending',
                  occurrenceDueAt: (ops[0] as { dueAt: string }).dueAt,
                }),
          },
        ],
      };
      return receipt;
    },
    async list() {
      throw new Error('Never choose a recent list');
    },
    async recall() {
      throw new Error('Never choose a recent reminder');
    },
    async resolveSelection() {
      throw new Error('Never choose an ordinal');
    },
    async finalizeSelections() {
      throw new Error('No selection');
    },
    async saveContext() {},
  };
  const service = new PersonalToolService(
    repository,
    async () => (++resolutions > 2 && options.revoke ? null : actor),
    () => now,
  );
  const trusted = (
    text: string,
    quote: string | undefined = 'EXACT-SENT-KEY',
  ): TrustedReplyContext => ({
    runId: 'run-a',
    key: { remoteJid: actor.chatId },
    checkpointLease: { leaseToken: 'lease-a' },
    commandMessages: [
      {
        id: 'member-a',
        text,
        receivedAtMs: now,
        forwarded: false,
        hasQuotedMessage: true,
        ...(quote ? { quotedMessageId: quote } : {}),
      },
    ],
  });
  return { service, trusted, operations, lookedUp };
}

test('done acknowledges exactly the quoted occurrence and explains recurring/task scope', async () => {
  const f = fixture(),
    trusted = f.trusted('done');
  const run = (await f.service.open(trusted, AbortSignal.timeout(5000)))!;
  const reply = await run.quickReply(AbortSignal.timeout(5000));
  assert.deepEqual(f.lookedUp, ['EXACT-SENT-KEY']);
  assert.deepEqual(f.operations, [
    [
      {
        kind: 'reminder_acknowledge',
        id: target.id,
        expectedVersion: 3,
        occurrenceId: target.occurrenceId,
        quotedMessageId: 'EXACT-SENT-KEY',
      },
    ],
  ]);
  assert.match(reply!.text, /Marked this reminder occurrence done/);
  assert.match(reply!.text, /Future reminders are unchanged/);
  assert.match(reply!.text, /linked task is unchanged/);
  assert.equal(reply!.delivery.commandId, 'saved-command');
  assert.deepEqual(await run.recover(AbortSignal.timeout(5000)), reply);
  assert.equal(f.operations.length, 1);
});

test('short snooze durations use the exact command member clock and occurrence', async () => {
  for (const [text, minutes] of [
    ['snooze 30m', 30],
    ['Snooze for 2 hours.', 120],
  ] as const) {
    const f = fixture();
    const run = (await f.service.open(f.trusted(text), AbortSignal.timeout(5000)))!;
    const reply = await run.quickReply(AbortSignal.timeout(5000));
    assert.deepEqual(f.operations[0], [
      {
        kind: 'reminder_snooze',
        id: target.id,
        expectedVersion: 3,
        occurrenceId: target.occurrenceId,
        quotedMessageId: 'EXACT-SENT-KEY',
        dueAt: new Date(now + minutes * 60000).toISOString(),
      },
    ]);
    assert.match(reply!.text, /IST/);
  }
});

test('missing, unknown, mixed, invalid and rejected references never use a recent reminder', async () => {
  for (const variant of ['missing', 'unknown', 'mixed', 'zero', 'huge', 'conflict'] as const) {
    const f = fixture({ missing: variant === 'unknown', fail: variant === 'conflict' });
    const text =
      variant === 'zero' ? 'snooze 0m' : variant === 'huge' ? 'snooze 999999999999999999h' : 'done';
    let trusted = f.trusted(text, variant === 'missing' ? '' : 'EXACT-SENT-KEY');
    if (variant === 'mixed')
      trusted = {
        ...trusted,
        commandMessages: [
          ...trusted.commandMessages!,
          { id: 'member-b', text: 'and do other work', receivedAtMs: now, forwarded: false },
        ],
      };
    const run = (await f.service.open(trusted, AbortSignal.timeout(5000)))!;
    const reply = await run.quickReply(AbortSignal.timeout(5000));
    assert.ok(reply?.text);
    assert.equal(reply.delivery.commandId, undefined);
    assert.equal(f.operations.length, 0);
  }
});

test('identity revocation between lookup and mutation prevents the quick command', async () => {
  const f = fixture({ revoke: true });
  const run = (await f.service.open(f.trusted('done'), AbortSignal.timeout(5000)))!;
  await assert.rejects(run.quickReply(AbortSignal.timeout(5000)), /IDENTITY_CHANGED/);
  assert.equal(f.operations.length, 0);
});

test('plain unquoted conversation is unchanged and forwarded commands never authorize quick writes', async () => {
  const f = fixture();
  for (const text of ['done', 'snooze 30m', 'Thanks, that is done']) {
    const trusted = f.trusted(text);
    const unquoted = {
      ...trusted,
      commandMessages: trusted.commandMessages!.map(
        ({ quotedMessageId: _quote, hasQuotedMessage: _has, ...member }) => member,
      ),
    };
    const run = (await f.service.open(unquoted, AbortSignal.timeout(5000)))!;
    assert.equal(await run.quickReply(AbortSignal.timeout(5000)), undefined);
  }
  const forwarded = f.trusted('done');
  assert.equal(
    await f.service.open(
      {
        ...forwarded,
        commandMessages: forwarded.commandMessages!.map((member) => ({
          ...member,
          forwarded: true,
        })),
      },
      AbortSignal.timeout(5000),
    ),
    undefined,
  );
  assert.equal(f.operations.length, 0);
  assert.equal(f.lookedUp.length, 0);
});

test('assistant handles exact quoted reminder commands and receipt replay without any model call', async () => {
  const f = fixture();
  let calls = 0;
  const service = new AssistantService(
    { model: 'synthetic-forbidden', timeoutMs: 5000 },
    {
      async complete() {
        calls++;
        throw new Error('Quick reply must not call a model');
      },
      startToolSession() {
        calls++;
        throw new Error('Quick reply must not discover/model tools');
      },
    },
    undefined,
    undefined,
    undefined,
    undefined,
    { personalTools: f.service },
  );
  const trusted = f.trusted('done');
  const message = {
    chatId: actor.chatId,
    messageId: 'native-a',
    text: 'done',
    sentAtMs: now,
    fromMe: false,
    isGroup: false,
    mentionsBot: false,
  };
  const first = await service.prepare(message, undefined, trusted);
  assert.match(first.text, /Marked this reminder occurrence done/);
  assert.equal((await service.prepare(message, undefined, trusted)).text, first.text);
  assert.equal(calls, 0);
  assert.equal(f.operations.length, 1);
});
