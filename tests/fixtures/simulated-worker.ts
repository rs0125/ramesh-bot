/** Test-only process. The real application/Prisma adapters run, but no WhatsApp socket is created. */
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import pino from 'pino';
import type { BaileysEventMap, WAMessage } from '@whiskeysockets/baileys';
import { createApplication } from '../../src/app/application.js';
import { loadConfig } from '../../src/config/env.js';
import { createPrismaClient } from '../../src/infrastructure/database/prisma.js';
import { createAuthStore } from '../../src/infrastructure/database/auth-store.js';
import { jsonBody } from '../../src/infrastructure/http/json-body.js';
import type { WhatsAppSession } from '../../src/infrastructure/whatsapp/baileys-session.js';

// Dedicated unit tests exercise pacing; browser scenarios do not need real-time delays.
const config = loadConfig({
  ...process.env,
  // Browser fixtures must never inherit the real worker's Supabase connection.
  MESSAGE_DATABASE_URL: '',
  REPLY_DELAY_MIN_MS: '0',
  REPLY_DELAY_MAX_MS: '0',
});
const stateDir = process.env.E2E_STATE_DIR;
if (!stateDir || !stateDir.includes('wareongo-e2e-'))
  throw new Error('Missing isolated test directory');
const db = createPrismaClient(config.databaseUrl);
let active: { events: EventEmitter; pair(): Promise<void> } | undefined;
let uncertainSend = false;

const app = createApplication(config, pino({ level: 'silent' }), {
  createSession: async (onFatal) => {
    const auth = await createAuthStore(db, config.encryptionKey, (error) => onFatal?.(error));
    const events = new EventEmitter();
    let closed = false;
    // A macrotask gives the client time to install the SDK event listeners.
    const timer = setTimeout(
      () =>
        events.emit(
          'connection.update',
          auth.state.creds.registered
            ? { connection: 'open' }
            : { qr: 'synthetic-local-test-qr-never-valid-for-whatsapp' },
        ),
      20,
    );
    active = {
      events,
      async pair() {
        auth.state.creds.registered = true;
        auth.state.creds.me = { id: '10000000000@s.whatsapp.net', name: 'Simulated bot' };
        await auth.saveCredentials();
        events.emit('connection.update', { connection: 'open' });
      },
    };
    const session: WhatsAppSession = {
      botJids: ['10000000000@s.whatsapp.net', '10000000001@lid'],
      on<K extends keyof BaileysEventMap>(event: K, handler: (value: BaileysEventMap[K]) => void) {
        events.on(event, handler);
        return () => {
          events.off(event, handler);
        };
      },
      saveCredentials: () => auth.saveCredentials(),
      async reply(message: WAMessage, text: string) {
        if (closed) throw new Error('Closed test session');
        await appendFile(
          join(stateDir, 'outbound.jsonl'),
          JSON.stringify({ chatId: message.key.remoteJid, id: message.key.id, text }) + '\n',
        );
        if (uncertainSend) {
          uncertainSend = false;
          throw new Error('Simulated ambiguous delivery');
        }
      },
      async close() {
        closed = true;
        clearTimeout(timer);
        active = undefined;
        await auth.flush();
      },
    };
    return session;
  },
});

const server = createServer((request, response) => {
  void (async () => {
    if (request.headers.authorization !== 'Bearer isolated-e2e-control') {
      response.writeHead(401).end();
      return;
    }
    const body = await jsonBody(request, 32_768);
    if (!active) throw new Error('No simulated session');
    if (body.action === 'pair') await active.pair();
    else if (body.action === 'messages') {
      uncertainSend = body.uncertainSend === true;
      active.events.emit('messages.upsert', {
        type: body.type ?? 'notify',
        messages: body.messages,
      });
    } else throw new Error('Invalid test action');
    response.setHeader('Content-Type', 'application/json');
    response.end('{"ok":true}');
  })().catch(() => {
    response.writeHead(503).end();
  });
});
await app.start();
await new Promise<void>((resolve) => server.listen(4312, '127.0.0.1', resolve));
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await app.stop();
  await db.$disconnect();
}
process.on('SIGTERM', () => {
  void stop().then(
    () => process.exit(0),
    () => process.exit(1),
  );
});
process.on('SIGINT', () => {
  void stop().then(
    () => process.exit(0),
    () => process.exit(1),
  );
});
