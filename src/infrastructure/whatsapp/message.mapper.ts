/** Translates SDK messages into the small, transport-independent greeting contract. */
import { jidNormalizedUser, type WAMessage } from '@whiskeysockets/baileys';
import type { GreetingCandidate } from '../../modules/greetings/greeting.types.js';
import { persistableMessageContent } from './media-privacy.js';
import { mapNativeLocation } from './location.mapper.js';
import { renderNativeLocation } from '../../modules/messaging/native-location.js';

export function toGreetingCandidate(
  message: WAMessage,
  botJids: readonly string[],
): GreetingCandidate | null {
  return mapMessage(message, botJids, false);
}

/** Files remain labels; native pins contain bounded, validated coordinate source data. */
export function toInboxCandidate(
  message: WAMessage,
  botJids: readonly string[],
): GreetingCandidate | null {
  return mapMessage(message, botJids, true);
}

function mapMessage(
  message: WAMessage,
  botJids: readonly string[],
  includeMedia: boolean,
): GreetingCandidate | null {
  const { remoteJid: chatId, id: messageId, fromMe } = message.key;
  if (!chatId || !messageId || !message.message) return null;
  const isGroup = chatId.endsWith('@g.us');
  if (!isGroup && !chatId.endsWith('@s.whatsapp.net') && !chatId.endsWith('@lid')) return null;
  let content: ReturnType<typeof persistableMessageContent>;
  try {
    content = persistableMessageContent(message.message);
  } catch {
    // Do not persist captions, queue work, or download bytes from view-once messages.
    return null;
  }
  if (!content || content.protocolMessage || content.reactionMessage) return null;
  const kind = content.imageMessage
    ? 'image'
    : content.videoMessage
      ? 'video'
      : content.audioMessage
        ? 'audio'
        : content.documentMessage
          ? 'document'
          : content.stickerMessage
            ? 'sticker'
            : content.locationMessage || content.liveLocationMessage
              ? 'location'
              : content.contactMessage || content.contactsArrayMessage
                ? 'contact'
                : content.pollCreationMessage ||
                    content.pollCreationMessageV2 ||
                    content.pollCreationMessageV3
                  ? 'poll'
                  : 'text';
  const location = kind === 'location' ? mapNativeLocation(content) : undefined;
  const text =
    kind === 'location'
      ? renderNativeLocation(location)
      : (content.conversation ??
        content.extendedTextMessage?.text ??
        content.imageMessage?.caption ??
        content.videoMessage?.caption ??
        content.documentMessage?.caption ??
        (includeMedia && kind !== 'text'
          ? `[${kind[0]!.toUpperCase()}${kind.slice(1)} message]`
          : undefined));
  if (!text?.trim()) return null;

  const context =
    content.extendedTextMessage?.contextInfo ??
    content.imageMessage?.contextInfo ??
    content.videoMessage?.contextInfo ??
    content.audioMessage?.contextInfo ??
    content.documentMessage?.contextInfo ??
    content.stickerMessage?.contextInfo ??
    content.locationMessage?.contextInfo ??
    content.liveLocationMessage?.contextInfo;
  const forwarded = context?.isForwarded === true || (context?.forwardingScore ?? 0) > 0;
  const mentions = context?.mentionedJid ?? [];
  const identities = new Set(botJids.filter(Boolean).map(jidNormalizedUser));
  const quoteKey =
    !forwarded &&
    typeof context?.stanzaId === 'string' &&
    context.stanzaId.length > 0 &&
    context.stanzaId.length <= 256 &&
    !/[\x00-\x1f\x7f]/.test(context.stanzaId) &&
    (!context.remoteJid || jidNormalizedUser(context.remoteJid) === jidNormalizedUser(chatId))
      ? context.stanzaId
      : undefined;
  const quotesBot =
    typeof context?.participant === 'string' &&
    identities.has(jidNormalizedUser(context.participant));
  const quotedMessageId = quoteKey && quotesBot ? quoteKey : undefined;
  // In a one-to-one chat a reply to a message that is not the bot's quotes the user's own
  // earlier message (for example an RFQ brief). Its key lets a write read that message as data.
  const quotedUserMessageId = quoteKey && !isGroup && !quotesBot ? quoteKey : undefined;
  return {
    chatId,
    messageId,
    fromMe: fromMe === true,
    isGroup,
    sentAtMs: Number(message.messageTimestamp ?? 0) * 1000,
    mentionsBot: mentions.some((jid) => identities.has(jidNormalizedUser(jid))),
    // Inbox text is source evidence for writes such as CRM RFQs. Retain the
    // original bytes/whitespace; the greeting-only adapter keeps normalization.
    text: includeMedia ? text : text.trim(),
    kind,
    forwarded,
    ...(quotedMessageId ? { quotedMessageId } : {}),
    ...(quotedUserMessageId ? { quotedUserMessageId } : {}),
    ...(context?.stanzaId ? { hasQuotedMessage: true } : {}),
    ...(location ? { location } : {}),
    senderName: message.pushName?.slice(0, 256) || undefined,
    senderId: isGroup
      ? message.key.participant
        ? jidNormalizedUser(message.key.participant)
        : undefined
      : jidNormalizedUser(chatId),
  };
}
