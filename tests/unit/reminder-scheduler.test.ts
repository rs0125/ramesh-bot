/** Deterministic scheduler/transport tests. No model, database, or real WhatsApp session. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { proto, type WAMessage } from '@whiskeysockets/baileys';
import type { TrustedReplyContext } from '../../src/modules/greetings/greeting.types.js';
import {
  PersonalSchedulerService,
  reminderEvidenceMatches,
  reminderMessageId,
  type ReminderSchedulerRepository,
} from '../../src/modules/scheduling/scheduler.service.js';
import type {
  DueReminder,
  ReminderDeliveryRef,
} from '../../src/modules/scheduling/scheduling.types.js';
import { authCipher } from '../../src/infrastructure/database/auth-store.js';
import { encodeReply } from '../../src/modules/messaging/reply-payload.js';
import type { EmployeeIdentity } from '../../src/modules/identity/employee-identity.js';
import { DurableMessages } from '../../src/infrastructure/whatsapp/durable-messages.js';
import type {
  MessageJob,
  MessageQueueRepository,
} from '../../src/infrastructure/database/message-queue.repository.js';
import type { WhatsAppSession } from '../../src/infrastructure/whatsapp/baileys-session.js';

const employee: EmployeeIdentity = {
  employeeId: 23,
  phoneE164: '+919000000023',
  email: 'synthetic@example.test',
  active: true,
};
const makeDue = (): DueReminder => ({
  id: randomUUID(),
  reminderId: randomUUID(),
  employeeId: 23,
  phoneE164: employee.phoneE164,
  chatId: '123456789012345@lid',
  text: 'Review the synthetic proposal',
  dueAt: new Date().toISOString(),
  notAfter: new Date(Date.now() + 3600000).toISOString(),
  leaseToken: randomUUID(),
  scheduleVersion: 1,
  dispatchGeneration: 0,
});
const reference = (due: DueReminder): ReminderDeliveryRef => ({
  occurrenceId: due.id,
  reminderId: due.reminderId,
  scheduleVersion: due.scheduleVersion,
  dispatchGeneration: due.dispatchGeneration,
  ownerEmployeeId: due.employeeId,
  recipientPhoneE164: due.phoneE164,
  notAfterMs: Date.parse(due.notAfter),
});

function schedulerFixture(options?: {
  resolve?: (signal: AbortSignal) => Promise<EmployeeIdentity | null>;
  full?: boolean;
  renew?: boolean;
}) {
  const due = makeDue();
  const key = randomBytes(32).toString('base64url');
  let claimed = false,
    wakes = 0,
    enqueues = 0,
    claims = 0;
  const releases: Array<{ reason: string; terminal?: string }> = [];
  let encrypted: Parameters<MessageQueueRepository['enqueueReminder']> | undefined;
  const repository: ReminderSchedulerRepository = {
    async claimDue() {
      claims++;
      if (claimed) return null;
      claimed = true;
      return due;
    },
    async renewDue() {
      return options?.renew ?? true;
    },
    async releaseDue(_due, reason, terminal) {
      releases.push({ reason, terminal });
    },
    async enqueueDue(item, actor, enqueue) {
      assert.equal(actor.chatId, due.chatId);
      const result = await enqueue({} as PoolClient, reference(item));
      return result === 'full' ? 'full' : 'queued';
    },
    async reconcile() {},
  };
  const scheduler = new PersonalSchedulerService(
    repository,
    {
      accountId: 'synthetic',
      async enqueueReminder(...args) {
        enqueues++;
        encrypted = args;
        return options?.full ? 'full' : args[1];
      },
    },
    {
      encryptionKey: key,
      capacity: 100,
      pollMs: 100,
      leaseMs: 1000,
      preparationTimeoutMs: 2000,
      resolveEmployee: async (id, signal, chatId) => {
        assert.equal(id, 23);
        assert.equal(chatId, due.chatId);
        return options?.resolve ? options.resolve(signal) : employee;
      },
      onQueued: () => {
        wakes++;
      },
    },
  );
  return {
    scheduler,
    due,
    key,
    releases,
    get encrypted() {
      return encrypted;
    },
    get wakes() {
      return wakes;
    },
    get enqueues() {
      return enqueues;
    },
    get claims() {
      return claims;
    },
  };
}

test('scheduler stores one encrypted private reminder and wakes only after committed admission', async () => {
  const f = schedulerFixture();
  await Promise.all([f.scheduler.tick(), f.scheduler.tick()]);
  assert.equal(f.enqueues, 1);
  assert.equal(f.wakes, 1);
  const args = f.encrypted!;
  assert.equal(
    args[2],
    f.due.chatId,
    'preserve trusted LID conversation for cancellation priority',
  );
  assert.equal(args[3].includes(f.due.text), false);
  const cipher = authCipher(f.key);
  const payload = cipher.open('outbound-reply', args[1], args[4]) as { kind: string; text: string };
  assert.equal(payload.kind, 'business');
  assert.match(payload.text, /Review the synthetic proposal/);
  assert.match(payload.text, /IST/);
  assert.equal(
    reminderEvidenceMatches(cipher.open('business-delivery', args[1], args[5]), reference(f.due)),
    true,
  );
  assert.ok(f.scheduler.getStatus().lastSuccessAt);
  assert.equal(f.scheduler.getStatus().lastError, false);
});

test('idempotent dispatch IDs change only for an explicit new dispatch generation or scope', () => {
  const ref = reference(makeDue());
  assert.equal(reminderMessageId('a', ref), reminderMessageId('a', { ...ref }));
  assert.notEqual(reminderMessageId('a', ref), reminderMessageId('b', ref));
  assert.notEqual(
    reminderMessageId('a', ref),
    reminderMessageId('a', { ...ref, dispatchGeneration: 1 }),
  );
  const evidence = { kind: 'reminder', version: 1, ...ref };
  assert.equal(reminderEvidenceMatches(evidence, ref), true);
  assert.equal(reminderEvidenceMatches({ ...evidence, ownerEmployeeId: 24 }, ref), false);
  assert.equal(reminderEvidenceMatches({ ...evidence, extra: 'authority' }, ref), false);
});

test('inactive and reassigned recipients never enqueue; a full queue never reports admission', async () => {
  for (const identity of [
    null,
    { ...employee, active: false },
    { ...employee, phoneE164: '+919000000024' },
  ]) {
    const f = schedulerFixture({ resolve: async () => identity });
    await f.scheduler.tick();
    assert.equal(f.enqueues, 0);
    assert.deepEqual(f.releases, [{ reason: 'recipient_unavailable', terminal: 'suppressed' }]);
  }
  const full = schedulerFixture({ full: true });
  await full.scheduler.tick();
  assert.equal(full.wakes, 0);
});

test('lost preparation lease aborts an uncooperative identity lookup without enqueue', async () => {
  const f = schedulerFixture({ resolve: async () => new Promise(() => {}), renew: false });
  const keepAlive = setTimeout(() => {}, 3000);
  try {
    await f.scheduler.tick();
  } finally {
    clearTimeout(keepAlive);
  }
  assert.equal(f.enqueues, 0);
  assert.equal(f.releases[0]?.reason, 'preparation_retry');
  assert.equal(f.scheduler.getStatus().lastError, true);
});

test('stop aborts active preparation and drains it without dropping schedule intent', async () => {
  let entered!: () => void;
  const entry = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const f = schedulerFixture({
    resolve: async () => {
      entered();
      return new Promise(() => {});
    },
  });
  f.scheduler.start();
  await entry;
  await f.scheduler.stop();
  assert.equal(f.enqueues, 0);
  assert.equal(f.releases[0]?.reason, 'scheduler_paused');
  assert.equal(f.scheduler.getStatus().running, false);
});

async function deliver(options?: {
  identity?: EmployeeIdentity | null;
  tamper?: boolean;
  yield?: boolean;
  uncertain?: boolean;
}) {
  const due = makeDue(),
    ref = reference(due),
    key = randomBytes(32).toString('base64url'),
    cipher = authCipher(key);
  const id = reminderMessageId('synthetic', ref),
    controller = new AbortController();
  const job: MessageJob = {
    id,
    token: randomUUID(),
    direction: 'outbound',
    origin: 'reminder',
    attempts: 1,
    chatId: due.chatId,
    payload: 'not-a-whatsapp-message',
    replyKind: 'business',
    reminder: ref,
    replyPayload: cipher.seal('outbound-reply', id, encodeReply('Synthetic reminder', true)),
    businessEvidence: cipher.seal('business-delivery', id, {
      kind: 'reminder',
      version: 1,
      ...ref,
      ...(options?.tamper ? { dispatchGeneration: 99 } : {}),
    }),
  };
  let claimed = false,
    sends = 0,
    began = 0,
    preflights = 0,
    state: string | undefined;
  const queue = new DurableMessages(
    {
      async enqueue() {
        throw new Error('No inbound');
      },
      async claimInbound() {
        return null;
      },
      async claimOutbound() {
        if (claimed) return null;
        claimed = true;
        return job;
      },
      async handoff() {
        throw new Error('No graph');
      },
      async yieldReminderToHuman() {
        if (options?.yield) {
          state = 'yielded';
          controller.abort();
          return true;
        }
        return false;
      },
      async beginSend(_job, proof) {
        began++;
        assert.equal(proof?.employee.employeeId, 23);
        assert.ok(proof?.checkedAtMs);
        return true;
      },
      async complete(_job, result) {
        state = result;
        controller.abort();
        return true;
      },
      async releaseUnsent() {
        state = 'released';
        controller.abort();
      },
    },
    {
      encryptionKey: key,
      maxAgeMs: 300000,
      capacity: 100,
      leaseMs: 30000,
      pollMs: 5,
      waitBeforeReply: async () => true,
      prepareReply: async () => {
        throw new Error('No agent allowed');
      },
      businessPreflight: async () => {
        throw new Error('Not a Context Engine delivery');
      },
      reminderEmployee: async (employeeId, _signal, chatId) => {
        preflights++;
        assert.equal(employeeId, 23);
        assert.equal(chatId, due.chatId);
        return options && 'identity' in options ? options.identity! : employee;
      },
    },
  );
  const session: WhatsAppSession = {
    botJids: [],
    on: () => () => {},
    async close() {},
    async saveCredentials() {},
    async reply() {
      throw new Error('Must not quote a fake inbound');
    },
    async sendText(chatId, text) {
      assert.equal(chatId, due.chatId);
      assert.equal(text, 'Synthetic reminder');
      sends++;
      if (options?.uncertain) throw new Error('Unknown send result');
    },
  };
  await queue.consume(session, controller.signal, () => {});
  return { sends, began, preflights, state };
}

test('private reminder delivery rechecks current recipient and passes the final fence', async () => {
  assert.deepEqual(await deliver(), { sends: 1, began: 1, preflights: 1, state: 'SENT' });
  assert.deepEqual(await deliver({ identity: null }), {
    sends: 0,
    began: 0,
    preflights: 1,
    state: 'EXPIRED',
  });
  assert.deepEqual(await deliver({ tamper: true }), {
    sends: 0,
    began: 0,
    preflights: 0,
    state: 'FAILED',
  });
  assert.deepEqual(await deliver({ yield: true }), {
    sends: 0,
    began: 0,
    preflights: 0,
    state: 'yielded',
  });
  assert.deepEqual(await deliver({ uncertain: true }), {
    sends: 1,
    began: 1,
    preflights: 1,
    state: 'UNCERTAIN',
  });
});

test('debounced command members preserve individual trusted clocks and forward flags', async () => {
  const key = randomBytes(32).toString('base64url'),
    cipher = authCipher(key),
    controller = new AbortController();
  const ids = [randomUUID(), randomUUID()];
  const times = [new Date('2026-10-03T18:29:59Z'), new Date('2026-10-03T18:30:01Z')];
  const originals: WAMessage[] = [
    {
      key: { remoteJid: '123456789012345@lid', id: 'forward' },
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: {
        extendedTextMessage: {
          text: 'A forwarded instruction is context',
          contextInfo: { isForwarded: true },
        },
      },
    },
    {
      key: { remoteJid: '123456789012345@lid', id: 'command' },
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: { conversation: 'Remind me tomorrow at 9 am to review the proposal' },
    },
  ];
  const payload = (index: number) =>
    cipher.seal(
      'message',
      ids[index]!,
      Buffer.from(proto.WebMessageInfo.encode(originals[index]!).finish()),
    );
  const job: MessageJob = {
    id: ids[0]!,
    token: 'fake',
    direction: 'inbound',
    attempts: 1,
    payload: payload(0),
    receivedAt: times[0],
    members: [{ id: ids[1]!, payload: payload(1), receivedAt: times[1] }],
  };
  let claimed = false,
    context: TrustedReplyContext | undefined;
  const queue = new DurableMessages(
    {
      async enqueue() {
        return 'queued';
      },
      async claimInbound() {
        if (claimed) return null;
        claimed = true;
        return job;
      },
      async claimOutbound() {
        return null;
      },
      async handoff() {
        controller.abort();
        return true;
      },
      async releaseUnsent() {
        controller.abort();
      },
      async beginSend() {
        throw new Error('No send');
      },
      async complete() {
        controller.abort();
        return true;
      },
    },
    {
      encryptionKey: key,
      maxAgeMs: 300000,
      capacity: 10,
      leaseMs: 30000,
      pollMs: 5,
      waitBeforeReply: async () => true,
      prepareReply: async (_candidate, _signal, trusted) => {
        context = trusted;
        return { text: 'Captured only' };
      },
    },
  );
  await queue.consume(
    {
      botJids: [],
      on: () => () => {},
      async close() {},
      async saveCredentials() {},
      async reply() {
        throw new Error('No real send');
      },
    },
    controller.signal,
    () => {},
  );
  assert.deepEqual(context?.commandMessages, [
    {
      id: ids[0],
      text: 'A forwarded instruction is context',
      receivedAtMs: times[0]!.getTime(),
      forwarded: true,
    },
    {
      id: ids[1],
      text: 'Remind me tomorrow at 9 am to review the proposal',
      receivedAtMs: times[1]!.getTime(),
      forwarded: false,
    },
  ]);
});
