/** Real SDK serialization, fictional messages only. Never connects to WhatsApp. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateWAMessageFromContent, proto } from '@whiskeysockets/baileys';
import { validReminderSourceQuote } from '../../src/contracts/reminder-quote.js';
import { reminderQuotedMessage } from '../../src/infrastructure/whatsapp/reminder-quote.js';
import { decodeReply, encodeReminderReply } from '../../src/modules/messaging/reply-payload.js';

const chatId = '919000000001@s.whatsapp.net';
const quote = {
  chatId,
  messageId: 'original-request',
  kind: 'text' as const,
  text: 'Remind me tomorrow at 10 to call the owner.',
};

test('queued reminder preserves the exact original request in native WhatsApp reply context', () => {
  const saved = encodeReminderReply('⏰ Reminder: call the owner.', quote);
  const decoded = decodeReply(JSON.parse(JSON.stringify(saved)), 'business');
  const quoted = reminderQuotedMessage(decoded.reminder!.quote!, chatId);
  const generated = generateWAMessageFromContent(
    chatId,
    {
      extendedTextMessage: { text: decoded.text },
    },
    { quoted, userJid: '919000000002@s.whatsapp.net' },
  );
  const wire = proto.WebMessageInfo.decode(proto.WebMessageInfo.encode(generated).finish());
  const context = wire.message!.extendedTextMessage!.contextInfo!;
  assert.equal(context.stanzaId, quote.messageId);
  assert.equal(context.participant, chatId);
  assert.equal(context.quotedMessage!.conversation, quote.text);
  assert.ok(wire.message!.extendedTextMessage!.text!.startsWith('⏰'));
});

test('voice request quote contains only a message reference and audio type, never retained media', () => {
  const quoted = reminderQuotedMessage({ chatId, messageId: 'voice', kind: 'audio' }, chatId);
  const message = generateWAMessageFromContent(
    chatId,
    {
      extendedTextMessage: { text: '⏰ Reminder: call the owner.' },
    },
    { quoted, userJid: '919000000002@s.whatsapp.net' },
  );
  const context = message.message!.extendedTextMessage!.contextInfo!;
  assert.equal(context.stanzaId, 'voice');
  assert.equal(context.quotedMessage!.audioMessage!.ptt, true);
  assert.deepEqual(Object.keys(context.quotedMessage!.audioMessage!), ['ptt']);
});

test('quote rejects a different chat, extra nested content, and transcript/media payloads', () => {
  assert.throws(() => reminderQuotedMessage(quote, '919000000099@s.whatsapp.net'));
  for (const invalid of [
    { ...quote, chatId: '100@g.us' },
    { ...quote, messageId: '' },
    { ...quote, text: '' },
    { ...quote, text: 'x'.repeat(32001) },
    { ...quote, contextInfo: { quotedMessage: 'injected' } },
    { ...quote, kind: 'audio' },
    { chatId, messageId: 'audio', kind: 'audio', url: 'https://example.com' },
  ]) {
    assert.equal(validReminderSourceQuote(invalid), false);
    assert.throws(() =>
      decodeReply({ ...encodeReminderReply('⏰ Reminder'), quote: invalid }, 'business'),
    );
  }
});

test('caption quotes retain their original media type without copying the attachment', () => {
  for (const kind of ['image', 'video', 'document'] as const) {
    const quoted = reminderQuotedMessage(
      { chatId, messageId: kind, kind, text: 'Remind me to review this.' },
      chatId,
    );
    const generated = generateWAMessageFromContent(
      chatId,
      { extendedTextMessage: { text: '⏰ Reminder' } },
      {
        quoted,
        userJid: '919000000002@s.whatsapp.net',
      },
    );
    const context = generated.message!.extendedTextMessage!.contextInfo!;
    assert.equal(context.stanzaId, kind);
    assert.deepEqual(JSON.parse(JSON.stringify(context.quotedMessage)), {
      [`${kind}Message`]: { caption: 'Remind me to review this.' },
    });
  }
});

test('new and legacy reminder payloads decode, while conversational payloads cannot claim reminder authority', () => {
  assert.deepEqual(decodeReply(encodeReminderReply('⏰ Reminder'), 'business'), {
    text: '⏰ Reminder',
    reminder: {},
  });
  assert.deepEqual(decodeReply({ version: 1, kind: 'business', text: 'Reminder' }, 'business'), {
    text: 'Reminder',
  });
  assert.throws(() => decodeReply(encodeReminderReply('⏰ Reminder', quote), 'conversation'));
});
