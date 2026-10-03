/** Adapts Baileys sockets, durable encrypted auth, send deadlines, and group metadata caching. */
import type { PrismaClient } from '@prisma/client';
import makeWASocket, {
  downloadMediaMessage,
  type BaileysEventMap,
  type GroupMetadata,
  type WAMessage,
  type AnyMessageContent,
} from '@whiskeysockets/baileys';
import type { OutboundAutomationMedia } from '../../contracts/outbound-automation.js';
import { MAX_MEDIA_BYTES, type MediaUpload } from '../../modules/media/media.types.js';
import type { Logger } from 'pino';
import { createAuthStore } from '../database/auth-store.js';
import { DeliveryReceipts } from './delivery-receipts.js';
import { privateTransportLogger } from './sdk-logger.js';
import { persistableMessageContent } from './media-privacy.js';
import { TransportFeedback } from './transport-feedback.js';
import { TypingPresence } from './typing-presence.js';

export interface WhatsAppSession {
  readonly botJids: readonly string[];
  on<K extends keyof BaileysEventMap>(
    event: K,
    handler: (value: BaileysEventMap[K]) => void,
  ): () => void;
  saveCredentials(): Promise<void>;
  acknowledgeDelivery?(message: WAMessage): void;
  markRead?(message: WAMessage): void;
  acknowledgeToolUse?(message: WAMessage): void;
  startTyping?(chatId: string, signal: AbortSignal): () => void;
  reply(message: WAMessage, text: string, options?: { messageId: string }): Promise<void>;
  sendText?(chatId: string, text: string, options?: { messageId: string }): Promise<void>;
  sendMedia?(chatId: string, media: OutboundMediaSend): Promise<void>;
  downloadMedia?(message: WAMessage, signal: AbortSignal): Promise<MediaUpload>;
  chatName?(chatId: string): Promise<string | undefined>;
  close(): Promise<void>;
}

export interface OutboundMediaSend {
  bytes: Buffer;
  mimeType: OutboundAutomationMedia['mimeType'];
  fileName: string;
  caption: string;
}

/** Bytes only: callers cannot make the SDK download an arbitrary URL or local path. */
export function outboundMediaMessage(media: OutboundMediaSend): AnyMessageContent {
  if (
    !Buffer.isBuffer(media.bytes) ||
    media.bytes.length < 1 ||
    media.bytes.length > 8 * 1024 * 1024 ||
    !['image/jpeg', 'image/png', 'application/pdf'].includes(media.mimeType) ||
    typeof media.fileName !== 'string' ||
    !media.fileName ||
    /[\\/\x00-\x1f\x7f]/.test(media.fileName) ||
    typeof media.caption !== 'string' ||
    media.caption.length > (media.mimeType === 'application/pdf' ? 4000 : 1024)
  )
    throw new Error('INVALID_OUTBOUND_MEDIA');
  return media.mimeType === 'application/pdf'
    ? {
        document: media.bytes,
        mimetype: media.mimeType,
        fileName: media.fileName,
        caption: media.caption,
      }
    : // Avoid optional image decoding/thumbnail generation for untrusted uploaded images.
      { image: media.bytes, mimetype: media.mimeType, caption: media.caption, jpegThumbnail: '' };
}

export type SessionFactory = (onFatal?: (error: Error) => void) => Promise<WhatsAppSession>;

/** Replies may contain URLs as text; they never authorize server-side preview fetches. */
export function plainTextMessage(text: string) {
  return { text, linkPreview: null } as const;
}

