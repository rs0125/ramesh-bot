import { ChatContext, contextScope } from '../modules/assistant/chat-context.js';
import { ChatContextRepository } from '../infrastructure/database/chat-context.repository.js';
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
import { flushTracing, tracedModel } from '../infrastructure/observability/tracing.js';
import type { TextModel } from '../modules/assistant/assistant.types.js';
import { InboxRepository } from '../infrastructure/database/inbox.repository.js';
import { MediaRepository } from '../infrastructure/database/media.repository.js';
import { MediaService } from '../modules/media/media.service.js';
import { OpenAIMediaProcessor } from '../infrastructure/openai/media-processor.js';
import { createBusinessReads, createBusinessAccessResolver } from './business-reads.js';
import { WhatsAppEmployeeResolver } from '../infrastructure/whatsapp/employee-sender.js';
import { EmployeeIdentityResolver } from '../modules/identity/employee-identity.js';
import { PostgresEmployeeRoster } from '../infrastructure/database/employee-roster.js';
import { UsageMeter } from '../modules/usage/usage-meter.js';
import { UsageLedgerRepository } from '../infrastructure/database/usage-ledger.repository.js';
import { AutomationOutboundService } from '../modules/messaging/outbound-automation.js';
import { PersonalRepository } from '../infrastructure/database/personal.repository.js';
import { PersonalToolService } from '../modules/scheduling/personal-tools.js';
import { PersonalSchedulerService } from '../modules/scheduling/scheduler.service.js';
import { WriteRepository } from '../infrastructure/database/write.repository.js';
import { BusinessWriteService } from '../modules/writes/write-tools.js';
import { authorizeDelivery } from '../modules/messaging/delivery-evidence.js';

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
  // Existing queued reminders still need their delivery fence when new scheduling is disabled.
  const schedulingIdentity = messagePool
    ? new EmployeeIdentityResolver(new PostgresEmployeeRoster(messagePool))
    : undefined;
  const schedulingSender = schedulingIdentity
    ? new WhatsAppEmployeeResolver(db, config.encryptionKey, schedulingIdentity)
    : undefined;
  const resolveReminderEmployee =
    schedulingIdentity && schedulingSender
      ? async (id: number, signal: AbortSignal, chatId?: string) => {
          const employee = await schedulingIdentity.resolveEmployee(id, signal);
          if (!employee || !chatId) return employee;
          const current = await schedulingSender.resolve(
            { key: { remoteJid: chatId, fromMe: false } },
            signal,
          );
          return current?.sender.audience === 'dm' &&
            current.employee.employeeId === id &&
            current.employee.phoneE164 === employee.phoneE164
            ? employee
            : null;
        }
      : undefined;
  const personalRepository =
    messagePool && config.messageDatabase
      ? new PersonalRepository(messagePool, config.messageDatabase.accountId, config.encryptionKey)
      : undefined;
  const personalTools =
    config.scheduling && personalRepository && schedulingSender
      ? new PersonalToolService(personalRepository, async (key, signal) => {
          const resolved = await schedulingSender.resolve({ key }, signal);
          return resolved?.sender.audience === 'dm' && key.remoteJid
            ? {
                employeeId: resolved.employee.employeeId,
                phoneE164: resolved.employee.phoneE164,
                chatId: key.remoteJid,
              }
            : null;
        })
      : undefined;
  // Keep the delivery fence for existing receipts even when new proposals are disabled.
  const writeAccess =
    config.businessReads && messagePool
      ? createBusinessAccessResolver(config.businessReads, db, messagePool, config.encryptionKey)
      : undefined;
  const businessWrites =
    writeAccess && schedulingSender && messagePool && config.messageDatabase
      ? new BusinessWriteService(
          new WriteRepository(messagePool, config.messageDatabase.accountId, config.encryptionKey),
          async (key, signal) => {
            const resolved = await schedulingSender.resolve({ key }, signal);
            if (!resolved || resolved.sender.audience !== 'dm' || !key.remoteJid) return null;
            const access = await writeAccess(key, signal);
            if (!access?.writes || access.employeeId !== resolved.employee.employeeId) return null;
            const pilot = config.businessReads!.employeeIds;
            if (pilot !== 'all' && !pilot.includes(access.employeeId)) return null;
            return {
              actor: {
                employeeId: access.employeeId,
                phoneE164: resolved.employee.phoneE164,
                chatId: key.remoteJid,
              },
              writer: access.writes,
            };
          },
        )
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
  const assistantModel = assistantConfig
    ? tracedModel(overrides.model ?? new OpenAITextModel(assistantConfig))
    : undefined;
  const contextRepository =
    assistantConfig?.context && messagePool && config.messageDatabase
      ? new ChatContextRepository(
          messagePool,
          config.messageDatabase.accountId,
          config.encryptionKey,
        )
      : undefined;
  if (assistantConfig?.context && (!contextRepository || !inboxRepository || !schedulingSender))
    throw new Error('CONTEXT_DURABLE_DATABASE_REQUIRED');
  const conversationContext =
    contextRepository && inboxRepository && assistantModel && schedulingSender
      ? new ChatContext({
          store: contextRepository,
          source: inboxRepository,
          model: assistantModel,
          resolve: async (key, signal) => {
            const resolved = await schedulingSender.resolve({ key }, signal);
            return resolved?.sender.audience === 'dm' && resolved.employee.active
              ? contextScope(config.messageDatabase!.accountId, key.remoteJid!, resolved.employee)
              : null;
          },
        })
      : undefined;
  const assistant = assistantConfig
    ? new AssistantService(
        assistantConfig,
        assistantModel!,
        undefined,
        (trace) => logger.info({ agent: trace }, 'Assistant run finished'),
        inboxRepository ? (message) => inboxRepository.context(message) : undefined,
        businessReads,
        {
          usageMeter,
          checkpoints,
          conversationContext,
          personalTools: config.scheduling?.toolsEnabled ? personalTools : undefined,
          businessWrites: config.businessWrites ? businessWrites : undefined,
        },
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
          agentRuns:
            !!businessReads || !!personalTools || !!businessWrites || !!conversationContext,
          media,
          accountId: config.messageDatabase.accountId,
          usageMode: usagePolicy?.mode ?? 'off',
          onProcessingError: (failure) =>
            logger.warn({ failure }, 'Durable message processing failed'),
          reminderEmployee: resolveReminderEmployee,
          usageEmployee: usageIdentity
            ? async (key, signal) =>
                (await usageIdentity.resolve({ key }, signal))?.employee.employeeId
            : undefined,
          onUsageAttributionFailure: (reason) =>
            logger.warn({ reason }, 'Usage attribution unavailable'),
          businessPreflight:
            businessReads || personalTools || businessWrites || conversationContext
              ? async (message, evidence, signal) => {
                  const bounded = AbortSignal.any([
                    signal,
                    AbortSignal.timeout(config.businessReads?.context.timeoutMs ?? 10000),
                  ]);
                  return authorizeDelivery(evidence, {
                    context: conversationContext
                      ? (receipt) => conversationContext.canDeliver(message.key, receipt, bounded)
                      : undefined,
                    write: businessWrites
                      ? (receipt) => businessWrites.canDeliver(message.key, receipt, bounded)
                      : undefined,
                    personal: personalTools
                      ? (receipt) => personalTools.canDeliver(message.key, receipt, bounded)
                      : undefined,
                    business: businessReads
                      ? (receipt) =>
                          businessReads.canDeliver(message.key, receipt, bounded, (reason, tool) =>
                            logger.warn({ reason, tool }, 'Business delivery check failed'),
                          )
                      : undefined,
                  });
                }
              : undefined,
        })
      : undefined;
  const scheduler =
    config.scheduling?.schedulerEnabled &&
    personalRepository &&
    messageRepository &&
    resolveReminderEmployee
      ? new PersonalSchedulerService(personalRepository, messageRepository, {
          encryptionKey: config.encryptionKey,
          capacity: config.whatsapp.maxPendingMessages,
          resolveEmployee: resolveReminderEmployee,
          onQueued: () => durableMessages?.notifyOutbound(),
          pollMs: config.scheduling.pollMs,
          onError: () => logger.error('Personal reminder scheduler operation failed'),
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
      getStatus: () => ({
        ...whatsapp.getStatus(),
        ...(config.scheduling
          ? {
              scheduling: {
                toolsEnabled: config.scheduling.toolsEnabled,
                schedulerEnabled: config.scheduling.schedulerEnabled,
                scheduler: scheduler?.getStatus() ?? null,
              },
            }
          : {}),
      }),
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
        await contextRepository?.health();
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
          await contextRepository?.health();
          await usageMeter?.summarize('startup-readiness');
          // Existing local claims suppress replies after the storage transition too.
          await messageRepository.importLegacy(await db.greeting.findMany());
          await messageRepository.clean();
          await checkpoints?.clean();
          await contextRepository?.clean();
          await media?.clean();
          await personalRepository?.clean();
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
            .then(() => contextRepository?.clean())
            .then(() => media?.clean())
            .then(() => personalRepository?.clean())
            .catch((error) => logger.error({ err: error }, 'State cleanup failed'));
        }, 60_000);
        maintenance.unref();
        const preference = await db.botSetting.findUnique({ where: { key: 'whatsapp-enabled' } });
        if ((preference ? preference.value === 'true' : config.autoConnect) && !stopped)
          await whatsapp.start();
        ready = !stopped;
        if (ready) scheduler?.start();
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
          await scheduler?.stop();
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
            await flushTracing();
          }
        }
      })());
    },
  };
}
