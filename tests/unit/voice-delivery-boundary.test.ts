/** Frozen full-size answers must reach a single transport send without truncating action receipts. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { proto, type WAMessage } from '@whiskeysockets/baileys';
import { authCipher } from '../../src/infrastructure/database/auth-store.js';
import type { MessageJob } from '../../src/infrastructure/database/message-queue.repository.js';
import { DurableMessages } from '../../src/infrastructure/whatsapp/durable-messages.js';
import { mediaOwner, type MediaService } from '../../src/modules/media/media.service.js';
import type { MediaStore } from '../../src/modules/media/media.types.js';
import {
  MAX_REPLY_CHARACTERS,
  MAX_VOICE_REPLY_CHARACTERS,
} from '../../src/modules/media/voice-reply.js';
import { encodeReply } from '../../src/modules/messaging/reply-payload.js';

test('full-size protected voice reply sends once and completes without retrying or clipping its answer', async () => {
  const encryptionKey = randomBytes(32).toString('base64url');
  const cipher = authCipher(encryptionKey);
  const id = randomUUID();
  const chatId = '20000000000@s.whatsapp.net';
  const owner = mediaOwner('primary', chatId, chatId);
  const ids = Array.from({ length: 8 }, () => randomUUID());
  const answer =
    'Synthetic exact receipt\n'.padEnd(MAX_REPLY_CHARACTERS - 18, 'x') + '\nconfirm ABCDEF12\n';
  const message: WAMessage = {
    key: { id: 'synthetic-voice', remoteJid: chatId },
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: { audioMessage: { ptt: true, mimetype: 'audio/ogg' } },
  };
  const job: MessageJob = {
    id,
    token: 'synthetic-lease',
    attempts: 1,
    direction: 'outbound',
    payload: cipher.seal('message', id, Buffer.from(proto.WebMessageInfo.encode(message).finish())),
    replyPayload: cipher.seal('outbound-reply', id, encodeReply(answer, true, { owner, ids })),
    replyKind: 'business',
    businessEvidence: cipher.seal('business-delivery', id, { syntheticProof: true }),
  };
  const store = {
    async get(boundOwner: string, wanted?: string[]) {
      assert.equal(boundOwner, owner);
      assert.deepEqual(wanted, ids);
      return ids.map((mediaId) => ({
        id: mediaId,
        kind: 'audio',
        state: 'ready',
        text: 'Synthetic voice transcript. '.repeat(30),
      }));
    },
  } as unknown as MediaStore;
  const stop = new AbortController();
  const timeout = setTimeout(() => stop.abort(), 3000);
  let claimed = false;
  let sending = false;
  let retries = 0;
  let terminal: string | undefined;
  const sent: string[] = [];
  const queue = new DurableMessages(
    {
      async enqueue() {
        assert.fail('already persisted');
      },
      async claimInbound() {
        return null;
      },
      async handoff() {
        assert.fail('already handed off');
      },
      async claimOutbound() {
        if (claimed) return null;
        claimed = true;
        return job;
      },
      async beginSend() {
        sending = true;
        return true;
      },
      async complete(_job, state) {
        terminal = state;
        stop.abort();
        return true;
      },
      async releaseUnsent() {
        retries++;
        stop.abort();
      },
    },
    {
      encryptionKey,
      maxAgeMs: 300000,
      capacity: 5,
      leaseMs: 90000,
      pollMs: 5,
      media: { store } as MediaService,
      waitBeforeReply: async () => true,
      businessPreflight: async (_message, evidence) => {
        assert.deepEqual(evidence, { syntheticProof: true });
        return true;
      },
      prepareReply: async () => assert.fail('never regenerate a frozen reply'),
    },
  );
  try {
    await queue.consume(
      {
        botJids: [],
        on: () => () => {},
        async saveCredentials() {},
        async close() {},
        async reply(original, text) {
          assert.equal(original.key.id, 'synthetic-voice');
          assert.equal(sending, true);
          sent.push(text);
        },
      },
      stop.signal,
      () => {},
    );
  } finally {
    clearTimeout(timeout);
  }
  assert.equal(terminal, 'SENT');
  assert.equal(retries, 0);
  assert.equal(sent.length, 1);
  assert.ok(sent[0]!.endsWith(`\n\n${answer}`));
  assert.ok(sent[0]!.length <= MAX_VOICE_REPLY_CHARACTERS);
  assert.equal((sent[0]!.match(/Voice note \d/g) ?? []).length, 8);
});
