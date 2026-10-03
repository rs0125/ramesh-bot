/** PostgreSQL state + queue transactions. No connection is held during pacing or WhatsApp sends. */
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { batchDeadline, type DebouncePolicy } from '../../modules/messaging/debounce.js';
import type {
  AutomationEnqueueResult,
  OutboundAutomationStatus,
} from '../../contracts/outbound-automation.js';
import type { GreetingCandidate } from '../../modules/greetings/greeting.types.js';
import type { ReminderDeliveryRef } from '../../modules/scheduling/scheduling.types.js';
import type { EmployeeIdentity } from '../../modules/identity/employee-identity.js';

export type TerminalState = 'SENT' | 'EXPIRED' | 'FAILED' | 'UNCERTAIN';
export type QueueDirection = 'inbound' | 'outbound';
const queueTable = (direction: QueueDirection) =>
  direction === 'inbound' ? 'public."ramesh-inbound-queue"' : 'public."ramesh-outbound-queue"';
const readyState = (direction: QueueDirection) =>
  direction === 'inbound' ? 'QUEUED' : 'READY_TO_SEND';
export interface MessageJob {
  id: string;
  token: string;
  payload: string;
  attempts: number;
  receivedAt?: Date;
  direction: QueueDirection;
  replyPayload?: string;
  origin?: 'whatsapp' | 'admin' | 'automation' | 'reminder';
  reminder?: ReminderDeliveryRef;
  mediaPayload?: string;
  chatId?: string;
  replyKind?: 'conversation' | 'business';
  businessEvidence?: string;
  members?: Array<{ id: string; payload: string; receivedAt?: Date }>;
}
interface OwnedRow {
  id: string;
  state: string;
  attempts: number;
  max_attempts: number;
}

