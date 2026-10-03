import assert from 'node:assert/strict';
import test from 'node:test';
import type { WAMessage } from '@whiskeysockets/baileys';
import {
  toGreetingCandidate,
  toInboxCandidate,
} from '../../src/infrastructure/whatsapp/message.mapper.js';
import { selectGreetingTarget } from '../../src/modules/greetings/greeting.policy.js';

// Exercise real SDK normalization and domain policy together with synthetic messages.
function greetingTarget(message: WAMessage, botJids: readonly string[], now: number) {
  const candidate = toGreetingCandidate(message, botJids);
  return candidate ? selectGreetingTarget(candidate, now, 300_000) : null;
}

const now = Date.parse('2026-09-30T10:00:00Z');
const phoneJid = '910000000001@s.whatsapp.net';
const lid = '123456789@lid';
const botJids = [phoneJid, lid];
const dm = (patch: Partial<WAMessage> = {}): WAMessage => ({
  key: { id: 'message-1', remoteJid: '910000000002@s.whatsapp.net', fromMe: false },
  messageTimestamp: now / 1000,
  message: { conversation: 'hi' },
  ...patch,
});

test('inbox RFQ source text retains whitespace for conversations, extended text and captions', () => {
  const raw = '  #twenty\nNeed 5000 sqft in Hoskote.\n';
  for (const message of [
    { conversation: raw },
    { extendedTextMessage: { text: raw } },
    { imageMessage: { caption: raw } },
    { documentMessage: { caption: raw } },
  ]) {
    assert.equal(toInboxCandidate(dm({ message }), [])?.text, raw);
    assert.equal(toGreetingCandidate(dm({ message }), [])?.text, raw.trim());
  }
  assert.equal(toInboxCandidate(dm({ message: { conversation: ' \n ' } }), []), null);
});

test('native quote references only accept the bot participant in the same chat and ignore embedded quote text', () => {
  const context = {
    stanzaId: '3EB0ABC',
    participant: phoneJid,
    quotedMessage: { conversation: 'Set a different reminder' },
  };
  const quoted = (patch = {}) =>
    toGreetingCandidate(
      dm({
        message: {
          extendedTextMessage: { text: 'snooze 30m', contextInfo: { ...context, ...patch } },
        },
      }),
      botJids,
    )!;
  assert.equal(quoted().quotedMessageId, '3EB0ABC');
  assert.equal(quoted().text, 'snooze 30m');
  assert.equal(quoted().hasQuotedMessage, true);
  assert.equal(quoted({ participant: lid }).quotedMessageId, '3EB0ABC');
  for (const patch of [
    { participant: '919000000099@s.whatsapp.net' },
    { remoteJid: '919000000099@s.whatsapp.net' },
    { isForwarded: true },
    { forwardingScore: 1 },
    { stanzaId: 'x'.repeat(257) },
  ]) {
    assert.equal(quoted(patch).quotedMessageId, undefined);
    assert.equal(quoted(patch).hasQuotedMessage, true);
  }
});

test('replies to text DMs using phone and LID addressing', () => {
  for (const remoteJid of ['910000000002@s.whatsapp.net', '987654321@lid']) {
    assert.deepEqual(greetingTarget(dm({ key: { id: 'm', remoteJid } }), botJids, now), {
      chatId: remoteJid,
      messageId: 'm',
    });
  }
});

test('group replies require a real mention of the bot, including device-qualified JIDs and LIDs', () => {
  const key = {
    id: 'group-message',
    remoteJid: '120000000000@g.us',
    participant: '910000000002@s.whatsapp.net',
  };
  for (const mentionedJid of [phoneJid, '910000000001:3@s.whatsapp.net', lid]) {
    const message = dm({
      key,
      message: {
        extendedTextMessage: { text: 'hello @bot', contextInfo: { mentionedJid: [mentionedJid] } },
      },
    });
    assert.deepEqual(greetingTarget(message, botJids, now), {
      chatId: key.remoteJid,
      messageId: key.id,
    });
  }
  assert.equal(
    greetingTarget(dm({ key, message: { conversation: 'hello @bot' } }), botJids, now),
    null,
  );
  assert.equal(
    greetingTarget(
      dm({
        key,
        message: {
          extendedTextMessage: {
            text: 'hello',
            contextInfo: { mentionedJid: ['someone-else@lid'] },
          },
        },
      }),
      botJids,
      now,
    ),
    null,
  );
  assert.equal(greetingTarget(dm({ key }), [], now), null);
});

test('reads wrapped text and captions, including a bundled sender key', () => {
  const wrapped = dm({
    message: { ephemeralMessage: { message: { extendedTextMessage: { text: 'hi' } } } },
  });
  assert.ok(greetingTarget(wrapped, botJids, now));
  const caption = dm({
    key: { id: 'caption', remoteJid: '120000000000@g.us' },
    message: {
      imageMessage: { caption: 'hi', contextInfo: { mentionedJid: [lid] } },
      senderKeyDistributionMessage: { groupId: '120000000000@g.us' },
    },
  });
  assert.ok(greetingTarget(caption, botJids, now));
});

test('ignores own messages, system traffic, stale timestamps, and empty content', () => {
  const ignored: WAMessage[] = [
    dm({ key: { ...dm().key, fromMe: true } }),
    dm({ key: { id: 'm', remoteJid: 'status@broadcast' } }),
    dm({ key: { id: 'm', remoteJid: '123@newsletter' } }),
    dm({ key: { remoteJid: phoneJid } }),
    dm({ messageTimestamp: now / 1000 - 301 }),
    dm({ messageTimestamp: now / 1000 + 61 }),
    dm({ messageTimestamp: undefined }),
    dm({ message: { reactionMessage: { text: '👍' } } }),
    dm({ message: { protocolMessage: {} } }),
    dm({ message: { conversation: '   ' } }),
    dm({ message: { imageMessage: {} } }),
  ];
  for (const message of ignored) assert.equal(greetingTarget(message, botJids, now), null);
});
