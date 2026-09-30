/** Small authenticated control API. It exposes no credentials or arbitrary messaging endpoint. */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { BotStatus } from '../../contracts/admin-api.js';
import type { AdminAccess } from '../database/admin-access.js';
import { HttpError, jsonBody } from './json-body.js';

export interface BotControl {
  getStatus(): BotStatus;
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface ServerOptions {
  adminAccess?: AdminAccess;
  health?: () => Promise<{ release: string }>;
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
