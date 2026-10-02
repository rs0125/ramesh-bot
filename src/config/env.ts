/** Validates environment input once, before the application opens any resources. */
import type { LevelWithSilent } from 'pino';
import type { MessageDatabaseConfig } from '../infrastructure/database/message-pool.js';
import { loadDebounce, type DebouncePolicy } from '../modules/messaging/debounce.js';
import { loadAssistantConfig, type AssistantConfig } from './assistant.js';
import { loadBusinessReadConfig, type BusinessReadConfig } from './business-reads.js';

export interface AppConfig {
  readonly databaseUrl: string;
  readonly logLevel: LevelWithSilent;
  readonly shutdownTimeoutMs: number;
  readonly encryptionKey: string;
  readonly release: string;
  readonly api: { readonly host: string; readonly port: number; readonly token: string };
  readonly autoConnect: boolean;
  readonly messageDatabase?: MessageDatabaseConfig;
  readonly assistant?: AssistantConfig;
  readonly businessReads?: BusinessReadConfig;
  readonly whatsapp: {
    readonly debounce?: DebouncePolicy;
    readonly maxMessageAgeMs: number;
    readonly maxPendingMessages: number;
    readonly sendTimeoutMs: number;
    readonly replyDelay: { readonly minMs: number; readonly maxMs: number };
    readonly printQr: boolean;
  };
}

function positiveInteger(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`${key} must be a non-negative integer`);
  return value;
}

/** Accepts an explicit environment in tests; never reads secrets into log output. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl?.startsWith('file:') || databaseUrl.length <= 5) {
    throw new Error('DATABASE_URL must be a SQLite file: URL; copy .env.example to .env');
  }
  const logLevel = env.LOG_LEVEL ?? 'info';
  const levels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];
  if (!levels.includes(logLevel)) throw new Error('LOG_LEVEL is not a supported logging level');
  const encryptionKey = env.AUTH_ENCRYPTION_KEY ?? '';
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(encryptionKey) ||
    Buffer.from(encryptionKey, 'base64url').toString('base64url') !== encryptionKey
  )
    throw new Error(
      'AUTH_ENCRYPTION_KEY must encode 32 random bytes as base64url; run setup:local',
    );
  const release = env.RELEASE_SHA ?? 'development';
  if (release !== 'development' && !/^[a-f0-9]{40}$/.test(release))
    throw new Error('Invalid RELEASE_SHA');
  const maxPendingMessages = positiveInteger(env, 'MAX_PENDING_MESSAGES', 100);
  if (maxPendingMessages > 1000) throw new Error('MAX_PENDING_MESSAGES must be at most 1000');
  const sendTimeoutMs = positiveInteger(env, 'SEND_TIMEOUT_MS', 15_000);
  if (sendTimeoutMs > 60_000) throw new Error('SEND_TIMEOUT_MS must be at most 60000');
  const replyDelay = {
    minMs: nonNegativeInteger(env, 'REPLY_DELAY_MIN_MS', 1500),
    maxMs: nonNegativeInteger(env, 'REPLY_DELAY_MAX_MS', 4000),
  };
  if (replyDelay.minMs > replyDelay.maxMs || replyDelay.maxMs > 60_000)
    throw new Error(
      'Reply delay must satisfy 0 <= REPLY_DELAY_MIN_MS <= REPLY_DELAY_MAX_MS <= 60000',
    );
  const maxAgeSeconds = positiveInteger(env, 'MAX_MESSAGE_AGE_SECONDS', 300);
  if (maxAgeSeconds > 86_400) throw new Error('MAX_MESSAGE_AGE_SECONDS must be at most 86400');
  const shutdownTimeoutMs = positiveInteger(env, 'SHUTDOWN_TIMEOUT_MS', 10_000);
  if (shutdownTimeoutMs > 300_000) throw new Error('SHUTDOWN_TIMEOUT_MS must be at most 300000');

  const messageDatabase = messageDatabaseConfig(env);
  const assistant = loadAssistantConfig(env);
  const businessReads = loadBusinessReadConfig(env);
  if (businessReads && (!messageDatabase || !assistant))
    throw new Error('Business reads require Supabase message storage and the configured assistant');
  return {
    databaseUrl,
    logLevel: logLevel as LevelWithSilent,
    shutdownTimeoutMs,
    encryptionKey,
    release,
    messageDatabase,
    assistant,
    businessReads,
    whatsapp: {
      debounce: loadDebounce(env),
      maxMessageAgeMs: maxAgeSeconds * 1000,
      maxPendingMessages,
      sendTimeoutMs,
      replyDelay,
      printQr: booleanValue(env, 'PRINT_QR', false),
    },
    api: apiConfig(env),
    autoConnect: booleanValue(env, 'WHATSAPP_AUTO_CONNECT', false),
  };
}

function messageDatabaseConfig(env: NodeJS.ProcessEnv): MessageDatabaseConfig | undefined {
  if (!env.MESSAGE_DATABASE_URL?.trim()) return undefined;
  let url: URL;
  try {
    url = new URL(env.MESSAGE_DATABASE_URL);
  } catch {
    throw new Error('MESSAGE_DATABASE_URL must be a PostgreSQL URL');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    decodeURIComponent(url.username).split('.')[0] !== 'ramesh_worker'
  )
    throw new Error('MESSAGE_DATABASE_URL must use the dedicated ramesh_worker PostgreSQL login');
  const accountId = env.MESSAGE_ACCOUNT_ID ?? 'primary';
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(accountId)) throw new Error('Invalid MESSAGE_ACCOUNT_ID');
  const pollMs = positiveInteger(env, 'MESSAGE_QUEUE_POLL_MS', 5000);
  if (pollMs < 250 || pollMs > 30000)
    throw new Error('MESSAGE_QUEUE_POLL_MS must be between 250 and 30000');
  return { url: url.toString(), ca: env.MESSAGE_DB_SSL_CA, accountId, pollMs };
}

function booleanValue(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  if (env[key] === undefined) return fallback;
  if (env[key] !== 'true' && env[key] !== 'false') throw new Error(`${key} must be true or false`);
  return env[key] === 'true';
}

function apiConfig(env: NodeJS.ProcessEnv): AppConfig['api'] {
  const token = env.WORKER_API_TOKEN ?? '';
  if (token.length < 32)
    throw new Error(
      'WORKER_API_TOKEN must contain at least 32 characters; run npm run setup:local',
    );
  const port = positiveInteger(env, 'WORKER_PORT', 3011);
  if (port > 65535) throw new Error('WORKER_PORT must be at most 65535');
  return { host: env.WORKER_HOST ?? '127.0.0.1', port, token };
}
