import type { WAMessage } from '@whiskeysockets/baileys';
import { createHash } from 'node:crypto';
import {
  validReminderSourceQuote,
  type ReminderSourceQuote,
} from '../../contracts/reminder-quote.js';

/** Stable opaque ID for a single already-durable reminder dispatch, in the SDK's native format. */
export function reminderTransportMessageId(accountId: string, jobId: string): string {
  return (
    '3EB0' +
    createHash('sha256')
      .update(JSON.stringify(['reminder-delivery-v1', accountId, jobId]))
      .digest('hex')
      .slice(0, 36)
      .toUpperCase()
  );
}

/** No original media bytes, thumbnails, download credentials, or nested quoted content. */
export function reminderQuotedMessage(quote: ReminderSourceQuote, chatId: string): WAMessage {
  if (!validReminderSourceQuote(quote) || quote.chatId !== chatId)
    throw new Error('INVALID_REMINDER_QUOTE');
  return {
    key: { remoteJid: chatId, id: quote.messageId, fromMe: false },
    message:
      quote.kind === 'audio'
        ? { audioMessage: { ptt: true } }
        : quote.kind === 'image'
          ? { imageMessage: { caption: quote.text ?? '' } }
          : quote.kind === 'video'
            ? { videoMessage: { caption: quote.text ?? '' } }
            : quote.kind === 'document'
              ? { documentMessage: { caption: quote.text ?? '' } }
              : { conversation: quote.text },
  };
}
