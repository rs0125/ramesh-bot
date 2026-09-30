/** Adapts Baileys sockets, durable encrypted auth, send deadlines, and group metadata caching. */
import type { PrismaClient } from '@prisma/client';
import makeWASocket, {
  type BaileysEventMap,
  type GroupMetadata,
  type WAMessage,
} from '@whiskeysockets/baileys';
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
    const socket = makeWASocket({
      auth: auth.state,
      logger,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      // Keep the SDK's initial sync: it supplies LID mappings required for group mentions.
      connectTimeoutMs: 20_000,
      defaultQueryTimeoutMs: sendTimeoutMs,
      cachedGroupMetadata: async (id) => {
        const cached = groups.get(id);
        if (cached && cached.expiresAt > Date.now()) return cached.value;
        const value = await socket.groupMetadata(id);
        if (groups.size >= 200) groups.delete(groups.keys().next().value!);
        groups.set(id, { value, expiresAt: Date.now() + 300_000 });
        return value;
      },
    });
    socket.ev.on('groups.update', (updates) => {
      for (const update of updates) if (update.id) groups.delete(update.id);
    });
    socket.ev.on('group-participants.update', ({ id }) => {
      groups.delete(id);
    });

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
      async reply(message, text) {
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            socket.sendMessage(message.key.remoteJid!, { text }, { quoted: message }),
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
      },
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
