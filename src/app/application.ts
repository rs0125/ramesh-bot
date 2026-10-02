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
import { AgentCheckpointRepository } from '../infrastructure/database/agent-checkpoint.repository.js';
import { DurableMessages } from '../infrastructure/whatsapp/durable-messages.js';
import { AssistantService } from '../modules/assistant/assistant.service.js';
import { OpenAITextModel } from '../infrastructure/openai/text-model.js';
import type { TextModel } from '../modules/assistant/assistant.types.js';
import { InboxRepository } from '../infrastructure/database/inbox.repository.js';
import { MediaRepository } from '../infrastructure/database/media.repository.js';
import { MediaService } from '../modules/media/media.service.js';
import { OpenAIMediaProcessor } from '../infrastructure/openai/media-processor.js';
import { createBusinessReads } from './business-reads.js';
import { WhatsAppEmployeeResolver } from '../infrastructure/whatsapp/employee-sender.js';
import { EmployeeIdentityResolver } from '../modules/identity/employee-identity.js';
import { PostgresEmployeeRoster } from '../infrastructure/database/employee-roster.js';
import { UsageMeter } from '../modules/usage/usage-meter.js';
import { UsageLedgerRepository } from '../infrastructure/database/usage-ledger.repository.js';
import { AutomationOutboundService } from '../modules/messaging/outbound-automation.js';

export interface Application {
  start(): Promise<void>;
  stop(): Promise<void>;
}

