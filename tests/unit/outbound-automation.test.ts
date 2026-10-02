/** Synthetic encrypted admission and fake send callbacks; never opens a WhatsApp socket. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  AutomationOutboundService,
  automationMessageId,
} from '../../src/modules/messaging/outbound-automation.js';
import { decodeReply } from '../../src/modules/messaging/reply-payload.js';
import { authCipher } from '../../src/infrastructure/database/auth-store.js';
import { DurableMessages } from '../../src/infrastructure/whatsapp/durable-messages.js';
import {
  outboundMediaMessage,
  type WhatsAppSession,
} from '../../src/infrastructure/whatsapp/baileys-session.js';
import type {
  MessageJob,
  MessageQueueRepository,
} from '../../src/infrastructure/database/message-queue.repository.js';
import type {
  OutboundAutomationRequest,
  AutomationEnqueueResult,
} from '../../src/contracts/outbound-automation.js';

const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9r8AAAAASUVORK5CYII=',
  'base64',
);
const message: OutboundAutomationRequest = {
  to: '+919000000123',
  text: 'Here is the requested document.',
  expiresInSeconds: 900,
  media: {
    mimeType: 'application/pdf',
    fileName: 'example.pdf',
    dataBase64: pdf.toString('base64'),
  },
};
function fixture() {
  const key = randomBytes(32).toString('base64url');
  let row: MessageJob | undefined;
  let persisted: Parameters<MessageQueueRepository['enqueueAutomation']> | undefined;
  let claimed = false,
    sendsStarted = 0,
    wakes = 0,
    prepared = 0;
  let result: string | undefined,
    reason: string | null = null;
  const controller = new AbortController();
  const queue = {
    accountId: 'synthetic-account',
    async enqueueAutomation(
      ...args: Parameters<MessageQueueRepository['enqueueAutomation']>
    ): Promise<AutomationEnqueueResult> {
      if (persisted)
        return persisted[0] === args[0] && persisted[5] === args[5] ? 'duplicate' : 'conflict';
      persisted = args;
      row = {
        id: args[0],
        token: 'synthetic-lease',
        direction: 'outbound',
        origin: 'automation',
        chatId: args[1],
        payload: args[3],
        replyPayload: args[3],
        attempts: 1,
        replyKind: 'conversation',
        mediaPayload: args[7]?.payload,
      };
      return 'queued';
    },
    async automationStatus(id: string) {
      return row?.id === id
        ? {
            messageId: id,
            state: result ?? 'READY_TO_SEND',
            createdAt: new Date(0).toISOString(),
            expiresAt: new Date(900000).toISOString(),
            finishedAt: null,
            reason,
          }
        : null;
    },
    async enqueue() {
      throw new Error('No inbound admission allowed');
    },
    async claimInbound() {
      return null;
    },
    async claimOutbound() {
      if (claimed) return null;
      claimed = true;
      return row ?? null;
    },
    async handoff() {
      throw new Error('No graph handoff allowed');
    },
    async beginSend() {
      sendsStarted++;
      return true;
    },
    async complete(_job: MessageJob, state: string, failure: string | null = null) {
      result = state;
      reason = failure;
      controller.abort();
      return true;
    },
    async releaseUnsent() {
      result = 'QUEUED';
      controller.abort();
    },
  };
  const durable = new DurableMessages(queue, {
    encryptionKey: key,
    maxAgeMs: 300000,
    capacity: 20,
    leaseMs: 30000,
    pollMs: 10,
    waitBeforeReply: async () => true,
    prepareReply: async () => {
      prepared++;
      throw new Error('Automation must not invoke the agent');
    },
  });
  const service = new AutomationOutboundService(queue, key, 20, () => {
    wakes++;
    durable.notifyOutbound();
  });
  const session: WhatsAppSession = {
    botJids: [],
    on: () => () => {},
    async saveCredentials() {},
    async close() {},
    async reply() {
      assert.fail('Automation must not manufacture a quoted inbound message');
    },
    async sendText() {
      assert.fail('Media and caption must use one media send');
    },
    async sendMedia() {},
  };
  return {
    key,
    queue,
    service,
    durable,
    session,
    controller,
    row: () => row!,
    stored: () => persisted!,
    counters: () => ({ sendsStarted, wakes, prepared, result, reason }),
    run: () => durable.consume(session, controller.signal, () => {}),
  };
}

test('automation binds idempotency to account and normalized content while encrypting media separately', async () => {
  const f = fixture();
  const first = await f.service.enqueue('crm-event/123', message);
  const second = await f.service.enqueue('crm-event/123', message);
  assert.equal(first.status, 'queued');
  assert.equal(second.status, 'duplicate');
  assert.equal(first.messageId, second.messageId);
  assert.notEqual(first.messageId, automationMessageId('another-account', 'crm-event/123'));
  assert.match(
    first.messageId,
    /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
  const cipher = authCipher(f.key);
  const reply = decodeReply(
    cipher.open('outbound-reply', first.messageId, f.stored()[3]),
    'conversation',
  );
  assert.equal(reply.text, message.text);
  assert.equal(reply.automation?.media?.byteLength, pdf.length);
  assert.ok(!JSON.stringify(reply).includes(message.media!.dataBase64));
  assert.throws(() => cipher.open('outbound-reply', first.messageId, f.stored()[7]!.payload));
  const inbox = cipher.open('inbox', first.messageId, f.stored()[2]) as {
    senderId: unknown;
    kind: string;
  };
  assert.equal(inbox.senderId, null);
  assert.equal(inbox.kind, 'document');
  assert.equal(
    (await f.service.enqueue('crm-event/123', { ...message, text: 'changed' })).status,
    'conflict',
  );
  assert.equal((await f.service.status(first.messageId))?.state, 'READY_TO_SEND');
  assert.equal(f.counters().wakes, 1);
});

test('automation PDF sends once with its caption after the durable send boundary and invokes no agent', async () => {
  const f = fixture();
  await f.service.enqueue('pdf', message);
  let calls = 0;
  f.session.sendMedia = async (chatId, media) => {
    calls++;
    assert.equal(f.counters().sendsStarted, 1);
    assert.equal(chatId, '919000000123@s.whatsapp.net');
    assert.deepEqual(media.bytes, pdf);
    assert.equal(media.caption, message.text);
    assert.equal(media.fileName, 'example.pdf');
    const content = outboundMediaMessage(media);
    assert.ok('document' in content);
    assert.deepEqual(content.document, pdf);
  };
  await f.run();
  assert.equal(calls, 1);
  assert.equal(f.counters().result, 'SENT');
  assert.equal(f.counters().prepared, 0);
});

test('image-only automation accepts an empty caption without a separate text send or thumbnail decoder', async () => {
  const f = fixture();
  await f.service.enqueue('image', {
    ...message,
    text: '',
    media: { mimeType: 'image/png', fileName: 'example.png', dataBase64: png.toString('base64') },
  });
  f.session.sendMedia = async (_chatId, media) => {
    assert.equal(media.caption, '');
    const content = outboundMediaMessage(media);
    assert.ok('image' in content);
    assert.deepEqual(content.image, png);
    assert.equal(content.jpegThumbnail, '');
  };
  await f.run();
  assert.equal(f.counters().result, 'SENT');
});

test('text-only automation takes the direct send path even with no inbound message', async () => {
  const f = fixture();
  await f.service.enqueue('text', { ...message, media: undefined });
  let sent = 0;
  f.session.sendText = async (chatId, text) => {
    sent++;
    assert.equal(chatId, '919000000123@s.whatsapp.net');
    assert.equal(text, message.text);
  };
  f.session.sendMedia = async () => assert.fail('Text-only automation must not use media');
  await f.run();
  assert.equal(sent, 1);
  assert.equal(f.counters().result, 'SENT');
});

test('mismatched encrypted media and unsafe destinations fail before entering SENDING', async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.row().mediaPayload = f.row().replyPayload;
    },
    (f: ReturnType<typeof fixture>) => {
      f.row().mediaPayload = undefined;
    },
    (f: ReturnType<typeof fixture>) => {
      f.row().chatId = 'synthetic@g.us';
    },
    (f: ReturnType<typeof fixture>) => {
      f.row().replyPayload = authCipher(f.key).seal('outbound-reply', f.row().id, 'legacy string');
    },
    (f: ReturnType<typeof fixture>) => {
      const media = {
        version: 1,
        ...message.media!,
        dataBase64: Buffer.from('%PDF-1.4 changed').toString('base64'),
      };
      f.row().mediaPayload = authCipher(f.key).seal('outbound-media', f.row().id, media);
    },
  ]) {
    const f = fixture();
    await f.service.enqueue('bad', message);
    mutate(f);
    f.session.sendMedia = async () => assert.fail('Invalid payload cannot cross send boundary');
    await f.run();
    assert.equal(f.counters().result, 'FAILED');
    assert.equal(f.counters().sendsStarted, 0);
    assert.equal(f.counters().reason, 'invalid_automation_media');
  }
});

test('a media timeout remains UNCERTAIN and does not retry a second send', async () => {
  const f = fixture();
  await f.service.enqueue('uncertain', message);
  let sends = 0;
  f.session.sendMedia = async () => {
    sends++;
    throw new Error('Synthetic ambiguous media timeout');
  };
  await f.run();
  assert.equal(sends, 1);
  assert.equal(f.counters().result, 'UNCERTAIN');
});

test('cancellation during pacing releases unsent automation without touching the transport', async () => {
  const f = fixture();
  await f.service.enqueue('cancelled', message);
  const durable = new DurableMessages(f.queue, {
    encryptionKey: f.key,
    maxAgeMs: 300000,
    capacity: 20,
    leaseMs: 30000,
    pollMs: 10,
    waitBeforeReply: async () => {
      f.controller.abort();
      return false;
    },
  });
  f.session.sendMedia = async () => assert.fail('Cancelled work must not send');
  await durable.consume(f.session, f.controller.signal, () => {});
  assert.equal(f.counters().result, 'QUEUED');
  assert.equal(f.counters().sendsStarted, 0);
});

test('media transport refuses URLs and preserves existing reply versions', () => {
  assert.throws(() =>
    outboundMediaMessage({
      bytes: { url: 'https://example.com/file.pdf' },
      mimeType: 'application/pdf',
      fileName: 'example.pdf',
      caption: '',
    } as never),
  );
  assert.equal(decodeReply('hello', 'conversation').text, 'hello');
  assert.equal(
    decodeReply({ version: 1, kind: 'business', text: 'verified' }, 'business').text,
    'verified',
  );
  assert.throws(() =>
    decodeReply({ version: 3, kind: 'automation', text: 'x', voice: {} }, 'conversation'),
  );
  assert.throws(() => decodeReply({ version: 3, kind: 'automation', text: 'x' }, 'business'));
});
