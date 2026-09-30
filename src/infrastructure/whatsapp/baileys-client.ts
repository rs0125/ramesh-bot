/** Owns the connection lifecycle, serialized event handling, and transient admin status. */
import type { BaileysEventMap, WAMessage } from '@whiskeysockets/baileys';
import type { BotState, BotStatus } from '../../contracts/admin-api.js';
import type { Logger } from 'pino';
import type {
  GreetingCandidate,
  GreetingOutcome,
  Reply,
} from '../../modules/greetings/greeting.types.js';
import type { SessionFactory, WhatsAppSession } from './baileys-session.js';
import { toGreetingCandidate } from './message.mapper.js';
import { disconnectCode, reconnectDelay } from './reconnect.policy.js';
import { SerialQueue } from '../../lib/serial-queue.js';
import { AuthStorageError } from '../database/auth-store.js';

interface ClientOptions {
  createSession: SessionFactory;
  handleMessage(message: GreetingCandidate, reply: Reply): Promise<GreetingOutcome>;
  onQr(qr: string): void;
  logger: Logger;
  maxPendingMessages?: number;
  retryDelay?: typeof reconnectDelay;
}

export class BaileysClient {
  private session?: WhatsAppSession;
  private unsubscribe: Array<() => void> = [];
  private running = false;
  private opening?: Promise<void>;
  private closing?: Promise<void>;
  private readonly messages: SerialQueue;
  private storageFailed = false;
  private credentials = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private reconnectAttempts = 0;
  private readonly status: BotStatus = {
    state: 'stopped',
    qr: null,
    updatedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    metrics: { received: 0, replied: 0, duplicates: 0, errors: 0, dropped: 0 },
    events: [],
  };

  constructor(private readonly options: ClientOptions) {
    this.messages = new SerialQueue(options.maxPendingMessages ?? 100);
  }

  /** A defensive copy keeps API consumers from mutating the live session state. */
  getStatus(): BotStatus {
    return structuredClone(this.status);
  }

  async start(): Promise<void> {
    await this.closing;
    if (this.running) return;
    // A manual start supersedes retries scheduled by the previous session.
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.running = true;
    this.storageFailed = false;
    try {
      await this.connect();
    } catch (error) {
      if (error instanceof AuthStorageError) this.storageFailure(error);
      else this.scheduleReconnect(undefined);
      throw error;
    }
  }

  /** Stop accepting messages, drain accepted work, then close the socket and save auth. */
  stop(): Promise<void> {
    if (this.closing) return this.closing;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.update('disconnecting', 'Disconnecting WhatsApp');
    this.closing = (async () => {
      await this.opening?.catch(() => undefined);
      await this.messages.drain();
      await this.retireSession();
      this.update('stopped', 'WhatsApp is disconnected');
    })().finally(() => {
      this.closing = undefined;
    });
    return this.closing;
  }

  private connect(): Promise<void> {
    if (this.opening) return this.opening;
    this.opening = this.openSession().finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }

  private async openSession(): Promise<void> {
    await this.messages.drain();
    await this.retireSession();
    if (!this.running) return;
    this.update('connecting', 'Opening WhatsApp connection');
    const session = await this.options.createSession((error) => this.storageFailure(error));
    if (!this.running) {
      await session.close();
      return;
    }
    this.session = session;
    this.unsubscribe = [
      session.on('connection.update', (update) => this.connectionChanged(session, update)),
      session.on('creds.update', () => {
        // Serialize writes so successive SDK events cannot overwrite newer credentials.
        this.credentials = this.credentials
          .then(() => session.saveCredentials())
          .catch((error) => {
            this.storageFailure(error);
          });
      }),
      session.on('messages.upsert', (event) => {
        if (event.type !== 'notify' || !this.running || this.session !== session) return;
        // A single chain preserves order across batches; no unobserved async event work.
        for (const message of event.messages) {
          const admitted = this.messages.push(
            () => this.processMessages(session, [message]),
            (error) => this.options.logger.error({ err: error }, 'Message processing failed'),
          );
          if (!admitted) this.status.metrics.dropped++;
        }
      }),
    ];
  }

  private connectionChanged(
    session: WhatsAppSession,
    update: BaileysEventMap['connection.update'],
  ): void {
    if (!this.running || this.session !== session) return;
    if (update.qr) {
      this.update('pairing', 'Pairing code is ready');
      this.status.qr = update.qr;
      this.options.onQr(update.qr);
    }
    if (update.connection === 'open') {
      this.reconnectAttempts = 0;
      this.update('connected', 'WhatsApp connected');
    }
    if (update.connection !== 'close') return;
    this.scheduleReconnect(disconnectCode(update.lastDisconnect?.error));
  }

  private scheduleReconnect(code: number | undefined): void {
    if (!this.running) return;
    const delay = (this.options.retryDelay ?? reconnectDelay)(code, this.reconnectAttempts++);
    if (delay === null) {
      this.running = false;
      this.update('error', 'Session ended. Check linked devices or relink the account.');
      return;
    }
    this.update('reconnecting', 'Connection interrupted; retrying automatically');
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.running) return;
      void this.connect().catch((error) => {
        this.options.logger.error({ err: error }, 'Reconnect failed');
        if (error instanceof AuthStorageError) this.storageFailure(error);
        else this.scheduleReconnect(undefined);
      });
    }, delay);
  }

  private storageFailure(error: unknown): void {
    if (this.storageFailed) return;
    this.storageFailed = true;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.options.logger.error({ err: error }, 'Could not persist WhatsApp authentication');
    this.update('error', 'Could not save session; check worker storage before reconnecting');
    // Do not keep a live socket after a failed key write or process already queued messages.
    this.closing ??= (async () => {
      await this.opening?.catch(() => undefined);
      await this.messages.drain();
      await this.retireSession();
    })()
      .catch(() => undefined)
      .finally(() => {
        this.closing = undefined;
      });
  }

  private async processMessages(session: WhatsAppSession, messages: WAMessage[]): Promise<void> {
    for (const message of messages) {
      if (session !== this.session || this.storageFailed) return;
      try {
        const candidate = toGreetingCandidate(message, session.botJids);
        if (!candidate) continue;
        this.status.metrics.received++;
        const outcome = await this.options.handleMessage(candidate, (text) =>
          session.reply(message, text),
        );
        if (outcome === 'sent') {
          this.status.metrics.replied++;
          this.record('Replied hello');
        }
        if (outcome === 'duplicate') this.status.metrics.duplicates++;
      } catch (error) {
        this.status.metrics.errors++;
        this.options.logger.error({ err: error }, 'Greeting failed; claim retained');
        this.record('A greeting failed; see worker logs', 'error');
      }
    }
  }

  private async retireSession(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    try {
      await session?.close();
    } finally {
      // close() can emit a final credentials update; keep that listener until it finishes.
      await this.credentials;
      for (const unsubscribe of this.unsubscribe) unsubscribe();
      this.unsubscribe = [];
    }
  }

  private update(state: BotState, message: string): void {
    this.status.state = state;
    this.status.qr = null;
    this.status.updatedAt = new Date().toISOString();
    this.record(message, state === 'error' ? 'error' : 'info');
  }

  private record(message: string, level: 'info' | 'error' = 'info'): void {
    this.status.events.unshift({ at: new Date().toISOString(), level, message });
    this.status.events = this.status.events.slice(0, 30);
  }
}