// Tests can replace the transport and model; production uses the configured adapters.
export function createApplication(
  config: AppConfig,
  logger: Logger,
  overrides: { createSession?: SessionFactory; model?: TextModel } = {},
): Application {
  const db = createPrismaClient(config.databaseUrl);
  const messagePool = config.messageDatabase
    ? createMessagePool(config.messageDatabase, () =>
        logger.error('Message database connection failed'),
      )
    : undefined;
  const messageRepository =
    messagePool && config.messageDatabase
      ? new MessageQueueRepository(
          messagePool,
          config.messageDatabase.accountId,
          config.whatsapp.debounce,
          config.messageDatabase.concurrency ?? 3,
        )
      : undefined;
  const inboxRepository =
    messagePool && config.messageDatabase
      ? new InboxRepository(messagePool, config.messageDatabase.accountId, config.encryptionKey)
      : undefined;
  const checkpoints =
    messagePool && config.messageDatabase
      ? new AgentCheckpointRepository(messagePool, {
          namespace: 'production',
          accountId: config.messageDatabase.accountId,
          encryptionKey: config.encryptionKey,
        })
      : undefined;
  const businessReads =
    config.businessReads && messagePool
      ? createBusinessReads(config.businessReads, db, messagePool, config.encryptionKey)
      : undefined;
  const usagePolicy = config.assistant?.usagePolicy;
  if (usagePolicy && usagePolicy.mode !== 'off' && !messagePool)
    throw new Error('USAGE_DURABLE_DATABASE_REQUIRED');
  const usageMeter =
    usagePolicy && usagePolicy.mode !== 'off' && messagePool
      ? new UsageMeter(
          new UsageLedgerRepository(messagePool, config.messageDatabase!.accountId, 'production'),
          {
            accountId: config.messageDatabase!.accountId,
            purpose: 'production',
            policy: usagePolicy,
            observe: (usage) => logger.info({ usage }, 'Provider usage recorded'),
          },
        )
      : undefined;
  const assistantConfig = config.assistant ? { ...config.assistant, usageMeter } : undefined;
  // Billing identity is independent of access to business tools and also applies in groups.
  const usageIdentity =
    usageMeter && messagePool
      ? new WhatsAppEmployeeResolver(
          db,
          config.encryptionKey,
          new EmployeeIdentityResolver(new PostgresEmployeeRoster(messagePool)),
        )
      : undefined;
  const media =
    assistantConfig && messagePool && config.messageDatabase
      ? new MediaService(
          new MediaRepository(
            messagePool,
            config.messageDatabase.accountId,
            config.encryptionKey,
            'production',
          ),
          new OpenAIMediaProcessor(assistantConfig),
        )
      : undefined;
  const assistant = assistantConfig
    ? new AssistantService(
        assistantConfig,
        overrides.model ?? new OpenAITextModel(assistantConfig),
        undefined,
        (trace) => logger.info({ agent: trace }, 'Assistant run finished'),
        inboxRepository ? (message) => inboxRepository.context(message) : undefined,
        businessReads,
        { usageMeter, checkpoints },
      )
    : undefined;
  const prepareReply = assistant ? assistant.prepare.bind(assistant) : undefined;
  const durableMessages =
    messageRepository && config.messageDatabase
      ? new DurableMessages(messageRepository, {
          encryptionKey: config.encryptionKey,
          maxAgeMs: config.whatsapp.maxMessageAgeMs,
          capacity: config.whatsapp.maxPendingMessages,
          // Renew while working; a crashed owner can be replaced before message expiry.
          leaseMs: 30000,
          concurrency: config.messageDatabase.concurrency ?? 3,
          pollMs: config.messageDatabase.pollMs,
          waitBeforeReply: createReplyDelay(config.whatsapp.replyDelay),
          prepareReply,
          agentRuns: !!businessReads,
          media,
          accountId: config.messageDatabase.accountId,
          usageMode: usagePolicy?.mode ?? 'off',
          usageEmployee: usageIdentity
            ? async (key, signal) =>
                (await usageIdentity.resolve({ key }, signal))?.employee.employeeId
            : undefined,
          onUsageAttributionFailure: (reason) =>
            logger.warn({ reason }, 'Usage attribution unavailable'),
          businessPreflight: businessReads
            ? (message, evidence, signal) =>
                businessReads.canDeliver(
                  message.key,
                  evidence,
                  AbortSignal.any([
                    signal,
                    AbortSignal.timeout(config.businessReads!.context.timeoutMs),
                  ]),
                  (reason, tool) => logger.warn({ reason, tool }, 'Business delivery check failed'),
                )
            : undefined,
        })
      : undefined;
  const greetings = new GreetingService(
    new PrismaGreetingRepository(db),
    config.whatsapp.maxMessageAgeMs,
    Date.now,
    createReplyDelay(config.whatsapp.replyDelay),
    prepareReply,
  );
  const whatsapp = new BaileysClient({
    durableMessages,
    observeMessage: (message) => assistant?.observeMessage(message),
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
      automation:
        config.api.automationKey && messageRepository && durableMessages
          ? {
              key: config.api.automationKey,
              service: new AutomationOutboundService(
                messageRepository,
                config.encryptionKey,
                config.whatsapp.maxPendingMessages,
                () => durableMessages.notifyOutbound(),
              ),
            }
          : undefined,
      inbox: inboxRepository,
      sendMessage: durableMessages
        ? (id, chatId, text) => durableMessages.sendAsAdmin(id, chatId, text)
        : undefined,
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
          await usageMeter?.summarize('startup-readiness');
          // Existing local claims suppress replies after the storage transition too.
          await messageRepository.importLegacy(await db.greeting.findMany());
          await messageRepository.clean();
          await checkpoints?.clean();
          await media?.clean();
          await db.botSetting.upsert({
            where: { key: 'message-storage' },
            create: { key: 'message-storage', value: 'postgres' },
            update: { value: 'postgres' },
          });
          logger.info('Inbox, conversation context, and message queues use PostgreSQL');
        }
        await adminAccess.clean();
        if (stopped) return;
        await api.start(config.api.host, config.api.port);
        logger.info({ host: config.api.host, port: config.api.port }, 'Worker control API started');
        maintenance = setInterval(() => {
          cleaning = cleaning
            .then(() => adminAccess.clean())
            .then(() => messageRepository?.clean())
            .then(() => checkpoints?.clean())
            .then(() => media?.clean())
            .catch((error) => logger.error({ err: error }, 'State cleanup failed'));
        }, 60_000);
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
          durableMessages?.stopMediaIngress();
          // Abort extractors before WhatsApp waits for a consumer that may be awaiting media.
          const mediaStopped = media?.stop();
          try {
            await whatsapp.stop();
          } finally {
            await cleaning;
            await mediaStopped;
            await durableMessages?.drainMediaIngress();
            await db.$disconnect();
            await messagePool?.end();
          }
        }
      })());
    },
  };
}
