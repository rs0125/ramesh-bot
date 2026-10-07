/** Encrypted stored replies must remain readable in the admin inbox across payload versions. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { InboxRepository } from '../../src/infrastructure/database/inbox.repository.js';
import { authCipher } from '../../src/infrastructure/database/auth-store.js';
import { PRIVATE_HISTORY_REPLY } from '../../src/modules/assistant/conversation-memory.js';
import { mediaOwner } from '../../src/modules/media/media.service.js';
import type { MediaRecord } from '../../src/modules/media/media.types.js';

const reply = 'Acme needs 40,000 sqft. Contact Alex on +91 98765 43210.';
const chatId = '20000000000@s.whatsapp.net';

function fixture(payload: unknown = { version: 1, kind: 'business', text: reply }) {
  const key = randomBytes(32).toString('base64url');
  const cipher = authCipher(key);
  const id = randomUUID();
  const at = new Date('2026-10-06T10:00:00.000Z');
  const receipt = { fixture: 'protected delivery evidence' };
  const row = {
    id,
    chat_id: chatId,
    origin: 'whatsapp',
    mentions_bot: false,
    content_encrypted: cipher.seal('inbox', id, {
      text: 'Show the Acme requirement',
      senderId: chatId,
      senderName: 'Alex',
      chatName: null,
      kind: 'text',
    }),
    reply_encrypted: cipher.seal('outbound-reply', id, payload),
    reply_kind: 'business',
    business_evidence_encrypted: cipher.seal('business-delivery', id, receipt),
    state: 'SENT',
    sent_at: at,
    created_at: at,
    updated_at: at,
    created_cursor: at.toISOString(),
    updated_cursor: at.toISOString(),
    reply_created_at: at,
    finished_at: at,
    direction: 'outbound',
    context_cursor: `${at.toISOString()}:${id}:1`,
  };
  const pool = { query: async () => ({ rows: [{ ...row }] }) } as unknown as Pool;
  return {
    inbox: new InboxRepository(pool, 'fixture-account', key),
    row,
    receipt,
    pool,
    cipher,
    key,
  };
}

test('voice retries and corrections hydrate the exact historical message within media retention', async () => {
  const f = fixture();
  const at = new Date(Date.now() - 60000);
  const owner = mediaOwner('fixture-account', chatId, chatId);
  const record: MediaRecord = {
    id: randomUUID(),
    owner,
    source: 'voice-source',
    createdAt: at,
    expiresAt: new Date(Date.now() + 3600000),
    state: 'ready',
    kind: 'audio',
    text: 'Client Lab needs 5000 to 10000 sqft and a shed or BTS.',
  };
  Object.assign(f.row, {
    direction: 'inbound',
    whatsapp_message_id: record.source,
    created_at: at,
    content_encrypted: f.cipher.seal('inbox', f.row.id, {
      text: '[Audio message]',
      senderId: chatId,
      senderName: 'Alex',
      chatName: null,
      kind: 'audio',
      forwarded: false,
    }),
  });
  let lookups = 0;
  const inbox = new InboxRepository(f.pool, 'fixture-account', f.key, {
    async findSource(requestOwner, source) {
      assert.equal(requestOwner, owner);
      assert.equal(source, record.source);
      lookups++;
      return record.id;
    },
    async get(requestOwner, ids) {
      assert.equal(requestOwner, owner);
      assert.deepEqual(ids, [record.id]);
      return [record];
    },
  });
  const trigger = {
    chatId,
    messageId: randomUUID(),
    sentAtMs: Date.now(),
    fromMe: false,
    isGroup: false,
    mentionsBot: false,
  };
  for (const text of ['Retry', '1359 is RCC. I want either bts or shed']) {
    const page = await inbox.page({ ...trigger, text }, '', 'z');
    assert.equal(page.entries[0]!.content, '[Audio message]');
    assert.match(page.entries[0]!.transientContent!.text, /Client Lab.*5000 to 10000/);
    const fallback = await inbox.context({ ...trigger, text });
    assert.match(fallback.find((entry) => entry.role === 'user')!.content, /Client Lab/);
  }
  record.expiresAt = new Date(Date.now() - 1);
  assert.equal((await inbox.page(trigger, '', 'z')).entries[0]!.transientContent, undefined);
  const prior = lookups;
  assert.equal(
    (await inbox.page({ ...trigger, isGroup: true }, '', 'z')).entries[0]!.transientContent,
    undefined,
  );
  assert.equal(lookups, prior, 'private voice context is not fetched for a group');
});

for (const payload of [
  { version: 1, kind: 'business', text: reply },
  { version: 2, kind: 'business', text: reply },
  { version: 4, kind: 'reminder', text: reply },
]) {
  test(`admin messages and previews show stored reply text for payload v${payload.version}`, async () => {
    const { inbox } = fixture(payload);
    const page = await inbox.messages(chatId);
    assert.equal(page.messages.find((item) => item.direction === 'outbound')?.text, reply);
    assert.equal((await inbox.conversations()).conversations[0]?.lastMessage, reply);
  });
}

test('redacted inbox policy remains available per request without changing the default', async () => {
  const { inbox } = fixture();
  assert.equal(
    (await inbox.messages(chatId, null, 'redacted')).messages.at(-1)?.text,
    '[Private CRM reply]',
  );
  assert.equal(
    (await inbox.conversations(null, 'redacted')).conversations[0]?.lastMessage,
    '[Private CRM reply]',
  );
  assert.equal((await inbox.messages(chatId)).messages.at(-1)?.text, reply);
});

test('admin visibility does not expose protected reply bodies in ordinary model history', async () => {
  const { inbox, receipt } = fixture();
  const trigger = {
    chatId,
    messageId: randomUUID(),
    sentAtMs: Date.now(),
    fromMe: false,
    isGroup: false,
    mentionsBot: false,
  };
  const history = await inbox.context(trigger);
  const assistant = history.find((item) => item.role === 'assistant');
  assert.equal(assistant?.content, PRIVATE_HISTORY_REPLY);
  assert.deepEqual(assistant?.protectedReply, { text: reply, receipt });
  assert.equal(assistant?.businessRequest, 'Show the Acme requirement');
  const page = await inbox.page(trigger, '', 'z');
  assert.equal(page.entries[0]?.content, PRIVATE_HISTORY_REPLY);
  assert.deepEqual(page.entries[0]?.protectedReply, { text: reply, receipt });
  assert.equal(page.entries[0]?.businessRequest, 'Show the Acme requirement');
  const groupHistory = await inbox.context({ ...trigger, isGroup: true });
  assert.equal(groupHistory.find((item) => item.role === 'assistant')?.protectedReply, undefined);
});

test('a delayed protected reply keeps its original request after a different client interrupts', async () => {
  const f = fixture();
  const otherId = randomUUID();
  const interruption = {
    ...f.row,
    id: otherId,
    created_at: new Date(f.row.created_at.getTime() + 1),
    reply_encrypted: null,
    business_evidence_encrypted: null,
    state: 'DONE',
    direction: 'inbound',
    content_encrypted: f.cipher.seal('inbox', otherId, {
      text: 'Switch to Fixture Beacon. What is their budget?',
      senderId: chatId,
      senderName: 'Alex',
      chatName: null,
      kind: 'text',
    }),
  };
  f.row.finished_at = new Date(f.row.created_at.getTime() + 2);
  const pool = { query: async () => ({ rows: [interruption, f.row] }) } as unknown as Pool;
  const inbox = new InboxRepository(pool, 'fixture-account', f.key);
  const trigger = {
    chatId,
    messageId: randomUUID(),
    sentAtMs: Date.now(),
    fromMe: false,
    isGroup: false,
    mentionsBot: false,
  };
  const history = await inbox.context(trigger);
  const tail = history.slice(-2);
  assert.match(tail[0]!.content, /Switch to Fixture Beacon/);
  assert.equal(tail[1]!.businessRequest, 'Show the Acme requirement');
  const page = await inbox.page(trigger, '', 'z');
  assert.match(page.entries[0]!.content, /Switch to Fixture Beacon/);
  assert.equal(page.entries[1]!.businessRequest, 'Show the Acme requirement');
});

test('legacy conversation replies still display normally', async () => {
  const { inbox, row } = fixture('Hello, Alex');
  row.reply_kind = 'conversation';
  assert.equal((await inbox.messages(chatId)).messages.at(-1)?.text, 'Hello, Alex');
});
