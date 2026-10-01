/** Authenticated controls and inbox. Operator sends are limited to received conversations. */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { BotStatus } from '../../contracts/admin-api.js';
import type { AdminAccess } from '../database/admin-access.js';
import { HttpError, jsonBody } from './json-body.js';
import {
  decodeInboxCursor,
  validChatId,
  validRequestId,
  type InboxRepository,
} from '../database/inbox.repository.js';
import type { DurableMessages } from '../whatsapp/durable-messages.js';

export interface BotControl {
  getStatus(): BotStatus;
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface ServerOptions {
  adminAccess?: AdminAccess;
  health?: () => Promise<{ release: string }>;
  inbox?: Pick<InboxRepository, 'conversations' | 'messages'>;
  sendMessage?: DurableMessages['sendAsAdmin'];
}

export function createAdminServer(bot: BotControl, token: string, options: ServerOptions = {}) {
  let controls = Promise.resolve();
  let pendingControls = 0;
  const expected = createHash('sha256').update(`Bearer ${token}`).digest();
  const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    void handle(request, response).catch((error) =>
      send(response, error instanceof HttpError ? error.status : 503, {
        error: error instanceof HttpError ? error.message : 'Worker request failed',
      }),
    );
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxRequestsPerSocket = 100;

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === 'GET' && request.url === '/healthz') {
      const health = await options.health?.();
      if (!health) throw new HttpError(503, 'Worker not ready');
      send(response, 200, { status: 'ok', release: health.release });
      return;
    }
    const actual = createHash('sha256')
      .update(request.headers.authorization ?? '')
      .digest();
    if (!timingSafeEqual(actual, expected)) {
      send(response, 401, { error: 'Unauthorized' });
      return;
    }
    if (request.method === 'GET' && request.url === '/v1/status') {
      send(response, 200, bot.getStatus());
      return;
    }
    const url = new URL(request.url ?? '/', 'http://worker.local');
    if (
      request.method === 'GET' &&
      ['/v1/inbox/conversations', '/v1/inbox/messages'].includes(url.pathname)
    ) {
      if (!options.inbox) throw new HttpError(503, 'Supabase inbox is not configured');
      const cursor = url.searchParams.get('cursor');
      try {
        decodeInboxCursor(cursor);
      } catch {
        throw new HttpError(400, 'Invalid inbox cursor');
      }
      if (url.pathname === '/v1/inbox/conversations')
        send(response, 200, await options.inbox.conversations(cursor));
      else {
        const chatId = url.searchParams.get('chatId');
        if (!validChatId(chatId)) throw new HttpError(400, 'Invalid conversation');
        send(response, 200, await options.inbox.messages(chatId, cursor));
      }
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/inbox/send') {
      if (!options.sendMessage) throw new HttpError(503, 'Supabase inbox is not configured');
      const { requestId, chatId, text } = await jsonBody(request, 24576);
      if (
        !validRequestId(requestId) ||
        !validChatId(chatId) ||
        typeof text !== 'string' ||
        !text.trim() ||
        text.trim().length > 4000
      )
        throw new HttpError(400, 'Choose a conversation and enter 1–4000 characters');
      if (bot.getStatus().state !== 'connected')
        throw new HttpError(409, 'Connect WhatsApp before sending');
      const result = await options.sendMessage(requestId, chatId, text.trim());
      if (result === 'unknown_chat') throw new HttpError(404, 'Conversation not found');
      if (result === 'conflict')
        throw new HttpError(409, 'Message request conflicts with an earlier request');
      if (result === 'full') throw new HttpError(429, 'Message queue is full; try again shortly');
      send(response, 202, { requestId, status: result });
      return;
    }
    if (request.method === 'POST' && request.url === '/v1/admin/attempt') {
      if (!options.adminAccess) throw new HttpError(503, 'Admin storage unavailable');
      const { key } = await jsonBody(request);
      if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key))
        throw new HttpError(400, 'Invalid login key');
      send(response, 200, await options.adminAccess.attempt(key));
      return;
    }
    if (request.method === 'POST' && request.url === '/v1/admin/session') {
      if (!options.adminAccess) throw new HttpError(503, 'Admin storage unavailable');
      const { action, tokenHash, expiresAt } = await jsonBody(request);
      if (typeof tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(tokenHash))
        throw new HttpError(400, 'Invalid session');
      if (action === 'verify')
        send(response, 200, { active: await options.adminAccess.verify(tokenHash) });
      else if (action === 'revoke') {
        await options.adminAccess.revoke(tokenHash);
        send(response, 200, { ok: true });
      } else if (action === 'create') {
        if (
          typeof expiresAt !== 'number' ||
          !Number.isSafeInteger(expiresAt) ||
          expiresAt <= Date.now() ||
          expiresAt > Date.now() + 8 * 3_600_000 + 60_000
        )
          throw new HttpError(400, 'Invalid session expiry');
        await options.adminAccess.create(tokenHash, new Date(expiresAt));
        send(response, 200, { ok: true });
      } else throw new HttpError(400, 'Invalid session action');
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/control') {
      send(response, 404, { error: 'Not found' });
      return;
    }
    const { action } = await jsonBody(request, 1024);
    if (action !== 'connect' && action !== 'disconnect' && action !== 'reconnect')
      throw new HttpError(400, 'Invalid action');
    if (pendingControls >= 8) throw new HttpError(503, 'Worker busy; check status before retrying');
    pendingControls++;
    const work = controls.then(async () => {
      if (action === 'disconnect' || action === 'reconnect') await bot.stop();
      if (action === 'connect' || action === 'reconnect') await bot.start();
    });
    controls = work
      .catch(() => undefined)
      .finally(() => {
        pendingControls--;
      });
    await work;
    send(response, 200, bot.getStatus());
  }

  return {
    async start(host: string, port: number): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once('error', onError);
        server.listen(port, host, () => {
          server.off('error', onError);
          resolve();
        });
      });
    },
    async stop(): Promise<void> {
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      await controls;
    },
    address: () => server.address(),
  };
}

function send(response: ServerResponse, status: number, payload: unknown): void {
  if (response.writableEnded || response.destroyed) return;
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(payload));
}
