/** Exercises generated replies through the durable consumer without a real database or WhatsApp socket. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { proto, type WAMessage } from '@whiskeysockets/baileys';
import { authCipher } from '../../src/infrastructure/database/auth-store.js';
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
  feedback: {
    react?: (message: Pick<WAMessage, 'key'>) => void;
    members?: WAMessage[];
    claim?: () => Promise<boolean>;
  } = {},
) {
  const controller = new AbortController();
  let stored: MessageJob | undefined;
  let claimed = false;
  let sendStarted = false;
  let outboundClaimed = false;
  let state: TerminalState | 'QUEUED' | undefined;
  const encryptionKey = randomBytes(32).toString('base64url');
  const cipher = authCipher(encryptionKey);
  const queue = new DurableMessages(
    {
      async enqueue(id, _message, payload) {
        stored = {
          id,
          payload,
          token: 'fake-lease',
          attempts: 1,
          direction: 'inbound',
          members: feedback.members?.map((message, index) => ({
            id: `member-${index}`,
            payload: cipher.seal(
              'message',
              `member-${index}`,
              Buffer.from(proto.WebMessageInfo.encode(message).finish()),
            ),
            receivedAt: new Date(),
          })),
        };
        return 'queued';
      },
      async claimInbound() {
        if (claimed) return null;
        claimed = true;
        return stored!;
      },
      claimAcknowledgement: feedback.claim,
      async handoff(_job, replyPayload) {
        stored = { ...stored!, direction: 'outbound', replyPayload };
        return true;
      },
      async claimOutbound() {
        if (stored?.direction !== 'outbound' || outboundClaimed) return null;
        outboundClaimed = true;
        return stored;
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
      encryptionKey,
      maxAgeMs: 300_000,
      capacity: 5,
      leaseMs: 90_000,
      pollMs: 5,
      waitBeforeReply: async () => true,
      prepareReply: async (message, signal, trusted) => {
        const reply = await prepare(message, signal, trusted);
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
      acknowledgeToolUse: feedback.react,
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

test('tool work acknowledges the original prompt once and reaction failure preserves the answer', async () => {
  const targets: string[] = [];
  const outcome = await simulate(
    async (_message, _signal, trusted) => {
      trusted!.onToolActivity!();
      trusted!.onToolActivity!();
      return { text: 'The requested work is ready.' };
    },
    async () => {},
    false,
    {
      react: (message) => {
        targets.push(message.key.id!);
        throw new Error('reaction transport failed');
      },
    },
  );
  assert.equal(outcome.state, 'SENT');
  assert.deepEqual(targets, ['message']);
});

test('plain chat does not acquire a tool reaction', async () => {
  await simulate(
    async () => ({ text: 'Hello!' }),
    async () => {},
    false,
    {
      react: () => assert.fail('No tool work took place'),
    },
  );
});

test('a delayed acknowledgement claim cannot send progress after the answer is ready', async () => {
  let release!: (value: boolean) => void;
  const held = new Promise<boolean>((resolve) => {
    release = resolve;
  });
  const outcome = await simulate(
    async (_message, _signal, trusted) => {
      trusted!.onToolActivity!();
      return { text: 'Already finished.' };
    },
    async () => {},
    false,
    {
      claim: () => held,
      react: () => assert.fail('Finished answers must not receive late progress text'),
    },
  );
  release(true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(outcome.state, 'SENT');
});

test('a forwarded burst acknowledges the latest direct instruction, once for the batch', async () => {
  const members: WAMessage[] = ['instruction', 'forward'].map((id) => ({
    key: { remoteJid: 'local-test@s.whatsapp.net', id },
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: {
      extendedTextMessage: {
        text: id === 'instruction' ? 'Summarize these please' : 'One more source',
        contextInfo: { isForwarded: id === 'forward' },
      },
    },
  }));
  const targets: string[] = [];
  const outcome = await simulate(
    async (_message, _signal, trusted) => {
      trusted!.onToolActivity!();
      trusted!.onToolActivity!();
      return { text: 'Summary ready.' };
    },
    async () => {},
    false,
    { members, react: (message) => void targets.push(message.key.id!) },
  );
  assert.equal(outcome.state, 'SENT');
  assert.deepEqual(targets, ['instruction']);
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
