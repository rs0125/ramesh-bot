/** Reads a small JSON body without buffering an unbounded request or splitting UTF-8 bytes. */
import type { IncomingMessage } from 'node:http';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function jsonBody(
  request: IncomingMessage,
  limit = 2048,
): Promise<Record<string, unknown>> {
  if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json')
    throw new HttpError(415, 'Expected JSON');
  if (Number(request.headers['content-length']) > limit) {
    request.resume();
    throw new HttpError(413, 'Request too large');
  }
  const parts: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const part = Buffer.from(chunk);
    bytes += part.length;
    if (bytes > limit) {
      request.resume();
      throw new HttpError(413, 'Request too large');
    }
    parts.push(part);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}
