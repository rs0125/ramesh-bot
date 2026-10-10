/**
 * End-to-end transport plumbing for "Add to crm" sent as a reply to the user's own brief:
 * the durable queue must hand the quoted message key to the trusted reply context, where the
 * write path binds it as source data. Synthetic queue; no database or model.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import type { WAMessage } from '@whiskeysockets/baileys';
import type { MessageJob } from '../../src/infrastructure/database/message-queue.repository.js';
import { DurableMessages } from '../../src/infrastructure/whatsapp/durable-messages.js';
import { toInboxCandidate } from '../../src/infrastructure/whatsapp/message.mapper.js';
import type { TrustedReplyContext } from '../../src/modules/greetings/greeting.types.js';

const chat = '910000000002@s.whatsapp.net';
const bot = '910000000001@s.whatsapp.net';

async function trustedFor(contextInfo: Record<string, unknown>) {
  const key = randomBytes(32).toString('base64url');
  const saved: Array<{ id: string; payload: string; content: string; receivedAt: Date }> = [];
  const stop = new AbortController();
  const timeout = setTimeout(() => stop.abort(), 3000);
  let inboundClaimed = false,
    outboundClaimed = false;
  let outbound: MessageJob | undefined;
  let trusted: TrustedReplyContext | undefined;
  const queue = new DurableMessages(
    {
      async enqueue(id, _candidate, payload, _age, _capacity, inbox) {
        saved.push({ id, payload, content: inbox!.content, receivedAt: new Date() });
        return 'queued';
      },
      async claimInbound() {
        if (inboundClaimed) return null;
        inboundClaimed = true;
        return { ...saved[0]!, token: 'lease', attempts: 1, direction: 'inbound', members: [] };
      },
      async handoff(job, replyPayload) {
        outbound = { ...job, direction: 'outbound', replyPayload };
        return true;
      },
      async claimOutbound() {
        if (outboundClaimed || !outbound) return null;
        outboundClaimed = true;
        return outbound;
      },
      async beginSend() {
        return true;
      },
      async complete() {
        stop.abort();
        return true;
      },
      async releaseUnsent() {
        stop.abort();
      },
    },
    {
      encryptionKey: key,
      maxAgeMs: 300000,
      capacity: 5,
      leaseMs: 90000,
      pollMs: 5,
      waitBeforeReply: async () => true,
      prepareReply: async (_candidate, _signal, context) => {
        trusted = context;
        return { text: 'ok' };
      },
    },
  );
  const reply: WAMessage = {
    key: { id: 'reply-1', remoteJid: chat },
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: { extendedTextMessage: { text: 'Add to crm', contextInfo } },
  };
  try {
    await queue.enqueue(reply, toInboxCandidate(reply, [bot])!);
    await queue.consume(
      {
        botJids: [bot],
        on: () => () => {},
        close: async () => {},
        saveCredentials: async () => {},
        reply: async () => {},
      },
      stop.signal,
      () => {},
    );
  } finally {
    clearTimeout(timeout);
  }
  return trusted?.commandMessages?.[0];
}

test('a reply to the user’s own brief reaches the trusted command with its quoted key', async () => {
  const member = await trustedFor({ stanzaId: 'BRIEF-1', participant: chat });
  assert.equal(member?.text, 'Add to crm');
  assert.equal(member?.quotedUserMessageId, 'BRIEF-1');
  assert.equal(member?.quotedMessageId, undefined);
});

test('a reply to the bot keeps only the reminder-quote key', async () => {
  const member = await trustedFor({ stanzaId: 'BOT-1', participant: bot });
  assert.equal(member?.quotedMessageId, 'BOT-1');
  assert.equal(member?.quotedUserMessageId, undefined);
});
