/** Deterministic due processing. No model or transport call occurs in this service. */
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { EmployeeIdentity } from '../identity/employee-identity.js';
import type { DueReminder, PersonalActor, ReminderDeliveryRef } from './scheduling.types.js';
import type { MessageQueueRepository } from '../../infrastructure/database/message-queue.repository.js';
import { authCipher } from '../../infrastructure/database/auth-store.js';
import { encodeReminderReply } from '../messaging/reply-payload.js';
import { cancellable } from '../../lib/cancellable.js';

export interface ReminderSchedulerRepository {
  claimDue(leaseMs: number): Promise<DueReminder | null>;
  prepareDue(): Promise<void>;
  claimPrepared(leaseMs: number, excludedEmployeeIds?: number[]): Promise<DueReminder | null>;
  renewDue(due: DueReminder, leaseMs: number): Promise<boolean>;
  releaseDue(due: DueReminder, reason: string, terminal?: 'suppressed' | 'failed'): Promise<void>;
  enqueueDue(
    due: DueReminder,
    recipient: PersonalActor,
    enqueue: (db: PoolClient, ref: ReminderDeliveryRef) => Promise<string | 'full'>,
  ): Promise<'queued' | 'full' | 'stale'>;
  reconcile(): Promise<void>;
}
export interface PersonalSchedulerOptions {
  encryptionKey: string;
  capacity: number;
  resolveEmployee: (
    id: number,
    signal: AbortSignal,
    chatId?: string,
  ) => Promise<EmployeeIdentity | null>;
  onQueued?: () => void;
  onError?: (reason: 'REMINDER_TICK_FAILED' | 'REMINDER_PREPARATION_FAILED') => void;
  pollMs?: number;
  leaseMs?: number;
  preparationTimeoutMs?: number;
  batchSize?: number;
  concurrency?: number;
  perOwnerLimit?: number;
}

export function reminderMessageId(accountId: string, ref: ReminderDeliveryRef): string {
  const h = createHash('sha256')
    .update(
      JSON.stringify([
        'ramesh:reminder:v1',
        accountId,
        ref.occurrenceId,
        ref.reminderId,
        ref.scheduleVersion,
        ref.dispatchGeneration,
      ]),
    )
    .digest();
  h[6] = (h[6]! & 0x0f) | 0x80;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function reminderEvidenceMatches(value: unknown, ref: ReminderDeliveryRef): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return (
    obj.kind === 'reminder' &&
    obj.version === 1 &&
    Object.keys(obj).length === 9 &&
    Object.entries(ref).every(([key, item]) => obj[key] === item) &&
    ['occurrenceId', 'reminderId'].every(
      (key) =>
        typeof obj[key] === 'string' &&
        /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(obj[key]),
    ) &&
    Number.isSafeInteger(ref.scheduleVersion) &&
    ref.scheduleVersion >= 1 &&
    Number.isSafeInteger(ref.dispatchGeneration) &&
    ref.dispatchGeneration >= 0 &&
    Number.isSafeInteger(ref.ownerEmployeeId) &&
    ref.ownerEmployeeId > 0 &&
    /^\+[1-9]\d{7,14}$/.test(ref.recipientPhoneE164) &&
    Number.isFinite(ref.notAfterMs)
  );
}

const validBound = (n: number, min: number, max: number) =>
  Number.isSafeInteger(n) && n >= min && n <= max;
export class PersonalSchedulerService {
  private readonly cipher;
  private readonly pollMs;
  private readonly leaseMs;
  private readonly timeoutMs;
  private readonly batchSize;
  private readonly concurrency;
  private readonly perOwnerLimit;
  private controller?: AbortController;
  private running?: Promise<void>;
  private ticking?: Promise<void>;
  private lastTickAt: string | null = null;
  private lastSuccessAt: string | null = null;
  private lastError = false;

  getStatus() {
    return {
      running: !!this.running,
      lastTickAt: this.lastTickAt,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
    };
  }

  constructor(
    private readonly repository: ReminderSchedulerRepository,
    private readonly queue: Pick<MessageQueueRepository, 'accountId' | 'enqueueReminder'>,
    private readonly options: PersonalSchedulerOptions,
  ) {
    this.pollMs = options.pollMs ?? 30000;
    this.leaseMs = options.leaseMs ?? 30000;
    this.timeoutMs = options.preparationTimeoutMs ?? 20000;
    this.batchSize = options.batchSize ?? 25;
    this.concurrency = options.concurrency ?? 2;
    this.perOwnerLimit = options.perOwnerLimit ?? 3;
    if (
      !validBound(this.pollMs, 100, 300000) ||
      !validBound(this.leaseMs, 1000, 120000) ||
      !validBound(this.timeoutMs, 100, 120000) ||
      !validBound(this.batchSize, 1, 100) ||
      !validBound(this.concurrency, 1, 4) ||
      !validBound(this.perOwnerLimit, 1, 25) ||
      !validBound(options.capacity, 1, 1000)
    )
      throw new Error('INVALID_REMINDER_SCHEDULER_CONFIG');
    this.cipher = authCipher(options.encryptionKey);
  }