export function createSessionFactory(
  db: PrismaClient,
  encryptionKey: string,
  logger: Logger,
  sendTimeoutMs: number,
): SessionFactory {
  // The SDK's warn/error paths can contain raw nodes, identifiers and provider errors.
  // Keep application-authored logs separate from this strict third-party boundary.
  const transportLogger = privateTransportLogger(logger);
  return async (onFatal) => {
    const auth = await createAuthStore(db, encryptionKey, (error) => onFatal?.(error));
    const groups = new Map<string, { value: GroupMetadata; expiresAt: number }>();
    const groupMetadata = async (id: string) => {
      const cached = groups.get(id);
      if (cached && cached.expiresAt > Date.now()) return cached.value;
      const value = await socket.groupMetadata(id);
      if (groups.size >= 200) groups.delete(groups.keys().next().value!);
      groups.set(id, { value, expiresAt: Date.now() + 300_000 });
      return value;
    };
    const socket = makeWASocket({
      auth: auth.state,
      logger: transportLogger,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      // Keep the SDK's initial sync: it supplies LID mappings required for group mentions.
      connectTimeoutMs: 20_000,
      defaultQueryTimeoutMs: sendTimeoutMs,
      cachedGroupMetadata: groupMetadata,
    });
    const deliveryReceipts = new DeliveryReceipts(
      (jid, participant, ids, type) => socket.sendReceipt(jid, participant, ids, type),
      () => logger.warn('WhatsApp delivery acknowledgement failed'),
    );
    const reactions = new TransportFeedback(() => logger.warn('WhatsApp reaction failed'));
    const typing = new TypingPresence(
      (chatId, presence) => socket.sendPresenceUpdate(presence, chatId),
      () => logger.warn('WhatsApp typing update failed'),
    );
    socket.ev.on('groups.update', (updates) => {
      for (const update of updates) if (update.id) groups.delete(update.id);
    });
    socket.ev.on('group-participants.update', ({ id }) => {
      groups.delete(id);
    });

    const send = async (
      chatId: string,
      content: AnyMessageContent,
      quoted?: WAMessage,
      options?: { messageId: string },
    ) => {
      if (options && !/^3EB0[A-F0-9]{36}$/.test(options.messageId))
        throw new Error('INVALID_OUTGOING_MESSAGE_ID');
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          socket.sendMessage(chatId, content, {
            ...(options ? { messageId: options.messageId } : {}),
            ...(quoted ? { quoted } : {}),
            mediaUploadTimeoutMs: sendTimeoutMs,
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              const error = new Error('WhatsApp send timed out; delivery is uncertain');
              void socket.end(error).catch(() => undefined);
              reject(error);
            }, sendTimeoutMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    return {
      // Evaluate on each access: Baileys can learn the account's LID after pairing.
      get botJids() {
        return [socket.user?.id, socket.user?.lid].filter((jid): jid is string => Boolean(jid));
      },
      on(event, handler) {
        socket.ev.on(event, handler);
        return () => socket.ev.off(event, handler);
      },
      saveCredentials: () => auth.saveCredentials(),
      acknowledgeDelivery: (message) => deliveryReceipts.acknowledge(message),
      markRead: (message) => deliveryReceipts.markRead(message),
      startTyping: (chatId, signal) => typing.start(chatId, signal),
      acknowledgeToolUse: (message) => {
        const { key } = message;
        if (key.fromMe || !key.id || !key.remoteJid) return;
        const target = { ...key };
        reactions.submit(() =>
          socket.sendMessage(target.remoteJid!, { react: { text: '✏️', key: target } }),
        );
        reactions.submit(() =>
          socket.sendMessage(target.remoteJid!, plainTextMessage('Sure, just a sec.'), {
            quoted: message,
          }),
        );
      },
      reply: (message, text, options) =>
        send(message.key.remoteJid!, plainTextMessage(text), message, options),
      sendText: (chatId, text, options) => send(chatId, plainTextMessage(text), undefined, options),
      sendMedia: (chatId, media) => send(chatId, outboundMediaMessage(media)),
      async downloadMedia(message, signal) {
        const content = persistableMessageContent(message.message);
        const attachment =
          content?.imageMessage ?? content?.audioMessage ?? content?.documentMessage;
        if (!attachment || Number(attachment.fileLength ?? 0) > MAX_MEDIA_BYTES)
          throw new Error('MEDIA_UNSUPPORTED_OR_TOO_LARGE');
        if (attachment.url) {
          const url = new URL(attachment.url);
          if (
            url.protocol !== 'https:' ||
            (url.port !== '' && url.port !== '443') ||
            url.username ||
            url.password ||
            !(url.hostname === 'mmg.whatsapp.net' || url.hostname.endsWith('.whatsapp.net'))
          )
            throw new Error('UNTRUSTED_MEDIA_HOST');
        }
        if (
          attachment.directPath &&
          (!attachment.directPath.startsWith('/') ||
            attachment.directPath.startsWith('//') ||
            attachment.directPath.includes('\\'))
        )
          throw new Error('INVALID_MEDIA_PATH');
        signal.throwIfAborted();
        const stream = await downloadMediaMessage(
          message,
          'stream',
          { options: { signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) } },
          { logger: transportLogger, reuploadRequest: socket.updateMediaMessage },
        );
        const chunks: Buffer[] = [];
        let size = 0;
        try {
          for await (const chunk of stream) {
            signal.throwIfAborted();
            const data = Buffer.from(chunk);
            size += data.length;
            if (size > MAX_MEDIA_BYTES) throw new Error('MEDIA_SIZE_LIMIT');
            chunks.push(data);
          }
        } finally {
          stream.destroy();
        }
        return {
          bytes: Buffer.concat(chunks),
          mime: attachment.mimetype ?? '',
          name:
            'fileName' in attachment ? String(attachment.fileName ?? 'attachment') : 'attachment',
        };
      },
      chatName: async (chatId) =>
        chatId.endsWith('@g.us') ? (await groupMetadata(chatId)).subject : undefined,
      async close() {
        try {
          await Promise.all([deliveryReceipts.close(), reactions.close(), typing.close()]);
          await socket.end(undefined);
        } finally {
          await auth.flush();
        }
      },
    };
  };
}
