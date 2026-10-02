/** Translates SDK messages into the small, transport-independent greeting contract. */
import { jidNormalizedUser, type WAMessage } from '@whiskeysockets/baileys';
import type { GreetingCandidate } from '../../modules/greetings/greeting.types.js';
import { persistableMessageContent } from './media-privacy.js';

export function toGreetingCandidate(
  message: WAMessage,
  botJids: readonly string[],
): GreetingCandidate | null {
  return mapMessage(message, botJids, false);
}

/** Mapping produces labels only; the separately gated media service processes eligible files. */
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
  const text =
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    content.documentMessage?.caption ??
    (includeMedia && kind !== 'text'
      ? `[${kind[0]!.toUpperCase()}${kind.slice(1)} message]`
      : undefined);
  if (!text?.trim()) return null;

  const context =
    content.extendedTextMessage?.contextInfo ??
    content.imageMessage?.contextInfo ??
    content.videoMessage?.contextInfo ??
    content.audioMessage?.contextInfo ??
    content.documentMessage?.contextInfo ??
    content.stickerMessage?.contextInfo;
  const forwarded = context?.isForwarded === true || (context?.forwardingScore ?? 0) > 0;
  const mentions =
    content.extendedTextMessage?.contextInfo?.mentionedJid ??
    content.imageMessage?.contextInfo?.mentionedJid ??
    content.videoMessage?.contextInfo?.mentionedJid ??
    content.audioMessage?.contextInfo?.mentionedJid ??
    content.documentMessage?.contextInfo?.mentionedJid ??
    content.stickerMessage?.contextInfo?.mentionedJid ??
    [];
  const identities = new Set(botJids.filter(Boolean).map(jidNormalizedUser));
  return {
    chatId,
    messageId,
    fromMe: fromMe === true,
    isGroup,
    sentAtMs: Number(message.messageTimestamp ?? 0) * 1000,
    mentionsBot: mentions.some((jid) => identities.has(jidNormalizedUser(jid))),
    text: text.trim(),
    kind,
    forwarded,
    senderName: message.pushName?.slice(0, 256) || undefined,
    senderId: isGroup
      ? message.key.participant
        ? jidNormalizedUser(message.key.participant)
        : undefined
      : jidNormalizedUser(chatId),
  };
}
