/** Service credential authorizes only automation queue operations, never admin controls. */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { OutboundAutomationService } from '../../contracts/outbound-automation.js';
import {
  MAX_OUTBOUND_BODY_BYTES,
  OutboundValidationError,
  parseOutboundAutomationRequest,
  validIdempotencyKey,
} from '../../modules/messaging/outbound-validation.js';
import { validRequestId } from '../database/inbox.repository.js';
import { HttpError, jsonBody } from './json-body.js';

export interface OutboundApiOptions {
  key: string;
  service: OutboundAutomationService;
}

function singleHeader(request: IncomingMessage, name: string): string | undefined {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2)
    if (request.rawHeaders[index]?.toLowerCase() === name) count++;
  const value = request.headers[name];
  return count === 1 && typeof value === 'string' ? value : undefined;
}

export function createOutboundApi(options?: OutboundApiOptions) {
  const expected = options ? createHash('sha256').update(options.key).digest() : undefined;
  let pending = 0;
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? '/', 'http://worker.local');
    const prefix = '/v1/outbound-messages';
    if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return false;
    const actual = createHash('sha256')
      .update(singleHeader(request, 'x-ramesh-api-key') ?? '')
      .digest();
    if (!expected || !options || !timingSafeEqual(actual, expected))
      throw new HttpError(401, 'Unauthorized');
    if (url.search) throw new HttpError(400, 'Query parameters are not supported');
    if (request.method === 'GET' && url.pathname.startsWith(`${prefix}/`)) {
      const id = url.pathname.slice(prefix.length + 1);
      if (!validRequestId(id)) throw new HttpError(400, 'Invalid message ID');
      const result = await options.service.status(id);
      if (!result) throw new HttpError(404, 'Message not found');
      send(response, 200, result);
      return true;
    }
    if (request.method !== 'POST' || url.pathname !== prefix) throw new HttpError(404, 'Not found');
    const key = singleHeader(request, 'idempotency-key');
    if (!validIdempotencyKey(key))
      throw new HttpError(
        400,
        'Provide an Idempotency-Key of 1–128 printable characters without spaces',
      );
    if (pending >= 2) throw new HttpError(429, 'Too many concurrent uploads; retry shortly');
    pending++;
    try {
      const body = parseOutboundAutomationRequest(await jsonBody(request, MAX_OUTBOUND_BODY_BYTES));
      const result = await options.service.enqueue(key, body);
      if (result.status === 'conflict')
        throw new HttpError(409, 'Idempotency key already used for different content');
      if (result.status === 'full')
        throw new HttpError(429, 'Message queue is full; retry shortly');
      send(response, 202, result);
      return true;
    } catch (error) {
      if (error instanceof OutboundValidationError)
        throw new HttpError(error.status, error.message);
      throw error;
    } finally {
      pending--;
    }
  };
}

function send(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}
