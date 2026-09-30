/** Translates SDK messages into the small, transport-independent greeting contract. */
import {
  jidNormalizedUser,
  normalizeMessageContent,
  type WAMessage,
} from '@whiskeysockets/baileys';
import type { GreetingCandidate } from '../../modules/greetings/greeting.types.js';

export function toGreetingCandidate(
  message: WAMessage,
  botJids: readonly string[],
): GreetingCandidate | null {
  const { remoteJid: chatId, id: messageId, fromMe } = message.key;
  if (!chatId || !messageId || !message.message) return null;
  const isGroup = chatId.endsWith('@g.us');
  if (!isGroup && !chatId.endsWith('@s.whatsapp.net') && !chatId.endsWith('@lid')) return null;
  const content = normalizeMessageContent(message.message);
  if (!content || content.protocolMessage || content.reactionMessage) return null;
  const text =
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption;
  if (!text?.trim()) return null;

  const mentions =
    content.extendedTextMessage?.contextInfo?.mentionedJid ??
    content.imageMessage?.contextInfo?.mentionedJid ??
    content.videoMessage?.contextInfo?.mentionedJid ??
    [];
  const identities = new Set(botJids.filter(Boolean).map(jidNormalizedUser));
  return {
    chatId,
    messageId,
    fromMe: fromMe === true,
    isGroup,
    sentAtMs: Number(message.messageTimestamp ?? 0) * 1000,
    mentionsBot: mentions.some((jid) => identities.has(jidNormalizedUser(jid))),
  };
}
