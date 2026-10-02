/** Offline orchestration regressions. Fake providers, fake queues, no database or WhatsApp sends. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { WAMessage } from '@whiskeysockets/baileys';
import { AssistantService } from '../../src/modules/assistant/assistant.service.js';
import {
  currentUsageScope,
  withUsageScope,
  type UsageScope,
} from '../../src/modules/usage/usage-scope.js';
import { DurableMessages } from '../../src/infrastructure/whatsapp/durable-messages.js';
import { toInboxCandidate } from '../../src/infrastructure/whatsapp/message.mapper.js';
import type { MessageJob } from '../../src/infrastructure/database/message-queue.repository.js';
import type { WhatsAppSession } from '../../src/infrastructure/whatsapp/baileys-session.js';
import { MediaService, mediaOwner } from '../../src/modules/media/media.service.js';
import type { MediaRecord, MediaStore } from '../../src/modules/media/media.types.js';
import type { TextModel } from '../../src/modules/assistant/assistant.types.js';
import { LiveChat } from '../../scripts/lib/live-chat.js';
import type {
  CapturedReply,
  PlaygroundRepository,
} from '../../src/infrastructure/database/playground.repository.js';
import { BusinessReadService } from '../../src/modules/assistant/business-reads.js';

const phone = '919000000023@s.whatsapp.net';
const fallback = `sender:${createHash('sha256').update(phone).digest('hex')}`;
const capture = () => structuredClone(currentUsageScope()?.scope);
function model(scopes: Array<UsageScope | undefined>): TextModel {
  return {
    async complete() {
      scopes.push(capture());
      return { text: 'Sure.', inputTokens: 1, outputTokens: 1 };
    },
  };
}
function mediaFixture(
  scopes: Array<UsageScope | undefined>,
  pending?: { owner: string; source: string },
) {
  const upload = { bytes: Buffer.from('OggSfixture'), mime: 'audio/ogg', name: 'fixture.ogg' };
  let record: MediaRecord | undefined = pending
    ? {
        ...pending,
        id: randomUUID(),
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 86400000),
        state: 'pending',
        kind: 'audio',
        upload,
      }
    : undefined;
  const store: MediaStore = {
    async put(owner, source, value) {
      record = {
        id: randomUUID(),
        owner,
        source,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 86400000),
        state: 'pending',
        kind: 'audio',
        upload: value,
      };
      return record.id;
    },
    async get(owner, ids) {
      return record && record.owner === owner && (!ids || ids.includes(record.id))
        ? [structuredClone(record)]
        : [];
    },
    async claim(owner, id) {
      if (!record || record.owner !== owner || record.id !== id || record.state !== 'pending')
        return null;
      record.state = 'processing';
      record.token = 'fixture-lease';
      return { ...record };
    },
    async finish(owner, id, token, result) {
      assert.equal(owner, record?.owner);
      assert.equal(id, record?.id);
      assert.equal(token, record?.token);
      Object.assign(record!, result, { state: 'text' in result ? 'ready' : 'failed' });
    },
    async clear() {
      record = undefined;
    },
    async clean() {},
  };
  return {
    upload,
    store,
    get record() {
      return record;
    },
    service: new MediaService(store, {
      async extract() {
        scopes.push(capture());
        return 'Fixture audio.';
      },
    }),
  };
}

async function durable(options: {
  mode: 'off' | 'observe' | 'enforce';
  employee?: number;
  identityFailure?: boolean;
  resumed?: boolean;
  background?: boolean;
}) {
  const controller = new AbortController();
  const extracts: Array<UsageScope | undefined> = [],
    completions: Array<UsageScope | undefined> = [];
  const warnings: string[] = [];
  let row: MessageJob | undefined,
    claimed = false,
    handedOff = false,
    identityCalls = 0,
    runQueries = 0;
  const original: WAMessage = {
    key: { remoteJid: phone, id: 'fixture-audio', fromMe: false },
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: { audioMessage: { mimetype: 'audio/ogg', ptt: true } },
  };
  const media = mediaFixture(
    extracts,
    options.resumed
      ? { owner: mediaOwner('primary', phone, phone), source: 'fixture-audio' }
      : undefined,
  );
  const assistant = new AssistantService({ model: 'fixture', timeoutMs: 1000 }, model(completions));
  const session: WhatsAppSession = {
    botJids: [],
    on: () => () => {},
    async close() {},
    async saveCredentials() {},
    async downloadMedia() {
      return media.upload;
    },
    async reply() {
      assert.fail('No delivery permitted');
    },
  };
  const queue = new DurableMessages(
    {
      async enqueue(id, _candidate, payload) {
        row = { id, payload, direction: 'inbound', token: 'fixture', attempts: 1 };
        return 'queued';
      },
      async claimInbound() {
        if (claimed) return null;
        claimed = true;
        return row!;
      },
      async claimOutbound() {
        return null;
      },
      async handoff() {
        handedOff = true;
        controller.abort();
        return true;
      },
      async beginSend() {
        assert.fail('No sender permitted');
      },
      async releaseUnsent() {
        controller.abort();
      },
      async complete() {
        controller.abort();
        return true;
      },
      async usageRunId() {
        runQueries++;
        return row!.id;
      },
    },
    {
      encryptionKey: randomBytes(32).toString('base64url'),
      maxAgeMs: 300000,
      capacity: 5,
      leaseMs: 90000,
      pollMs: 5,
      waitBeforeReply: async () => true,
      media: media.service,
      usageMode: options.mode,
      async usageEmployee() {
        identityCalls++;
        if (options.identityFailure) throw new Error('private roster detail');
        return options.employee;
      },
      onUsageAttributionFailure: (reason) => warnings.push(reason),
      prepareReply: assistant.prepare.bind(assistant),
    },
  );
  await queue.enqueue(
    original,
    toInboxCandidate(original, [])!,
    options.background ? session : undefined,
  );
  await queue.consume(session, controller.signal, () => {});
  await media.service.drain();
  return { extracts, completions, warnings, identityCalls, runQueries, handedOff, id: row!.id };
}

test('resumed media and conversational model calls share the verified employee and durable run', async () => {
  const result = await durable({ mode: 'enforce', employee: 23, resumed: true });
  assert.equal(result.handedOff, true);
  assert.equal(result.extracts.length, 1);
  assert.equal(result.completions.length, 2);
  for (const scope of [...result.extracts, ...result.completions])
    assert.deepEqual(scope, { runId: result.id, subjectId: 'employee:23' });
});

test('background media shares the admitted root and verified employee with later model calls', async () => {
  const result = await durable({ mode: 'enforce', employee: 23, background: true });
  assert.equal(result.handedOff, true);
  assert.equal(result.runQueries, 1);
  for (const scope of [...result.extracts, ...result.completions])
    assert.deepEqual(scope, { runId: result.id, subjectId: 'employee:23' });
});

test('accounting off makes no identity or batch-attribution lookups for attachments', async () => {
  const result = await durable({ mode: 'off', identityFailure: true, background: true });
  assert.equal(result.handedOff, true);
  assert.equal(result.identityCalls, 0);
  assert.equal(result.runQueries, 0);
  assert.equal(result.extracts.length, 1);
});

test('observe mode logs sanitized resolver failure and preserves ordinary media/chat under sender identity', async () => {
  const result = await durable({ mode: 'observe', identityFailure: true, resumed: true });
  assert.equal(result.handedOff, true);
  assert.deepEqual(result.warnings, ['USAGE_IDENTITY_UNAVAILABLE']);
  for (const scope of [...result.extracts, ...result.completions])
    assert.deepEqual(scope, { runId: result.id, subjectId: fallback });
});

test('enforcement blocks extraction and model work on identity infrastructure failure', async () => {
  const result = await durable({ mode: 'enforce', identityFailure: true, resumed: true });
  assert.equal(result.handedOff, false);
  assert.equal(result.extracts.length, 0);
  assert.equal(result.completions.length, 0);
  assert.deepEqual(result.warnings, ['USAGE_IDENTITY_UNAVAILABLE']);
});

test('an actual unknown user still gets media and chat under its trusted sender budget', async () => {
  const result = await durable({ mode: 'enforce', resumed: true });
  assert.equal(result.handedOff, true);
  assert.deepEqual(result.warnings, []);
  for (const scope of [...result.extracts, ...result.completions])
    assert.deepEqual(scope, { runId: result.id, subjectId: fallback });
});

test('assistant preserves same-turn trusted employee attribution even for ordinary group chat', async () => {
  const completions: Array<UsageScope | undefined> = [];
  const assistant = new AssistantService({ model: 'fixture', timeoutMs: 1000 }, model(completions));
  const runId = randomUUID();
  await withUsageScope({ runId, subjectId: 'employee:23' }, () =>
    assistant.prepare(
      {
        chatId: 'fixture@g.us',
        senderId: phone,
        messageId: 'group-message',
        isGroup: true,
        fromMe: false,
        mentionsBot: true,
        sentAtMs: Date.now(),
        text: 'hello',
      },
      undefined,
      { runId, key: { remoteJid: 'fixture@g.us', participant: phone } },
    ),
  );
  assert.equal(completions.length, 2);
  assert.ok(completions.every((scope) => scope?.subjectId === 'employee:23'));
  assert.equal(currentUsageScope(), undefined);
});

test('assistant cannot inherit an unrelated enclosing run employee', async () => {
  const completions: Array<UsageScope | undefined> = [];
  const assistant = new AssistantService({ model: 'fixture', timeoutMs: 1000 }, model(completions));
  const runId = randomUUID();
  await withUsageScope({ runId: 'unrelated', subjectId: 'employee:99' }, () =>
    assistant.prepare(
      {
        chatId: phone,
        senderId: phone,
        messageId: 'fixture',
        isGroup: false,
        fromMe: false,
        mentionsBot: false,
        sentAtMs: Date.now(),
        text: 'hello',
      },
      undefined,
      { runId, key: { remoteJid: phone } },
    ),
  );
  assert.ok(completions.every((scope) => scope?.subjectId === fallback && scope.runId === runId));
});

test('capture batch member resumes media and generates text under the batch root and configured employee', async () => {
  const root = randomUUID(),
    member = randomUUID(),
    namespace = randomUUID();
  const extracts: Array<UsageScope | undefined> = [],
    completions: Array<UsageScope | undefined> = [];
  const owner = mediaOwner(`${namespace}:23`, 'fixture:false', 'me');
  const media = mediaFixture(extracts, { owner, source: 'fixture' });
  let reply: CapturedReply | undefined;
  const repo = {
    namespace,
    employeeId: 23,
    async clean() {},
    async enqueue() {},
    async batch() {
      return { id: root, availableAt: new Date(Date.now() - 1) };
    },
    async output() {
      return reply ? { state: 'CAPTURED', reply } : null;
    },
    async claim(id: string) {
      assert.equal(id, root);
      return {
        id,
        conversation: 'fixture',
        sender: 'me',
        group: false,
        text: 'summarize attachment',
        token: 'fixture',
        createdAt: new Date(),
        mediaIds: [media.record!.id],
        memberIds: [root, member],
      };
    },
    async history() {
      return [];
    },
    async record() {},
    async release() {},
    async finalize(_job: unknown, result: CapturedReply) {
      reply = result;
    },
  } as unknown as PlaygroundRepository;
  // Tool access denied in this fixture: billing identity still comes from the operator's binding.
  const access = {
    employee: async () => ({
      employeeId: 23,
      phoneE164: '+919000000023',
      email: null,
      active: true,
    }),
    reads: new BusinessReadService(async () => null, [23]),
  };
  const fake = model(completions);
  // The legacy two-node graph's converser needs its routing JSON when business access exists.
  const routing: TextModel = {
    async complete(request, signal) {
      const result = await fake.complete(request, signal);
      return request.stage === 'converser'
        ? { ...result, text: JSON.stringify({ intent: 'chat', language: 'en', draft: 'Sure.' }) }
        : result;
    },
  };
  const chat = new LiveChat(
    { model: 'fixture', timeoutMs: 1000 },
    routing,
    repo,
    access,
    1000,
    media.service,
  );
  const result = await chat.send({
    conversation: 'fixture',
    messageId: member,
    text: 'summarize attachment',
  });
  assert.equal(result.outcome, 'captured');
  assert.equal(extracts.length, 1);
  assert.equal(completions.length, 2);
  for (const scope of [...extracts, ...completions])
    assert.deepEqual(scope, { runId: root, subjectId: 'employee:23' });
  await chat.drain();
});
