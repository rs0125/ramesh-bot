/** Bounded uploaded bytes only: this API never downloads a caller-supplied URL. */
import type {
  OutboundAutomationMedia,
  OutboundAutomationRequest,
} from '../../contracts/outbound-automation.js';

export const MAX_OUTBOUND_MEDIA_BYTES = 8 * 1024 * 1024;
export const MAX_OUTBOUND_BODY_BYTES = 12 * 1024 * 1024;

export class OutboundValidationError extends Error {
  constructor(
    readonly status: 400 | 413 | 415,
    message: string,
  ) {
    super(message);
  }
}

function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new OutboundValidationError(400, 'Expected an object');
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !fields.includes(key)))
    throw new OutboundValidationError(400, 'Unknown request field');
  return result;
}

export function validIdempotencyKey(value: unknown): value is string {
  return typeof value === 'string' && /^[\x21-\x7e]{1,128}$/.test(value);
}

export function validateOutboundMedia(value: unknown): OutboundAutomationMedia {
  const media = object(value, ['mimeType', 'fileName', 'dataBase64']);
  if (
    typeof media.mimeType !== 'string' ||
    !['image/jpeg', 'image/png', 'application/pdf'].includes(media.mimeType)
  )
    throw new OutboundValidationError(415, 'Supported media: JPEG, PNG and PDF');
  if (
    typeof media.fileName !== 'string' ||
    !media.fileName.trim() ||
    media.fileName !== media.fileName.trim() ||
    media.fileName.length > 120 ||
    /[\/\\\p{C}]/u.test(media.fileName) ||
    ['.', '..'].includes(media.fileName)
  )
    throw new OutboundValidationError(400, 'Provide a plain attachment file name');
  if (typeof media.dataBase64 !== 'string' || !media.dataBase64.length)
    throw new OutboundValidationError(400, 'Provide base64 attachment bytes');
  if (media.dataBase64.length > Math.ceil(MAX_OUTBOUND_MEDIA_BYTES / 3) * 4)
    throw new OutboundValidationError(413, 'Attachment exceeds 8 MiB');
  const bytes = Buffer.from(media.dataBase64, 'base64');
  if (bytes.toString('base64') !== media.dataBase64)
    throw new OutboundValidationError(400, 'Attachment must use canonical padded base64');
  if (bytes.length > MAX_OUTBOUND_MEDIA_BYTES)
    throw new OutboundValidationError(413, 'Attachment exceeds 8 MiB');
  const signature =
    media.mimeType === 'image/jpeg'
      ? Buffer.from([0xff, 0xd8, 0xff])
      : media.mimeType === 'image/png'
        ? Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        : Buffer.from('%PDF-');
  if (!bytes.subarray(0, signature.length).equals(signature))
    throw new OutboundValidationError(415, 'Attachment bytes do not match the declared MIME type');
  return {
    mimeType: media.mimeType as OutboundAutomationMedia['mimeType'],
    fileName: media.fileName,
    dataBase64: media.dataBase64,
  };
}

export function parseOutboundAutomationRequest(value: unknown): OutboundAutomationRequest {
  const body = object(value, ['to', 'text', 'media', 'expiresInSeconds']);
  if (typeof body.to !== 'string' || !/^\+[1-9]\d{7,14}$/.test(body.to))
    throw new OutboundValidationError(
      400,
      'Target must be an E.164 phone number, e.g. +919876543210',
    );
  const text = body.text === undefined ? '' : body.text;
  if (typeof text !== 'string' || text.length > 4000 || /\u0000/.test(text))
    throw new OutboundValidationError(400, 'Text must contain at most 4000 characters');
  const media = body.media === undefined ? undefined : validateOutboundMedia(body.media);
  if (!text.trim() && !media)
    throw new OutboundValidationError(400, 'Provide text or an attachment');
  if (media?.mimeType.startsWith('image/') && text.trim().length > 1024)
    throw new OutboundValidationError(400, 'Image captions must contain at most 1024 characters');
  const expiresInSeconds = body.expiresInSeconds ?? 900;
  if (
    typeof expiresInSeconds !== 'number' ||
    !Number.isInteger(expiresInSeconds) ||
    expiresInSeconds < 30 ||
    expiresInSeconds > 86400
  )
    throw new OutboundValidationError(400, 'Expiry must be an integer from 30 to 86400 seconds');
  return { to: body.to, text: text.trim(), expiresInSeconds, ...(media ? { media } : {}) };
}
