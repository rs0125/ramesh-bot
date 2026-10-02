/** Resolves only the actual transport sender and SDK-persisted, reciprocal LID mappings. Opens no socket. */
import type { PrismaClient } from '@prisma/client';
import type { WAMessage } from '@whiskeysockets/baileys';
import { authCipher } from '../database/auth-store.js';
import { EmployeeIdentityResolver } from '../../modules/identity/employee-identity.js';
import type { ContextSender } from '../../modules/context-engine/context.types.js';

export class WhatsAppEmployeeResolver {
  private readonly cipher: ReturnType<typeof authCipher>;
  constructor(
    private readonly db: PrismaClient,
    encryptionKey: string,
    private readonly employees: EmployeeIdentityResolver,
  ) {
    this.cipher = authCipher(encryptionKey);
  }

  async sender(
    message: Pick<WAMessage, 'key'>,
    signal: AbortSignal,
  ): Promise<ContextSender | null> {
    signal.throwIfAborted();
    const key = message.key;
    if (key.fromMe || !key.remoteJid) return null;
    const isGroup = /^[0-9-]{1,64}@g\.us$/.test(key.remoteJid);
    const jid = isGroup ? key.participant : key.remoteJid;
    if (!jid) return null;
    const phone = /^([1-9]\d{7,14})(?::\d{1,5})?@s\.whatsapp\.net$/.exec(jid);
    let digits = phone?.[1];
    if (!digits) {
      const lid = /^([1-9]\d{0,19})(?::\d{1,5})?@lid$/.exec(jid)?.[1];
      if (!lid) return null;
      // Baileys stores both directions in one atomic Signal-key batch. Do not learn mappings
      // from quoted messages, mentions, display names, text, or user-supplied phone numbers.
      const reverseId = `${lid}_reverse`;
      const reverse = await this.db.whatsAppAuthEntry.findUnique({
        where: { category_keyId: { category: 'lid-mapping', keyId: reverseId } },
      });
      if (!reverse) return null;
      const pn = this.cipher.open('lid-mapping', reverseId, reverse.encrypted);
      if (typeof pn !== 'string' || !/^[1-9]\d{7,14}$/.test(pn)) return null;
      signal.throwIfAborted();
      // Re-read BOTH directions in one SELECT snapshot. The first read only discovers
      // the candidate key. Overlapping interactive SQLite transactions can time out
      // during parallel delivery checks; a single statement needs no transaction lock.
      const pair = await this.db.whatsAppAuthEntry.findMany({
        where: { category: 'lid-mapping', keyId: { in: [reverseId, pn] } },
      });
      const currentReverse = pair.find((row) => row.keyId === reverseId);
      const forward = pair.find((row) => row.keyId === pn);
      digits =
        currentReverse &&
        forward &&
        this.cipher.open('lid-mapping', reverseId, currentReverse.encrypted) === pn &&
        this.cipher.open('lid-mapping', pn, forward.encrypted) === lid
          ? pn
          : undefined;
    }
    signal.throwIfAborted();
    return digits ? { phoneE164: `+${digits}`, audience: isGroup ? 'group' : 'dm' } : null;
  }

  async resolve(message: Pick<WAMessage, 'key'>, signal: AbortSignal) {
    const sender = await this.sender(message, signal);
    if (!sender) return null;
    const employee = await this.employees.resolvePhone(sender.phoneE164, signal);
    return employee ? { sender, employee } : null;
  }
}
