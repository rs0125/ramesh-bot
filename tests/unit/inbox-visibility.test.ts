/** Encrypted stored replies must remain readable in the admin inbox across payload versions. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { InboxRepository } from '../../src/infrastructure/database/inbox.repository.js';
import { authCipher } from '../../src/infrastructure/database/auth-store.js';
import { PRIVATE_HISTORY_REPLY } from '../../src/modules/assistant/conversation-memory.js';

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
  return { inbox: new InboxRepository(pool, 'fixture-account', key), row, receipt };
}

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
  const page = await inbox.page(trigger, '', 'z');
  assert.equal(page.entries[0]?.content, PRIVATE_HISTORY_REPLY);
  assert.deepEqual(page.entries[0]?.protectedReply, { text: reply, receipt });
  const groupHistory = await inbox.context({ ...trigger, isGroup: true });
  assert.equal(groupHistory.find((item) => item.role === 'assistant')?.protectedReply, undefined);
});

test('legacy conversation replies still display normally', async () => {
  const { inbox, row } = fixture('Hello, Alex');
  row.reply_kind = 'conversation';
  assert.equal((await inbox.messages(chatId)).messages.at(-1)?.text, 'Hello, Alex');
});
