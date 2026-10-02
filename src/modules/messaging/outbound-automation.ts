/** Server automation admission only: encrypted outbound work, no agent or inbound media path. */
import { createHash } from 'node:crypto';
import type {
  OutboundAutomationRequest,
  OutboundAutomationService,
} from '../../contracts/outbound-automation.js';
import type { MessageQueueRepository } from '../../infrastructure/database/message-queue.repository.js';
import { authCipher } from '../../infrastructure/database/auth-store.js';
import { encodeAutomationReply, type OutboundMediaMetadata } from './reply-payload.js';
import { parseOutboundAutomationRequest, validateOutboundMedia } from './outbound-validation.js';

export function automationMessageId(accountId: string, key: string): string {
  if (!accountId || accountId.length > 64 || !/^[\x21-\x7e]{1,128}$/.test(key))
    throw new Error('INVALID_AUTOMATION_KEY');
  const hash = createHash('sha256')
    .update(JSON.stringify(['ramesh:automation:v1', accountId, key]))
    .digest();
  // UUIDv8 reserves application-defined payload; domain/account/key bind its derivation.
  hash[6] = (hash[6]! & 0x0f) | 0x80;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const h = hash.subarray(0, 16).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export class AutomationOutboundService implements OutboundAutomationService {
  private readonly cipher;
  constructor(
    private readonly queue: Pick<
      MessageQueueRepository,
      'accountId' | 'enqueueAutomation' | 'automationStatus'
    >,
    encryptionKey: string,
    private readonly capacity: number,
    private readonly wake?: () => void,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw new Error('INVALID_AUTOMATION_CAPACITY');
    this.cipher = authCipher(encryptionKey);
  }

  async enqueue(key: string, input: OutboundAutomationRequest) {
    const messageId = automationMessageId(this.queue.accountId, key);
    const request = parseOutboundAutomationRequest(input);
    const chatId = `${request.to.slice(1)}@s.whatsapp.net`;
    const bytes = request.media ? Buffer.from(request.media.dataBase64, 'base64') : undefined;
    const media: OutboundMediaMetadata | undefined =
      request.media && bytes
        ? {
            mimeType: request.media.mimeType,
            fileName: request.media.fileName,
            byteLength: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          }
        : undefined;
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          'ramesh:automation-content:v1',
          chatId,
          request.text,
          media ?? null,
          request.expiresInSeconds,
        ]),
      )
      .digest('hex');
    const status = await this.queue.enqueueAutomation(
      messageId,
      chatId,
      this.cipher.seal('inbox', messageId, {
        text: request.text || (media?.mimeType === 'application/pdf' ? '[Document]' : '[Image]'),
        senderId: null,
        senderName: 'Ramesh',
        chatName: null,
        kind: media ? (media.mimeType === 'application/pdf' ? 'document' : 'image') : 'text',
      }),
      this.cipher.seal('outbound-reply', messageId, encodeAutomationReply(request.text, media)),
      this.capacity,
      fingerprint,
      request.expiresInSeconds,
      request.media && bytes
        ? {
            payload: this.cipher.seal('outbound-media', messageId, {
              version: 1,
              ...request.media,
            }),
            byteLength: bytes.length,
          }
        : undefined,
    );
    if (status === 'queued') {
      // Wake is advisory only. A callback failure cannot change committed admission into failure.
      try {
        this.wake?.();
      } catch {
        /* The normal queue poll will claim the committed work. */
      }
    }
    return { messageId, status };
  }

  status(messageId: string) {
    if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(messageId))
      throw new Error('INVALID_AUTOMATION_ID');
    return this.queue.automationStatus(messageId);
  }
}

/** Validate again after authenticated decryption, before crossing the irreversible send boundary. */
export function decodeAutomationMedia(value: unknown, expected: OutboundMediaMetadata) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('INVALID_AUTOMATION_MEDIA');
  const { version, ...raw } = value as Record<string, unknown>;
  if (version !== 1) throw new Error('INVALID_AUTOMATION_MEDIA');
  const media = validateOutboundMedia(raw);
  const bytes = Buffer.from(media.dataBase64, 'base64');
  if (
    media.mimeType !== expected.mimeType ||
    media.fileName !== expected.fileName ||
    bytes.length !== expected.byteLength ||
    createHash('sha256').update(bytes).digest('hex') !== expected.sha256
  )
    throw new Error('INVALID_AUTOMATION_MEDIA');
  return { bytes, mimeType: media.mimeType, fileName: media.fileName };
}
