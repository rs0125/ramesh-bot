/** Adapts Baileys sockets, durable encrypted auth, send deadlines, and group metadata caching. */
import type { PrismaClient } from '@prisma/client';
import makeWASocket, {
  downloadMediaMessage,
  normalizeMessageContent,
  type BaileysEventMap,
  type GroupMetadata,
  type WAMessage,
} from '@whiskeysockets/baileys';
import { MAX_MEDIA_BYTES, type MediaUpload } from '../../modules/media/media.types.js';
import type { Logger } from 'pino';
import { createAuthStore } from '../database/auth-store.js';

export interface WhatsAppSession {
  readonly botJids: readonly string[];
  on<K extends keyof BaileysEventMap>(
    event: K,
    handler: (value: BaileysEventMap[K]) => void,
  ): () => void;
  saveCredentials(): Promise<void>;
  reply(message: WAMessage, text: string): Promise<void>;
  sendText?(chatId: string, text: string): Promise<void>;
  downloadMedia?(message: WAMessage, signal: AbortSignal): Promise<MediaUpload>;
  chatName?(chatId: string): Promise<string | undefined>;
  close(): Promise<void>;
}

export type SessionFactory = (onFatal?: (error: Error) => void) => Promise<WhatsAppSession>;

export function createSessionFactory(
  db: PrismaClient,
  encryptionKey: string,
  logger: Logger,
  sendTimeoutMs: number,
): SessionFactory {
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
      logger,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      // Keep the SDK's initial sync: it supplies LID mappings required for group mentions.
      connectTimeoutMs: 20_000,
      defaultQueryTimeoutMs: sendTimeoutMs,
      cachedGroupMetadata: groupMetadata,
    });
    socket.ev.on('groups.update', (updates) => {
      for (const update of updates) if (update.id) groups.delete(update.id);
    });
    socket.ev.on('group-participants.update', ({ id }) => {
      groups.delete(id);
    });

    const send = async (chatId: string, text: string, quoted?: WAMessage) => {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          socket.sendMessage(chatId, { text }, quoted ? { quoted } : {}),
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
      reply: (message, text) => send(message.key.remoteJid!, text, message),
      sendText: (chatId, text) => send(chatId, text),
      async downloadMedia(message, signal) {
        if (
          message.message?.viewOnceMessage ||
          message.message?.viewOnceMessageV2 ||
          message.message?.viewOnceMessageV2Extension
        )
          throw new Error('VIEW_ONCE_MEDIA_UNSUPPORTED');
        const content = normalizeMessageContent(message.message);
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
          { logger, reuploadRequest: socket.updateMediaMessage },
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
          await socket.end(undefined);
        } finally {
          await auth.flush();
        }
      },
    };
  };
}
