/** Composition root: constructs adapters and controls their startup/shutdown order. */
import qrcode from 'qrcode-terminal';
import type { Logger } from 'pino';
import type { AppConfig } from '../config/env.js';
import { createPrismaClient } from '../infrastructure/database/prisma.js';
import { PrismaGreetingRepository } from '../infrastructure/database/greeting.repository.js';
import { createAdminServer } from '../infrastructure/http/admin-server.js';
import { BaileysClient } from '../infrastructure/whatsapp/baileys-client.js';
import { createSessionFactory } from '../infrastructure/whatsapp/baileys-session.js';
import { GreetingService } from '../modules/greetings/greeting.service.js';
import { PrismaAdminAccess } from '../infrastructure/database/admin-access.js';
import type { SessionFactory } from '../infrastructure/whatsapp/baileys-session.js';
import { createReplyDelay } from '../lib/reply-delay.js';
import { createMessagePool } from '../infrastructure/database/message-pool.js';
import { MessageQueueRepository } from '../infrastructure/database/message-queue.repository.js';
import { DurableMessages } from '../infrastructure/whatsapp/durable-messages.js';

export interface Application {
  start(): Promise<void>;
  stop(): Promise<void>;
}

// Test injection replaces only the transport; production always uses the real SDK factory.
export function createApplication(
  config: AppConfig,
  logger: Logger,
  overrides: { createSession?: SessionFactory } = {},
): Application {
  const db = createPrismaClient(config.databaseUrl);
  const messagePool = config.messageDatabase
    ? createMessagePool(config.messageDatabase, () =>
        logger.error('Message database connection failed'),
      )
    : undefined;
  const messageRepository =
    messagePool && config.messageDatabase
      ? new MessageQueueRepository(messagePool, config.messageDatabase.accountId)
      : undefined;
  const durableMessages =
    messageRepository && config.messageDatabase
      ? new DurableMessages(messageRepository, {
          encryptionKey: config.encryptionKey,
          maxAgeMs: config.whatsapp.maxMessageAgeMs,
          capacity: config.whatsapp.maxPendingMessages,
          // Covers maximum pacing, send deadline, and database round trips without renewal.
          leaseMs: config.whatsapp.replyDelay.maxMs + config.whatsapp.sendTimeoutMs + 30000,
          pollMs: config.messageDatabase.pollMs,
          waitBeforeReply: createReplyDelay(config.whatsapp.replyDelay),
        })
      : undefined;
  const greetings = new GreetingService(
    new PrismaGreetingRepository(db),
    config.whatsapp.maxMessageAgeMs,
    Date.now,
    createReplyDelay(config.whatsapp.replyDelay),
  );
  const whatsapp = new BaileysClient({
    durableMessages,
    createSession:
      overrides.createSession ??
      createSessionFactory(
        db,
        config.encryptionKey,
        logger.child(
          { module: 'baileys' },
          { level: config.logLevel === 'silent' ? 'silent' : 'warn' },
        ),
        config.whatsapp.sendTimeoutMs,
      ),
    handleMessage: (message, reply, signal) => greetings.handle(message, reply, signal),
    logger: logger.child({ module: 'whatsapp' }),
    maxPendingMessages: config.whatsapp.maxPendingMessages,
    onQr: (qr) => {
      if (!config.whatsapp.printQr) return;
      console.log('Scan in WhatsApp → Linked devices, or open the admin app.');
      qrcode.generate(qr, { small: true });
    },
  });
  const adminAccess = new PrismaAdminAccess(db);
  let ready = false;
  const remember = (enabled: boolean) =>
    db.botSetting.upsert({
      where: { key: 'whatsapp-enabled' },
      create: { key: 'whatsapp-enabled', value: String(enabled) },
      update: { value: String(enabled) },
    });
  const api = createAdminServer(
    {
      getStatus: () => whatsapp.getStatus(),
      start: async () => {
        await remember(true);
        await whatsapp.start();
      },
      stop: async () => {
        await remember(false);
        await whatsapp.stop();
      },
    },
    config.api.token,
    {
      adminAccess,
      health: async () => {
        if (!ready) throw new Error('Worker not ready');
        await db.$queryRaw`SELECT 1`;
        await messageRepository?.health();
        return { release: config.release };
      },
    },
  );
  let maintenance: NodeJS.Timeout | undefined;
  let cleaning = Promise.resolve();
  let starting: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  let stopped = false;
  return {
    start() {
      if (stopped) return Promise.reject(new Error('Application is stopping'));
      return (starting ??= (async () => {
        await db.greeting.count(); // Check connectivity and migrations before exposing controls.
        const storage = await db.botSetting.findUnique({ where: { key: 'message-storage' } });
        if (storage?.value === 'postgres' && !messageRepository)
          throw new Error(
            'MESSAGE_DATABASE_URL is required after durable message storage has been enabled',
          );
        if (messageRepository) {
          await messageRepository.health();
          // Existing local claims suppress replies after the storage transition too.
          await messageRepository.importLegacy(await db.greeting.findMany());
          await messageRepository.clean();
          await db.botSetting.upsert({
            where: { key: 'message-storage' },
            create: { key: 'message-storage', value: 'postgres' },
            update: { value: 'postgres' },
          });
          logger.info('Message state and reply queue use PostgreSQL');
        }
        await adminAccess.clean();
        if (stopped) return;
        await api.start(config.api.host, config.api.port);
        logger.info({ host: config.api.host, port: config.api.port }, 'Worker control API started');
        maintenance = setInterval(() => {
          cleaning = cleaning
            .then(() => adminAccess.clean())
            .then(() => messageRepository?.clean())
            .catch((error) => logger.error({ err: error }, 'State cleanup failed'));
        }, 3_600_000);
        maintenance.unref();
        const preference = await db.botSetting.findUnique({ where: { key: 'whatsapp-enabled' } });
        if ((preference ? preference.value === 'true' : config.autoConnect) && !stopped)
          await whatsapp.start();
        ready = !stopped;
      })());
    },
    stop() {
      stopped = true;
      ready = false;
      if (maintenance) clearInterval(maintenance);
      return (stopping ??= (async () => {
        await starting?.catch(() => undefined);
        if (maintenance) clearInterval(maintenance);
        try {
          await api.stop();
        } finally {
          try {
            await whatsapp.stop();
          } finally {
            await cleaning;
            await db.$disconnect();
            await messagePool?.end();
          }
        }
      })());
    },
  };
}
