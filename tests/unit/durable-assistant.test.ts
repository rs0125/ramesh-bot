/** Exercises generated replies through the durable consumer without a real database or WhatsApp socket. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { WAMessage } from '@whiskeysockets/baileys';
import type {
  MessageJob,
  TerminalState,
} from '../../src/infrastructure/database/message-queue.repository.js';
import { DurableMessages } from '../../src/infrastructure/whatsapp/durable-messages.js';
import { toGreetingCandidate } from '../../src/infrastructure/whatsapp/message.mapper.js';
import type { PrepareReply } from '../../src/modules/greetings/greeting.types.js';

async function simulate(
  prepare: PrepareReply,
  send: (text: string) => Promise<void>,
  cancelDuringGeneration = false,
) {
  const controller = new AbortController();
  let stored: MessageJob | undefined;
  let claimed = false;
  let sendStarted = false;
  let state: TerminalState | 'QUEUED' | undefined;
  const queue = new DurableMessages(
    {
      async enqueue(id, _message, payload) {
        stored = { id, payload, token: 'fake-lease', attempts: 1 };
        return 'queued';
      },
      async claim() {
        if (claimed) return null;
        claimed = true;
        return stored!;
      },
      async beginSend() {
        sendStarted = true;
        return true;
      },
      async complete(_job, outcome) {
        state = outcome;
        controller.abort();
        return true;
      },
      async releaseUnsent() {
        state = 'QUEUED';
        controller.abort();
      },
    },
    {
      encryptionKey: randomBytes(32).toString('base64url'),
      maxAgeMs: 300_000,
      capacity: 5,
      leaseMs: 90_000,
      pollMs: 5,
      waitBeforeReply: async () => true,
      prepareReply: async (message, signal) => {
        const reply = await prepare(message, signal);
        if (cancelDuringGeneration) controller.abort();
        return reply;
      },
    },
  );
  const original: WAMessage = {
    key: { remoteJid: 'local-test@s.whatsapp.net', id: 'message' },
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: { conversation: 'hello Ramesh' },
  };
  await queue.enqueue(original, toGreetingCandidate(original, [])!);
  await queue.consume(
    {
      botJids: [],
      on: () => () => {},
      async close() {},
      async saveCredentials() {},
      async reply(message, text) {
        assert.equal(message.key.id, original.key.id);
        await send(text);
      },
    },
    controller.signal,
    () => {},
  );
  return { state, sendStarted };
}

test('durable jobs use generated text and commit conversation memory after send', async () => {
  let committed = 0;
  const sent: string[] = [];
  const outcome = await simulate(
    async (message) => {
      assert.equal(message.text, 'hello Ramesh');
      return {
        text: 'Hey! What’s up?',
        onSent: () => {
          committed++;
        },
      };
    },
    async (text) => {
      assert.equal(committed, 0);
      sent.push(text);
    },
  );
  assert.equal(outcome.state, 'SENT');
  assert.deepEqual(sent, ['Hey! What’s up?']);
  assert.equal(committed, 1);
});

test('disconnect during generation releases unsent work without entering SENDING', async () => {
  const outcome = await simulate(
    async () => ({ text: 'unused' }),
    async () => assert.fail('Must not send'),
    true,
  );
  assert.equal(outcome.state, 'QUEUED');
  assert.equal(outcome.sendStarted, false);
});

test('an uncertain transport result does not commit conversation memory or retry the send', async () => {
  let sends = 0;
  const outcome = await simulate(
    async () => ({ text: 'reply', onSent: () => assert.fail('Must not remember') }),
    async () => {
      sends++;
      throw new Error('Uncertain send');
    },
  );
  assert.equal(outcome.state, 'UNCERTAIN');
  assert.equal(sends, 1);
});