export class MessageQueueRepository {
  constructor(
    private readonly pool: Pool,
    readonly accountId: string,
    private readonly debounce?: DebouncePolicy,
    private readonly concurrency = 3,
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)
      throw new Error('INVALID_QUEUE_CONCURRENCY');
  }

  async health(): Promise<void> {
    const result = await this.pool.query(`SELECT current_user AS role, version
      FROM public."ramesh-schema-migrations" WHERE version='202610030008'`);
    if (result.rows[0]?.role !== 'ramesh_worker')
      throw new Error('Message queue schema or runtime role is not ready');
  }

  /** Early media and the later combined turn share the already committed batch root. */
  async usageRunId(chatId: string, messageId: string): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT coalesce(j.batch_parent,m.id)::text AS id FROM public."ramesh-messages" m
       JOIN public."ramesh-inbound-queue" j ON j.message_id=m.id
       WHERE m.account_id=$1 AND m.chat_id=$2 AND m.whatsapp_message_id=$3`,
      [this.accountId, chatId, messageId],
    );
    if (!result.rows[0]) throw new Error('USAGE_MESSAGE_NOT_ADMITTED');
    return result.rows[0].id;
  }

  private async transaction<T>(work: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    let destroy = false;
    try {
      await db.query('BEGIN');
      await db.query("SET LOCAL lock_timeout='1000ms'");
      await db.query("SET LOCAL idle_in_transaction_session_timeout='6000ms'");
      // Account-scoped admission/recovery is atomic across competing worker processes.
      // Transaction-scoped locks work through Supabase's transaction pooler.
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `ramesh:queue:${this.accountId}`,
      ]);
      const result = await work(db);
      await db.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await db.query('ROLLBACK');
      } catch {
        destroy = true;
      }
      throw error;
    } finally {
      db.release(destroy);
    }
  }

  async enqueue(
    id: string,
    message: GreetingCandidate,
    payload: string,
    maxAgeMs: number,
    capacity: number,
    inbox?: { content: string; replyEligible: boolean },
  ): Promise<'queued' | 'duplicate' | 'full' | 'observed'> {
    return this.transaction(async (db) => {
      if (
        (
          await db.query(
            `SELECT 1 FROM public."ramesh-messages"
        WHERE account_id=$1 AND chat_id=$2 AND whatsapp_message_id=$3`,
            [this.accountId, message.chatId, message.messageId],
          )
        ).rowCount
      )
        return 'duplicate';
      const eligible = inbox?.replyEligible ?? true;
      const count = eligible
        ? await db.query(
            `SELECT count(*)::int AS count FROM public."ramesh-messages"
        WHERE account_id=$1 AND state IN ('QUEUED','PROCESSING','READY_TO_SEND','SENDING')`,
            [this.accountId],
          )
        : undefined;
      const full = (count?.rows[0].count ?? 0) >= capacity;
      if (full && !inbox) return 'full';
      const queued = eligible && !full;
      await db.query(
        `INSERT INTO public."ramesh-messages"
        (id,account_id,chat_id,whatsapp_message_id,sent_at,expires_at,state,payload_encrypted,
         content_encrypted,mentions_bot,finished_at,reason)
        VALUES ($1,$2,$3,$4,$5,$6,$8,$7,$9,$10,
          CASE WHEN $8='OBSERVED' THEN clock_timestamp() ELSE NULL END,$11)`,
        [
          id,
          this.accountId,
          message.chatId,
          message.messageId,
          new Date(message.sentAtMs),
          new Date(message.sentAtMs + maxAgeMs),
          queued ? payload : null,
          queued ? 'QUEUED' : 'OBSERVED',
          inbox?.content ?? null,
          message.mentionsBot,
          full ? 'queue_full' : null,
        ],
      );
      if (!queued) return full ? 'full' : 'observed';
      const senderKey = createHash('sha256')
        .update(JSON.stringify([message.chatId, message.senderId ?? message.chatId]))
        .digest('hex');
      const media = ['audio', 'image', 'document'].includes(message.kind ?? '');
      const first = this.debounce
        ? (
            await db.query(
              `SELECT j.message_id,j.created_at FROM public."ramesh-inbound-queue" j
        JOIN public."ramesh-messages" m ON m.id=j.message_id WHERE j.account_id=$1 AND j.sender_key=$2
        AND j.batch_parent IS NULL AND NOT j.batch_closed AND j.state='READY' AND j.available_at>clock_timestamp()
        AND j.created_at+($3*interval '1 millisecond')>clock_timestamp() AND j.batch_count<16 AND j.batch_chars+$4<=24000
        AND j.media_count+$5<=8 AND m.expires_at>clock_timestamp()+interval '10 seconds'
        AND NOT EXISTS (
          SELECT 1 FROM public."ramesh-messages" newer
          LEFT JOIN public."ramesh-inbound-queue" child ON child.message_id=newer.id
          WHERE newer.account_id=m.account_id AND newer.chat_id=m.chat_id
          AND newer.queue_order>m.queue_order AND newer.id<>$6
          AND (child.batch_parent IS NULL OR child.batch_parent<>m.id)
        )
        ORDER BY j.created_at DESC LIMIT 1 FOR UPDATE OF j`,
              [
                this.accountId,
                senderKey,
                this.debounce.maxMs,
                message.text?.length ?? 0,
                media ? 1 : 0,
                id,
              ],
            )
          ).rows[0]
        : undefined;
      const available = this.debounce
        ? new Date(
            batchDeadline(
              first?.created_at.getTime() ?? Date.now(),
              Date.now(),
              { media, forwarded: message.forwarded },
              this.debounce,
            ),
          )
        : new Date();
      await db.query(
        `INSERT INTO public."ramesh-inbound-queue" (message_id,account_id,sender_key,batch_parent,available_at,batch_chars,media_count)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          id,
          this.accountId,
          senderKey,
          first?.message_id ?? null,
          available,
          message.text?.length ?? 0,
          media ? 1 : 0,
        ],
      );
      if (first)
        await db.query(
          `UPDATE public."ramesh-inbound-queue" SET available_at=$2,batch_count=batch_count+1,batch_chars=batch_chars+$3,media_count=media_count+$4 WHERE message_id=$1`,
          [first.message_id, available, message.text?.length ?? 0, media ? 1 : 0],
        );
      return 'queued';
    });
  }

  /** An operator request goes directly to the existing outbound queue, atomically and idempotently. */
  async enqueueAdmin(
    id: string,
    chatId: string,
    content: string,
    replyPayload: string,
    capacity: number,
    fingerprint: string,
  ): Promise<'queued' | 'duplicate' | 'full' | 'unknown_chat' | 'conflict'> {
    return this.transaction(async (db) => {
      const existing = (
        await db.query(
          `SELECT chat_id,origin,request_fingerprint FROM public."ramesh-messages" WHERE account_id=$1 AND id=$2`,
          [this.accountId, id],
        )
      ).rows[0];
      if (existing)
        return existing.origin === 'admin' &&
          existing.chat_id === chatId &&
          existing.request_fingerprint === fingerprint
          ? 'duplicate'
          : 'conflict';
      // Destinations must come from the actual received inbox, never an arbitrary JID.
      if (
        !(
          await db.query(
            `SELECT 1 FROM public."ramesh-messages" WHERE account_id=$1 AND chat_id=$2
         AND origin='whatsapp' AND content_encrypted IS NOT NULL LIMIT 1`,
            [this.accountId, chatId],
          )
        ).rowCount
      )
        return 'unknown_chat';
      const count = await db.query(
        `SELECT count(*)::int AS count FROM public."ramesh-messages"
         WHERE account_id=$1 AND state IN ('QUEUED','PROCESSING','READY_TO_SEND','SENDING')`,
        [this.accountId],
      );
      if (count.rows[0].count >= capacity) return 'full';
      await db.query(
        `INSERT INTO public."ramesh-messages"
        (id,account_id,chat_id,whatsapp_message_id,sent_at,expires_at,state,payload_encrypted,
         origin,content_encrypted,reply_encrypted,reply_created_at,request_fingerprint)
        VALUES ($1,$2,$3,$4,clock_timestamp(),clock_timestamp()+interval '5 minutes',
          'READY_TO_SEND',$5,'admin',$6,$5,clock_timestamp(),$7)`,
        [id, this.accountId, chatId, `admin:${id}`, replyPayload, content, fingerprint],
      );
      await db.query(
        `INSERT INTO public."ramesh-outbound-queue" (message_id,account_id,payload_encrypted) VALUES ($1,$2,$3)`,
        [id, this.accountId, replyPayload],
      );
      return 'queued';
    });
  }

  /** Server-authorized outbound admission. Does not weaken operator inbox destination checks. */
  async enqueueAutomation(
    id: string,
    chatId: string,
    content: string,
    replyPayload: string,
    capacity: number,
    fingerprint: string,
    expiresInSeconds: number,
    media?: { payload: string; byteLength: number },
  ): Promise<AutomationEnqueueResult> {
    if (
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id) ||
      !/^[1-9]\d{7,14}@s\.whatsapp\.net$/.test(chatId) ||
      !/^[a-f0-9]{64}$/.test(fingerprint) ||
      !Number.isSafeInteger(expiresInSeconds) ||
      expiresInSeconds < 30 ||
      expiresInSeconds > 86400 ||
      !Number.isSafeInteger(capacity) ||
      capacity < 1 ||
      capacity > 1000 ||
      (media &&
        (!Number.isSafeInteger(media.byteLength) ||
          media.byteLength < 1 ||
          media.byteLength > 8388608 ||
          !media.payload ||
          Buffer.byteLength(media.payload) > 16777216))
    )
      throw new Error('INVALID_AUTOMATION_ENQUEUE');
    return this.transaction(async (db) => {
      const existing = (
        await db.query(
          `SELECT origin,chat_id,request_fingerprint FROM public."ramesh-messages" WHERE account_id=$1 AND id=$2`,
          [this.accountId, id],
        )
      ).rows[0];
      if (existing)
        return existing.origin === 'automation' &&
          existing.chat_id === chatId &&
          existing.request_fingerprint === fingerprint
          ? 'duplicate'
          : 'conflict';
      const count = await db.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM public."ramesh-messages"
         WHERE account_id=$1 AND state IN ('QUEUED','PROCESSING','READY_TO_SEND','SENDING')`,
        [this.accountId],
      );
      if (count.rows[0]!.count >= capacity) return 'full';
      await db.query(
        `INSERT INTO public."ramesh-messages"
         (id,account_id,chat_id,whatsapp_message_id,sent_at,expires_at,state,payload_encrypted,
          origin,content_encrypted,reply_encrypted,reply_created_at,request_fingerprint)
         VALUES ($1,$2,$3,$4,clock_timestamp(),clock_timestamp()+$8*interval '1 second',
          'READY_TO_SEND',$5,'automation',$6,$5,clock_timestamp(),$7)`,
        [
          id,
          this.accountId,
          chatId,
          `automation:${id}`,
          replyPayload,
          content,
          fingerprint,
          expiresInSeconds,
        ],
      );
      await db.query(
        `INSERT INTO public."ramesh-outbound-queue"
         (message_id,account_id,payload_encrypted,media_payload_encrypted,media_byte_length,media_expires_at)
         SELECT id,account_id,$3,$4,$5,CASE WHEN $4::text IS NULL THEN NULL ELSE expires_at END
         FROM public."ramesh-messages" WHERE id=$1 AND account_id=$2`,
        [id, this.accountId, replyPayload, media?.payload ?? null, media?.byteLength ?? null],
      );
      return 'queued';
    });
  }

  /** Internal only: caller owns the fenced occurrence transaction and the account admission lock. */
  async enqueueReminder(
    db: PoolClient,
    id: string,
    chatId: string,
    content: string,
    replyPayload: string,
    businessEvidence: string,
    capacity: number,
    ref: ReminderDeliveryRef,
  ): Promise<string | 'full'> {
    if (
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id) ||
      !/^\+[1-9]\d{7,14}$/.test(ref.recipientPhoneE164) ||
      !/^(?:[1-9]\d{7,14}@s\.whatsapp\.net|\d{5,20}@lid)$/.test(chatId) ||
      (chatId.endsWith('@s.whatsapp.net') &&
        chatId !== `${ref.recipientPhoneE164.slice(1)}@s.whatsapp.net`) ||
      !Number.isSafeInteger(capacity) ||
      capacity < 1 ||
      capacity > 1000 ||
      !Number.isFinite(ref.notAfterMs) ||
      ref.notAfterMs <= Date.now() ||
      !content ||
      !replyPayload ||
      !businessEvidence
    )
      throw new Error('INVALID_REMINDER_ENQUEUE');
    const existing = await db.query(
      `SELECT m.id FROM public."ramesh-messages" m
       JOIN public."ramesh-reminder-occurrences" o ON o.outbound_message_id=m.id
       WHERE m.id=$1 AND m.account_id=$2 AND m.origin='reminder'
       AND o.id=$3 AND o.schedule_version=$4 AND o.dispatch_generation=$5`,
      [id, this.accountId, ref.occurrenceId, ref.scheduleVersion, ref.dispatchGeneration],
    );
    if (existing.rowCount) return id;
    const count = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM public."ramesh-messages" WHERE account_id=$1
       AND state IN ('QUEUED','PROCESSING','READY_TO_SEND','SENDING')`,
      [this.accountId],
    );
    if (count.rows[0]!.count >= capacity) return 'full';
    await db.query(
      `INSERT INTO public."ramesh-messages"
       (id,account_id,chat_id,whatsapp_message_id,sent_at,expires_at,state,payload_encrypted,
        origin,content_encrypted,reply_encrypted,reply_created_at,reply_kind,business_evidence_encrypted)
       VALUES ($1,$2,$3,$4,clock_timestamp(),$5,'READY_TO_SEND',$6,'reminder',$7,$6,
        clock_timestamp(),'business',$8)`,
      [
        id,
        this.accountId,
        chatId,
        `reminder:${id}`,
        new Date(ref.notAfterMs),
        replyPayload,
        content,
        businessEvidence,
      ],
    );
    await db.query(
      `INSERT INTO public."ramesh-outbound-queue" (message_id,account_id,payload_encrypted)
       VALUES ($1,$2,$3)`,
      [id, this.accountId, replyPayload],
    );
    return id;
  }

  /** Automation credentials must not disclose inbox/operator/inbound job metadata. */
  async automationStatus(id: string): Promise<OutboundAutomationStatus | null> {
    const row = (
      await this.pool.query<{
        id: string;
        state: string;
        created_at: Date;
        expires_at: Date;
        finished_at: Date | null;
        reason: string | null;
      }>(
        `SELECT id,state,created_at,expires_at,finished_at,reason FROM public."ramesh-messages"
       WHERE id=$1 AND account_id=$2 AND origin='automation'`,
        [id, this.accountId],
      )
    ).rows[0];
    if (!row) return null;
    // Never let an arbitrary database reason become an external error/message disclosure.
    const reasons = new Set([
      'message_too_old',
      'attempts_exhausted',
      'send_interrupted',
      'send_or_status_failed',
      'invalid_encrypted_reply',
      'invalid_automation_media',
      'manual_send_unavailable',
      'automation_send_unavailable',
      'connection_paused',
      'processing_retry',
      'lease_expired',
    ]);
    return {
      messageId: row.id,
      state: row.state,
      createdAt: row.created_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
      finishedAt: row.finished_at?.toISOString() ?? null,
      reason: row.reason && reasons.has(row.reason) ? row.reason : null,
    };
  }

  private async finish(
    db: PoolClient,
    job: Pick<MessageJob, 'id' | 'direction'>,
    state: TerminalState,
    reason: string | null,
  ): Promise<void> {
    await db.query(
      `UPDATE ${queueTable(job.direction)} SET state=$3,lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp()
      WHERE message_id=$1 AND account_id=$2`,
      [job.id, this.accountId, ['SENT', 'EXPIRED'].includes(state) ? 'DONE' : 'DEAD'],
    );
    await db.query(
      `UPDATE public."ramesh-outbound-queue" SET payload_encrypted=NULL WHERE message_id=$1 AND account_id=$2`,
      [job.id, this.accountId],
    );
    await db.query(
      `UPDATE public."ramesh-messages" SET state=$3,reason=$4,payload_encrypted=NULL,
      finished_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 AND account_id=$2`,
      [job.id, this.accountId, state, reason],
    );
    await this.finishMembers(db, job.id, state, reason);
    await db.query(
      `UPDATE public."ramesh-agent-runs" SET state='failed',updated_at=clock_timestamp()
       WHERE id=$1 AND account_id=$2 AND state='running'`,
      [job.id, this.accountId],
    );
  }

  private async finishMembers(db: PoolClient, id: string, state: string, reason: string | null) {
    await db.query(
      `UPDATE public."ramesh-messages" m SET state=$3,reason=$4,payload_encrypted=NULL,finished_at=clock_timestamp(),updated_at=clock_timestamp()
      FROM public."ramesh-inbound-queue" j WHERE j.message_id=m.id AND j.batch_parent=$1 AND j.account_id=$2 AND m.state='QUEUED'`,
      [id, this.accountId, state, reason],
    );
    await db.query(
      `UPDATE public."ramesh-inbound-queue" SET state='DONE',updated_at=clock_timestamp() WHERE batch_parent=$1 AND account_id=$2`,
      [id, this.accountId],
    );
  }

  private async requeue(
    db: PoolClient,
    job: MessageJob,
    reason: string,
    delayMs: number,
  ): Promise<void> {
    await db.query(
      `UPDATE ${queueTable(job.direction)} SET state='READY',lease_token=NULL,lease_until=NULL,
      available_at=clock_timestamp()+$3*interval '1 millisecond',updated_at=clock_timestamp()
      WHERE message_id=$1 AND account_id=$2`,
      [job.id, this.accountId, delayMs],
    );
    await db.query(
      `UPDATE public."ramesh-messages" SET state=$4,reason=$3,updated_at=clock_timestamp()
      WHERE id=$1 AND account_id=$2`,
      [job.id, this.accountId, reason, readyState(job.direction)],
    );
  }

  private async recover(db: PoolClient): Promise<void> {
    // Also purge media whose message is still leased while cancellation/recovery catches up.
    await db.query(
      `UPDATE public."ramesh-outbound-queue" SET media_payload_encrypted=NULL,
      media_byte_length=NULL,media_expires_at=NULL
      WHERE account_id=$1 AND media_expires_at<=clock_timestamp()`,
      [this.accountId],
    );
    for (const direction of ['inbound', 'outbound'] as const) {
      const table = queueTable(direction);
      const ready = readyState(direction);
      // This also conservatively recovers legacy SENDING leases in the renamed inbound table.
      await db.query(
        `WITH expired AS (
      SELECT m.id,CASE WHEN m.state='SENDING' THEN 'UNCERTAIN'
        WHEN j.attempts>=j.max_attempts THEN 'FAILED' ELSE $2 END AS next_state
      FROM ${table} j JOIN public."ramesh-messages" m ON m.id=j.message_id
      WHERE j.account_id=$1 AND j.state='LEASED' AND j.lease_until<=clock_timestamp() FOR UPDATE OF j,m
    ), changed AS (
      UPDATE public."ramesh-messages" m SET state=e.next_state,
        reason=CASE e.next_state WHEN 'UNCERTAIN' THEN 'send_interrupted' WHEN 'FAILED' THEN 'attempts_exhausted' ELSE 'lease_expired' END,
        payload_encrypted=CASE WHEN e.next_state=$2 THEN m.payload_encrypted ELSE NULL END,
        finished_at=CASE WHEN e.next_state=$2 THEN NULL ELSE clock_timestamp() END,
        updated_at=clock_timestamp() FROM expired e WHERE m.id=e.id RETURNING m.id,m.state
    ) UPDATE ${table} j SET state=CASE WHEN c.state=$2 THEN 'READY' ELSE 'DEAD' END,
      lease_token=NULL,lease_until=NULL,available_at=clock_timestamp(),updated_at=clock_timestamp()
      ${direction === 'outbound' ? ',payload_encrypted=CASE WHEN c.state=$2 THEN j.payload_encrypted ELSE NULL END' : ''}
      FROM changed c WHERE j.message_id=c.id`,
        [this.accountId, ready],
      );
      await db.query(
        `WITH stale AS (
      UPDATE public."ramesh-messages" m SET state='EXPIRED',reason='message_too_old',payload_encrypted=NULL,
        finished_at=clock_timestamp(),updated_at=clock_timestamp()
      FROM ${table} j WHERE j.message_id=m.id AND m.account_id=$1
        AND j.state='READY' AND m.expires_at<=clock_timestamp() RETURNING m.id
    ) UPDATE ${table} j SET state='DONE',updated_at=clock_timestamp()
      ${direction === 'outbound' ? ',payload_encrypted=NULL' : ''}
      FROM stale s WHERE j.message_id=s.id`,
        [this.accountId],
      );
    }
    await db.query(
      `UPDATE public."ramesh-agent-runs" r SET state='failed',updated_at=clock_timestamp()
       FROM public."ramesh-messages" m WHERE r.id=m.id AND r.account_id=$1 AND r.state='running'
       AND m.state IN ('FAILED','EXPIRED','UNCERTAIN')`,
      [this.accountId],
    );
    const terminalParents = (
      await db.query(
        `SELECT m.id,m.state,m.reason FROM public."ramesh-messages" m WHERE m.account_id=$1 AND m.state IN ('FAILED','EXPIRED','UNCERTAIN') AND EXISTS(SELECT 1 FROM public."ramesh-inbound-queue" j WHERE j.batch_parent=m.id AND j.state='READY')`,
        [this.accountId],
      )
    ).rows;
    for (const parent of terminalParents)
      await this.finishMembers(db, parent.id, parent.state, parent.reason);
  }

  /** A due job blocked by its chat must not turn the consumer into a busy poller. */
  async nextInboundDelay(maxMs: number) {
    const row = (
      await this.pool.query(
        `SELECT extract(epoch FROM min(j.available_at)-clock_timestamp())*1000 AS wait
         FROM public."ramesh-inbound-queue" j JOIN public."ramesh-messages" m ON m.id=j.message_id
         WHERE j.account_id=$1 AND j.state='READY' AND j.batch_parent IS NULL
         AND ${this.conversationHead('m')}`,
        [this.accountId],
      )
    ).rows[0];
    return row?.wait == null ? maxMs : Math.min(maxMs, Math.max(25, Number(row.wait)));
  }

  /** Include the human turn's pending reply, so a yielded reminder cannot overtake its answer. */
  private pendingHuman(alias: string): string {
    return `EXISTS (
      SELECT 1 FROM public."ramesh-messages" human
      JOIN public."ramesh-inbound-queue" turn ON turn.message_id=human.id
      WHERE human.account_id=${alias}.account_id AND human.chat_id=${alias}.chat_id
      AND human.origin='whatsapp' AND turn.batch_parent IS NULL
      AND human.state IN ('QUEUED','PROCESSING','READY_TO_SEND','SENDING')
    )`;
  }

  /** Human turns and their predecessors bypass only unsent scheduler notifications. */
  private conversationHead(alias: string): string {
    return `(${alias}.origin<>'reminder' OR NOT ${this.pendingHuman(alias)}) AND NOT EXISTS (
      SELECT 1 FROM public."ramesh-messages" earlier
      LEFT JOIN public."ramesh-inbound-queue" child ON child.message_id=earlier.id
      WHERE earlier.account_id=${alias}.account_id AND earlier.chat_id=${alias}.chat_id
      AND earlier.queue_order<${alias}.queue_order
      AND earlier.state IN ('QUEUED','PROCESSING','READY_TO_SEND','SENDING')
      AND child.batch_parent IS NULL
      AND NOT (earlier.origin='reminder' AND earlier.state='READY_TO_SEND'
        AND ${this.pendingHuman(alias)})
    )`;
  }

  private async yieldReminder(db: PoolClient, job: MessageJob): Promise<boolean> {
    if (job.origin !== 'reminder') return false;
    const current = await this.owned(db, job);
    if (!current || current.state !== 'READY_TO_SEND') return false;
    const pending = await db.query(
      `SELECT 1 FROM public."ramesh-messages" m WHERE m.id=$1 AND m.account_id=$2
       AND m.origin='reminder' AND ${this.pendingHuman('m')}`,
      [job.id, this.accountId],
    );
    if (!pending.rowCount) return false;
    await db.query(
      `UPDATE public."ramesh-outbound-queue" SET attempts=greatest(0,attempts-1)
       WHERE message_id=$1 AND account_id=$2`,
      [job.id, this.accountId],
    );
    await this.requeue(db, job, 'human_turn_pending', 0);
    return true;
  }

  /** Pacing must not keep the only outbound lease while a human needs to cancel a reminder. */
  async yieldReminderToHuman(job: MessageJob): Promise<boolean> {
    return job.direction === 'outbound' && job.origin === 'reminder'
      ? this.transaction((db) => this.yieldReminder(db, job))
      : false;
  }

  claimInbound(leaseMs: number) {
    return this.claim('inbound', leaseMs);
  }
  claimOutbound(leaseMs: number) {
    return this.claim('outbound', leaseMs);
  }
  /** Choose fairly across both directions, without starving inbound work behind outbound traffic. */
  claimNext(leaseMs: number) {
    return this.claim(undefined, leaseMs);
  }

  private async claim(
    requested: QueueDirection | undefined,
    leaseMs: number,
  ): Promise<MessageJob | null> {
    return this.transaction(async (db) => {
      await this.recover(db);
      const active = await db.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM (
          SELECT 1 FROM public."ramesh-inbound-queue" WHERE account_id=$1 AND state='LEASED'
          UNION ALL SELECT 1 FROM public."ramesh-outbound-queue" WHERE account_id=$1 AND state='LEASED'
        ) leases`,
        [this.accountId],
      );
      if (active.rows[0]!.count >= this.concurrency) return null;
      const directions = requested ? [requested] : (['inbound', 'outbound'] as const);
      const choices = directions.map(
        (direction) => `
        SELECT m.id,m.payload_encrypted AS payload,j.attempts,m.origin,m.chat_id AS "chatId",m.created_at AS "receivedAt",
          m.reply_kind AS "replyKind",m.business_evidence_encrypted AS "businessEvidence",
          ${direction === 'outbound' ? 'j.payload_encrypted' : 'NULL::text'} AS "replyPayload",
          ${direction === 'outbound' ? 'j.media_payload_encrypted' : 'NULL::text'} AS "mediaPayload",
          ${
            direction === 'outbound'
              ? `(SELECT jsonb_build_object(
            'occurrenceId',o.id,'reminderId',o.reminder_id,'scheduleVersion',o.schedule_version,
            'dispatchGeneration',o.dispatch_generation,'ownerEmployeeId',o.recipient_employee_id,
            'recipientPhoneE164',o.recipient_phone_e164,
            'notAfterMs',floor(extract(epoch FROM o.not_after)*1000))
            FROM public."ramesh-reminder-occurrences" o WHERE o.outbound_message_id=m.id AND o.account_id=m.account_id)`
              : 'NULL::jsonb'
          } AS reminder,
          '${direction}'::text AS direction,m.queue_order
        FROM ${queueTable(direction)} j JOIN public."ramesh-messages" m ON m.id=j.message_id
        WHERE j.account_id=$1 AND j.state='READY' AND j.available_at<=clock_timestamp()
        ${direction === 'inbound' ? 'AND j.batch_parent IS NULL' : `AND NOT EXISTS (SELECT 1 FROM public."ramesh-outbound-queue" sending WHERE sending.account_id=j.account_id AND sending.state='LEASED')`}
        AND ${this.conversationHead('m')}
        AND NOT EXISTS (
          SELECT 1 FROM public."ramesh-messages" busy
          WHERE busy.account_id=m.account_id AND busy.chat_id=m.chat_id
          AND busy.state IN ('QUEUED','PROCESSING','READY_TO_SEND','SENDING') AND (
            EXISTS(SELECT 1 FROM public."ramesh-inbound-queue" iq WHERE iq.message_id=busy.id AND iq.state='LEASED') OR
            EXISTS(SELECT 1 FROM public."ramesh-outbound-queue" oq WHERE oq.message_id=busy.id AND oq.state='LEASED')
          )
        )`,
      );
      // The account transaction lock serializes candidate selection + leasing across processes.
      const next = await db.query<MessageJob & { queue_order: string }>(
        `SELECT * FROM (${choices.join(' UNION ALL ')}) candidates ORDER BY queue_order LIMIT 1`,
        [this.accountId],
      );
      const row = next.rows[0];
      if (!row) return null;
      const direction = row.direction;
      const token = randomUUID();
      await db.query(
        `UPDATE ${queueTable(direction)} SET state='LEASED',lease_token=$2,
        lease_until=clock_timestamp()+$3*interval '1 millisecond',attempts=attempts+1,updated_at=clock_timestamp()
        ${direction === 'inbound' ? ',batch_closed=true' : ''}
        WHERE message_id=$1`,
        [row.id, token, leaseMs],
      );
      await db.query(
        `UPDATE public."ramesh-messages" SET state=$2,reason=NULL,updated_at=clock_timestamp() WHERE id=$1`,
        [row.id, direction === 'inbound' ? 'PROCESSING' : 'READY_TO_SEND'],
      );
      const members =
        direction === 'inbound'
          ? (
              await db.query(
                `SELECT m.id,m.payload_encrypted AS payload,m.created_at AS "receivedAt" FROM public."ramesh-inbound-queue" j JOIN public."ramesh-messages" m ON m.id=j.message_id WHERE j.batch_parent=$1 AND j.account_id=$2 AND m.payload_encrypted IS NOT NULL ORDER BY m.queue_order`,
                [row.id, this.accountId],
              )
            ).rows
          : undefined;
      return {
        ...row,
        direction,
        token,
        attempts: row.attempts + 1,
        ...(members?.length ? { members } : {}),
      };
    });
  }

  /** A renewal cannot resurrect an expired token or retain work beyond its lifetime. */
  async renewLease(job: MessageJob, leaseMs: number): Promise<boolean> {
    return this.transaction(async (db) => {
      const renewed = await db.query(
        `UPDATE ${queueTable(job.direction)} j
         SET lease_until=least(m.expires_at,clock_timestamp()+$4*interval '1 millisecond'),updated_at=clock_timestamp()
         FROM public."ramesh-messages" m WHERE m.id=j.message_id AND j.message_id=$1 AND j.account_id=$2
         AND j.state='LEASED' AND j.lease_token=$3 AND j.lease_until>clock_timestamp()
         AND m.expires_at>clock_timestamp() RETURNING j.message_id`,
        [job.id, this.accountId, job.token, leaseMs],
      );
      return renewed.rowCount === 1;
    });
  }

  /** Commit the final reply and inbound completion together, before the sender can see it. */
  async handoff(
    job: MessageJob,
    replyPayload: string,
    availableAt = new Date(),
    businessEvidence?: string,
    personalCommandId?: string,
  ): Promise<boolean> {
    if (job.direction !== 'inbound') return false;
    return this.transaction(async (db) => {
      const row = await this.owned(db, job);
      if (!row || row.state !== 'PROCESSING') return false;
      const fresh = await db.query(
        `SELECT 1 FROM public."ramesh-messages" WHERE id=$1 AND expires_at>clock_timestamp()`,
        [job.id],
      );
      if (!fresh.rowCount) {
        await this.finish(db, job, 'EXPIRED', 'message_too_old');
        return false;
      }
      // A successful/ambiguous commit must never be finalized as a generic failure reply.
      // Returning false retains the original run for bounded retry and receipt recovery.
      const command = (
        await db.query<{ id: string }>(
          `SELECT id FROM public."ramesh-assistant-commands"
           WHERE account_id=$1 AND run_id=$2 AND kind='mutation'`,
          [this.accountId, job.id],
        )
      ).rows[0];
      if (
        (command && (!businessEvidence || personalCommandId !== command.id)) ||
        (!command && personalCommandId)
      )
        return false;
      await db.query(
        `INSERT INTO public."ramesh-outbound-queue" (message_id,account_id,payload_encrypted,available_at) VALUES ($1,$2,$3,$4)`,
        [job.id, this.accountId, replyPayload, availableAt],
      );
      await db.query(
        `UPDATE public."ramesh-inbound-queue" SET state='DONE',lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE message_id=$1`,
        [job.id],
      );
      await db.query(
        `UPDATE public."ramesh-messages" SET state='READY_TO_SEND',reason=NULL,
         reply_encrypted=$2,reply_kind=$3,business_evidence_encrypted=$4,
         reply_created_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`,
        [
          job.id,
          replyPayload,
          businessEvidence ? 'business' : 'conversation',
          businessEvidence ?? null,
        ],
      );
      await this.finishMembers(db, job.id, 'OBSERVED', 'batched_into_reply');
      const finalized = await db.query(
        `UPDATE public."ramesh-agent-runs" SET state='finalized',finalized_at=clock_timestamp(),updated_at=clock_timestamp()
         WHERE id=$1 AND account_id=$2 AND lease_token=$3 AND state='running' RETURNING id`,
        [job.id, this.accountId, job.token],
      );
      if (businessEvidence && !finalized.rowCount)
        throw new Error('Business reply requires a fenced agent run');
      if (finalized.rowCount)
        await db.query(
          `INSERT INTO public."ramesh-agent-events" (account_id,run_id,attempt,kind) VALUES ($1,$2,$3,'finalized')`,
          [this.accountId, job.id, job.attempts],
        );
      return true;
    });
  }

  /** One journal row per inbound message; a new lease advances the retry attempt, never a completed run. */
  async beginAgentRun(job: MessageJob): Promise<boolean> {
    if (job.direction !== 'inbound') return false;
    return this.transaction(async (db) => {
      const row = await this.owned(db, job);
      if (!row || row.state !== 'PROCESSING') return false;
      const result = await db.query(
        `INSERT INTO public."ramesh-agent-runs" (id,account_id,state,attempt,lease_token)
         VALUES ($1,$2,'running',$3,$4) ON CONFLICT (id) DO UPDATE SET
         attempt=EXCLUDED.attempt,lease_token=EXCLUDED.lease_token,updated_at=clock_timestamp()
         WHERE "ramesh-agent-runs".account_id=EXCLUDED.account_id AND "ramesh-agent-runs".state='running'
         RETURNING id`,
        [job.id, this.accountId, job.attempts, job.token],
      );
      return !!result.rowCount;
    });
  }

  async recordAgentEvent(
    job: MessageJob,
    kind: 'tool_started' | 'tool_succeeded' | 'tool_failed',
    payload: string,
  ): Promise<void> {
    if (job.direction !== 'inbound') throw new Error('Invalid agent event owner');
    await this.transaction(async (db) => {
      const row = await this.owned(db, job);
      if (!row || row.state !== 'PROCESSING') throw new Error('Agent lease expired');
      const inserted = await db.query(
        `INSERT INTO public."ramesh-agent-events" (account_id,run_id,attempt,kind,payload_encrypted)
         SELECT account_id,id,attempt,$4,$5 FROM public."ramesh-agent-runs"
         WHERE id=$1 AND account_id=$2 AND lease_token=$3 AND state='running' RETURNING id`,
        [job.id, this.accountId, job.token, kind, payload],
      );
      if (!inserted.rowCount) throw new Error('Agent run is not active');
    });
  }

  async beginSend(
    job: MessageJob,
    preflight?: { employee: EmployeeIdentity; checkedAtMs: number },
  ): Promise<boolean> {
    if (job.direction !== 'outbound') return false;
    return this.transaction(async (db) => {
      if (await this.yieldReminder(db, job)) return false;
      let reminderAuthorized = false;
      if (job.origin === 'reminder') {
        const ref = job.reminder;
        const actor = preflight?.employee;
        const proofAge = Date.now() - (preflight?.checkedAtMs ?? 0);
        if (
          !ref ||
          !actor?.active ||
          actor.employeeId !== ref.ownerEmployeeId ||
          actor.phoneE164 !== ref.recipientPhoneE164 ||
          proofAge < 0 ||
          proofAge > 10000
        )
          return false;
        const valid = await db.query(
          `SELECT o.id FROM public."ramesh-reminder-occurrences" o
           JOIN public."ramesh-reminders" r ON r.id=o.reminder_id AND r.account_id=o.account_id
           LEFT JOIN public."ramesh-tasks" t ON t.id=r.task_id AND t.account_id=r.account_id
           JOIN public."ramesh-messages" m ON m.id=o.outbound_message_id AND m.account_id=o.account_id
           WHERE o.outbound_message_id=$1 AND o.account_id=$2 AND o.id=$3 AND o.reminder_id=$4
           AND o.schedule_version=$5 AND o.dispatch_generation=$6 AND o.state='queued'
           AND o.not_after>clock_timestamp() AND r.version=o.schedule_version AND r.state='scheduled'
           AND r.owner_employee_id=$7 AND o.recipient_employee_id=$7
           AND r.recipient_phone_e164=$8 AND o.recipient_phone_e164=$8
           AND m.chat_id=o.recipient_chat_id AND r.recipient_chat_id=o.recipient_chat_id
           AND (r.task_id IS NULL OR (t.state='open' AND t.owner_employee_id=r.owner_employee_id))
           AND NOT ${this.pendingHuman('m')}
           FOR UPDATE OF o,r`,
          [
            job.id,
            this.accountId,
            ref.occurrenceId,
            ref.reminderId,
            ref.scheduleVersion,
            ref.dispatchGeneration,
            actor.employeeId,
            actor.phoneE164,
          ],
        );
        if (!valid.rowCount) {
          const owned = await this.owned(db, job);
          if (owned?.state === 'READY_TO_SEND')
            await this.finish(db, job, 'EXPIRED', 'reminder_no_longer_eligible');
          return false;
        }
        reminderAuthorized = true;
      }
      const result = await db.query(
        `UPDATE public."ramesh-messages" m SET state='SENDING',updated_at=clock_timestamp()
        FROM public."ramesh-outbound-queue" j WHERE m.id=$1 AND m.account_id=$2 AND m.state='READY_TO_SEND'
        AND j.message_id=m.id AND j.state='LEASED' AND j.lease_token=$3
        AND j.lease_until>clock_timestamp() AND m.expires_at>clock_timestamp()
        AND (m.origin<>'reminder' OR $4::boolean) RETURNING m.id`,
        [job.id, this.accountId, job.token, reminderAuthorized],
      );
      return result.rowCount === 1;
    });
  }

  /** Replace withheld business output before any send; retries/history see only the notice. */
  async replaceWithDeliveryNotice(job: MessageJob, replyPayload: string): Promise<boolean> {
    if (job.direction !== 'outbound') return false;
    return this.transaction(async (db) => {
      const row = await this.owned(db, job);
      if (!row || row.state !== 'READY_TO_SEND') return false;
      const changed = await db.query(
        `UPDATE public."ramesh-messages" SET reply_encrypted=$3,reply_kind='conversation',
         business_evidence_encrypted=NULL,reason='business_delivery_check_failed',updated_at=clock_timestamp()
         WHERE id=$1 AND account_id=$2 AND reply_kind='business' AND origin='whatsapp'
         AND expires_at>clock_timestamp()
         AND NOT EXISTS (SELECT 1 FROM public."ramesh-assistant-commands" c
           WHERE c.account_id=$2 AND c.run_id=$1 AND c.kind='mutation') RETURNING id`,
        [job.id, this.accountId, replyPayload],
      );
      if (!changed.rowCount) return false;
      await db.query(
        `UPDATE public."ramesh-outbound-queue" SET payload_encrypted=$3,updated_at=clock_timestamp()
         WHERE message_id=$1 AND account_id=$2`,
        [job.id, this.accountId, replyPayload],
      );
      await db.query(
        `UPDATE public."ramesh-agent-runs" SET state='failed',finalized_at=NULL,updated_at=clock_timestamp()
         WHERE id=$1 AND account_id=$2`,
        [job.id, this.accountId],
      );
      return true;
    });
  }

  private async owned(db: PoolClient, job: MessageJob): Promise<OwnedRow | undefined> {
    return (
      await db.query<OwnedRow>(
        `SELECT m.id,m.state,j.attempts,j.max_attempts FROM ${queueTable(job.direction)} j
      JOIN public."ramesh-messages" m ON m.id=j.message_id WHERE j.message_id=$1 AND j.account_id=$2
      AND j.state='LEASED' AND j.lease_token=$3 AND j.lease_until>clock_timestamp() FOR UPDATE OF j,m`,
        [job.id, this.accountId, job.token],
      )
    ).rows[0];
  }

  async complete(
    job: MessageJob,
    state: TerminalState,
    reason: string | null = null,
  ): Promise<boolean> {
    return this.transaction(async (db) => {
      const row = await this.owned(db, job);
      if (!row || (state === 'SENT' && (job.direction !== 'outbound' || row.state !== 'SENDING')))
        return false;
      await this.finish(db, job, state, reason);
      return true;
    });
  }

  /** Caller must know it has NOT invoked the WhatsApp send callback. */
  async releaseUnsent(job: MessageJob, paused = false): Promise<void> {
    await this.transaction(async (db) => {
      const row = await this.owned(db, job);
      if (!row) return;
      if (!paused && row.attempts >= row.max_attempts)
        await this.finish(db, job, 'FAILED', 'attempts_exhausted');
      else {
        if (paused)
          await db.query(
            `UPDATE ${queueTable(job.direction)} SET attempts=greatest(0,attempts-1) WHERE message_id=$1`,
            [job.id],
          );
        await this.requeue(
          db,
          job,
          paused ? 'connection_paused' : 'processing_retry',
          paused ? 0 : Math.min(30000, 1000 * 2 ** row.attempts),
        );
      }
    });
  }

  async importLegacy(
    rows: Array<{
      chatId: string;
      messageId: string;
      status: string;
      createdAt: Date;
      repliedAt: Date | null;
    }>,
  ): Promise<void> {
    // Metadata only; importing old claims must never create new reply jobs.
    for (let offset = 0; offset < rows.length; offset += 100)
      await this.transaction(async (db) => {
        for (const row of rows.slice(offset, offset + 100))
          await db.query(
            `INSERT INTO public."ramesh-messages"
        (id,account_id,chat_id,whatsapp_message_id,sent_at,expires_at,state,reason,created_at,finished_at)
        VALUES ($1,$2,$3,$4,$5,$5,$6,'legacy_claim',$5,$7) ON CONFLICT (account_id,chat_id,whatsapp_message_id) DO NOTHING`,
            [
              randomUUID(),
              this.accountId,
              row.chatId,
              row.messageId,
              row.createdAt,
              row.status === 'SENT' ? 'SENT' : 'UNCERTAIN',
              row.repliedAt ?? row.createdAt,
            ],
          );
      });
  }

  async clean(): Promise<void> {
    await this.transaction(async (db) => {
      await this.recover(db);
      await db.query(
        `DELETE FROM public."ramesh-messages" WHERE account_id=$1
        AND finished_at < clock_timestamp()-interval '30 days' AND state IN ('OBSERVED','SENT','EXPIRED','FAILED','UNCERTAIN')
        AND NOT EXISTS (SELECT 1 FROM public."ramesh-reminder-occurrences" o
          WHERE o.outbound_message_id=public."ramesh-messages".id
          AND o.state IN ('pending','preparing','waiting_source','queued'))`,
        [this.accountId],
      );
    });
  }
}