  start(): void {
    if (this.running) return;
    const controller = new AbortController();
    this.controller = controller;
    this.running = this.run(controller.signal).finally(() => {
      if (this.controller === controller) this.controller = undefined;
      this.running = undefined;
    });
  }

  async stop(): Promise<void> {
    this.controller?.abort();
    await this.running;
    await this.ticking;
  }

  private report(reason: 'REMINDER_TICK_FAILED' | 'REMINDER_PREPARATION_FAILED') {
    this.lastError = true;
    try {
      this.options.onError?.(reason);
    } catch {
      /* Diagnostics cannot alter committed state. */
    }
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.tick(signal);
      } catch {
        this.report('REMINDER_TICK_FAILED');
      }
      if (signal.aborted) break;
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', finish);
          resolve();
        };
        const timer = setTimeout(finish, this.pollMs);
        timer.unref();
        signal.addEventListener('abort', finish, { once: true });
      });
    }
  }

  tick(signal: AbortSignal = new AbortController().signal): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.tickOnce(signal).finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }

  private async tickOnce(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.lastTickAt = new Date().toISOString();
    this.lastError = false;
    await this.repository.prepareDue();
    let remaining = this.batchSize;
    const ownerClaims = new Map<number, number>();
    // Claims already serialize on the database queue lock. Keep the local allowance
    // in that same order so concurrent preparation cannot overshoot an owner's cap.
    let claiming: Promise<unknown> = Promise.resolve();
    const claimNext = () => {
      const claimed = claiming.then(async () => {
        if (signal.aborted) return null;
        const excluded = [...ownerClaims]
          .filter(([, count]) => count >= this.perOwnerLimit)
          .map(([id]) => id);
        const due = await this.repository.claimPrepared(this.leaseMs, excluded);
        if (due) ownerClaims.set(due.employeeId, (ownerClaims.get(due.employeeId) ?? 0) + 1);
        return due;
      });
      claiming = claimed.catch(() => {});
      return claimed;
    };
    const work = async () => {
      while (!signal.aborted && remaining-- > 0) {
        const due = await claimNext();
        if (!due) break;
        await this.prepare(due, signal);
      }
    };
    const workers = await Promise.allSettled(Array.from({ length: this.concurrency }, work));
    for (const result of workers)
      if (result.status === 'rejected') this.report('REMINDER_TICK_FAILED');
    if (!this.lastError && !signal.aborted) this.lastSuccessAt = new Date().toISOString();
  }

  private async prepare(due: DueReminder, outer: AbortSignal): Promise<void> {
    const lease = new AbortController();
    const signal = AbortSignal.any([outer, lease.signal, AbortSignal.timeout(this.timeoutMs)]);
    let stopped = false;
    let pending: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const renew = () => {
      timer = setTimeout(
        () => {
          pending = (async () => {
            try {
              if (!(await this.repository.renewDue(due, this.leaseMs))) lease.abort();
            } catch {
              lease.abort();
            }
            if (!stopped && !signal.aborted) renew();
          })();
        },
        Math.floor(this.leaseMs / 3),
      );
      timer.unref();
    };
    renew();
    try {
      signal.throwIfAborted();
      const employee = await cancellable(
        () => this.options.resolveEmployee(due.employeeId, signal, due.chatId),
        signal,
      );
      signal.throwIfAborted();
      if (
        !employee?.active ||
        employee.employeeId !== due.employeeId ||
        employee.phoneE164 !== due.phoneE164
      ) {
        await this.repository.releaseDue(due, 'recipient_unavailable', 'suppressed');
        return;
      }
      if (!due.text.trim() || due.text.length > 4000 || !Number.isFinite(Date.parse(due.dueAt))) {
        await this.repository.releaseDue(due, 'invalid_reminder_text', 'failed');
        return;
      }
      const date = new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      }).format(new Date(due.dueAt));
      const text = `⏰ Reminder: ${due.text}\nScheduled for ${date} IST.`;
      const result = await this.repository.enqueueDue(
        due,
        {
          employeeId: employee.employeeId,
          phoneE164: employee.phoneE164,
          chatId: due.chatId,
        },
        async (db, ref) => {
          signal.throwIfAborted();
          const id = reminderMessageId(this.queue.accountId, ref);
          return this.queue.enqueueReminder(
            db,
            id,
            due.chatId,
            this.cipher.seal('inbox', id, {
              text,
              senderId: null,
              senderName: 'Ramesh',
              chatName: null,
              kind: 'text',
            }),
            this.cipher.seal('outbound-reply', id, encodeReminderReply(text, due.sourceQuote)),
            this.cipher.seal('business-delivery', id, { kind: 'reminder', version: 1, ...ref }),
            this.options.capacity,
            ref,
          );
        },
      );
      if (result === 'queued') {
        try {
          this.options.onQueued?.();
        } catch {
          /* Queue polling is the durable fallback. */
        }
      }
    } catch {
      if (!outer.aborted) this.report('REMINDER_PREPARATION_FAILED');
      // An invalid lease makes release a no-op; an already committed enqueue stays committed.
      await this.repository.releaseDue(
        due,
        outer.aborted ? 'scheduler_paused' : 'preparation_retry',
      );
    } finally {
      stopped = true;
      clearTimeout(timer);
      await pending;
    }
  }
}
