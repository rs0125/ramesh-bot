/** Dedicated PostgreSQL pool; transaction-pooler compatible and never disables remote TLS. */
import { Pool, type PoolConfig } from 'pg';

export interface MessageDatabaseConfig {
  readonly url: string;
  readonly ca?: string;
  readonly accountId: string;
  readonly pollMs: number;
  readonly concurrency?: number;
}

export function messagePoolOptions(urlString: string, ca?: string): PoolConfig {
  const url = new URL(urlString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol))
    throw new Error('Invalid message database URL');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  // URI options must not override TLS, timeouts, or connection limits.
  url.search = '';
  return {
    connectionString: url.toString(),
    ssl: local
      ? false
      : { rejectUnauthorized: true, ...(ca ? { ca: ca.replaceAll('\\n', '\n') } : {}) },
    max: 2,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    maxLifetimeSeconds: 300,
    statement_timeout: 5000,
    query_timeout: 6000,
    application_name: 'ramesh-message-worker',
  };
}

export function createMessagePool(config: MessageDatabaseConfig, onError: () => void): Pool {
  const pool = new Pool(messagePoolOptions(config.url, config.ca));
  // Raw driver errors can contain database details; report a fixed event only.
  pool.on('error', onError);
  return pool;
}
