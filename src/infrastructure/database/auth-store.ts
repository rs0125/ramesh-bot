/** Persists Baileys auth atomically in SQLite, encrypted independently of the database. */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
} from '@whiskeysockets/baileys';

export class AuthStorageError extends Error {
  constructor() {
    super('WhatsApp auth storage failed; verify the database and encryption key');
    this.name = 'AuthStorageError';
  }
}

/** Row identity is authenticated too, so ciphertext cannot be moved between key records. */
export function authCipher(encodedKey: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(encodedKey)) throw new AuthStorageError();
  const key = Buffer.from(encodedKey, 'base64url');
  if (key.length !== 32 || key.toString('base64url') !== encodedKey) throw new AuthStorageError();
  return {
    seal(category: string, id: string, value: unknown): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(`${category}\0${id}`));
      const data = Buffer.concat([
        cipher.update(JSON.stringify(value, BufferJSON.replacer), 'utf8'),
        cipher.final(),
      ]);
      return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${data.toString('base64url')}`;
    },
    open(category: string, id: string, value: string): unknown {
      try {
        const [version, iv, tag, data, extra] = value.split('.');
        if (version !== 'v1' || !iv || !tag || !data || extra !== undefined) throw new Error();
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
        decipher.setAAD(Buffer.from(`${category}\0${id}`));
        decipher.setAuthTag(Buffer.from(tag, 'base64url'));
        return JSON.parse(
          Buffer.concat([
            decipher.update(Buffer.from(data, 'base64url')),
            decipher.final(),
          ]).toString('utf8'),
          BufferJSON.reviver,
        ) as unknown;
      } catch {
        throw new AuthStorageError();
      }
    },
  };
}

export async function createAuthStore(
  db: PrismaClient,
  encryptionKey: string,
  onFailure: (error: AuthStorageError) => void,
) {
  const cipher = authCipher(encryptionKey);
  let writes = Promise.resolve();
  let failed = false;

  function fail(): never {
    const error = new AuthStorageError();
    if (!failed) onFailure(error);
    failed = true;
    throw error;
  }

  // Capture values before enqueueing; the SDK mutates its credential object in place.
  function persist(work: () => Promise<unknown>): Promise<void> {
    const pending = writes.then(async () => {
      if (failed) throw new AuthStorageError();
      try {
        await work();
      } catch {
        fail();
      }
    });
    writes = pending.catch(() => undefined);
    return pending;
  }

  let creds: AuthenticationCreds;
  try {
    const existing = await db.whatsAppAuthEntry.findUnique({
      where: { category_keyId: { category: 'credentials', keyId: 'current' } },
    });
    if (!existing && (await db.whatsAppAuthEntry.count()) > 0) throw new AuthStorageError();
    const initial = initAuthCreds();
    const row = await db.whatsAppAuthEntry.upsert({
      where: { category_keyId: { category: 'credentials', keyId: 'current' } },
      create: {
        category: 'credentials',
        keyId: 'current',
        encrypted: cipher.seal('credentials', 'current', initial),
      },
      update: {},
    });
    creds = cipher.open('credentials', 'current', row.encrypted) as AuthenticationCreds;
  } catch {
    return fail();
  }

  const state: AuthenticationState = {
    creds,
    keys: {
      async get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]) {
        await writes;
        if (failed) throw new AuthStorageError();
        const result: { [id: string]: SignalDataTypeMap[T] } = {};
        try {
          // Bound each query below SQLite's bind-parameter limit during large syncs.
          for (let offset = 0; offset < ids.length; offset += 200) {
            const rows = await db.whatsAppAuthEntry.findMany({
              where: { category: type, keyId: { in: ids.slice(offset, offset + 200) } },
            });
            for (const row of rows) {
              let value = cipher.open(type, row.keyId, row.encrypted);
              if (type === 'app-state-sync-key')
                value = proto.Message.AppStateSyncKeyData.fromObject(
                  value as Record<string, unknown>,
                );
              result[row.keyId] = value as SignalDataTypeMap[T];
            }
          }
          return result;
        } catch {
          return fail();
        }
      },
      set(data) {
        const changes = Object.entries(data).flatMap(([category, values]) =>
          Object.entries(values ?? {}).map(([keyId, value]) => ({
            category,
            keyId,
            encrypted: value == null ? null : cipher.seal(category, keyId, value),
          })),
        );
        return persist(() =>
          db.$transaction(
            changes.map(({ category, keyId, encrypted }) =>
              encrypted === null
                ? db.whatsAppAuthEntry.deleteMany({ where: { category, keyId } })
                : db.whatsAppAuthEntry.upsert({
                    where: { category_keyId: { category, keyId } },
                    create: { category, keyId, encrypted },
                    update: { encrypted },
                  }),
            ),
          ),
        );
      },
    },
  };
  return {
    state,
    saveCredentials() {
      const encrypted = cipher.seal('credentials', 'current', creds);
      return persist(() =>
        db.whatsAppAuthEntry.update({
          where: { category_keyId: { category: 'credentials', keyId: 'current' } },
          data: { encrypted },
        }),
      );
    },
    async flush() {
      await writes;
      if (failed) throw new AuthStorageError();
    },
  };
}
