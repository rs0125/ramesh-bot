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
  const greetings = new GreetingService(
    new PrismaGreetingRepository(db),
    config.whatsapp.maxMessageAgeMs,
  );
  const whatsapp = new BaileysClient({
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
    handleMessage: (message, reply) => greetings.handle(message, reply),
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
        await adminAccess.clean();
        if (stopped) return;
        await api.start(config.api.host, config.api.port);
        logger.info({ host: config.api.host, port: config.api.port }, 'Worker control API started');
        maintenance = setInterval(() => {
          cleaning = cleaning
            .then(() => adminAccess.clean())
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
          }
        }
      })());
    },
  };
}
