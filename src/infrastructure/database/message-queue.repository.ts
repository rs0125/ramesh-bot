/** PostgreSQL state + queue transactions. No connection is held during pacing or WhatsApp sends. */
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { GreetingCandidate } from '../../modules/greetings/greeting.types.js';

export type TerminalState = 'SENT' | 'EXPIRED' | 'FAILED' | 'UNCERTAIN';
export interface MessageJob {
  id: string;
  token: string;
  payload: string;
  attempts: number;
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
  ) {}

  async health(): Promise<void> {
    const result = await this.pool.query(`SELECT current_user AS role, version
      FROM public."ramesh-schema-migrations" WHERE version='202610010001'`);
    if (result.rows[0]?.role !== 'ramesh_worker')
      throw new Error('Message queue schema or runtime role is not ready');
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
  ): Promise<'queued' | 'duplicate' | 'full'> {
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
      const count = await db.query(
        `SELECT count(*)::int AS count FROM public."ramesh-message-jobs"
        WHERE account_id=$1 AND state IN ('READY','LEASED')`,
        [this.accountId],
      );
      if (count.rows[0].count >= capacity) return 'full';
      await db.query(
        `INSERT INTO public."ramesh-messages"
        (id,account_id,chat_id,whatsapp_message_id,sent_at,expires_at,state,payload_encrypted)
        VALUES ($1,$2,$3,$4,$5,$6,'QUEUED',$7)`,
        [
          id,
          this.accountId,
          message.chatId,
          message.messageId,
          new Date(message.sentAtMs),
          new Date(message.sentAtMs + maxAgeMs),
          payload,
        ],
      );
      await db.query(
        `INSERT INTO public."ramesh-message-jobs" (message_id,account_id) VALUES ($1,$2)`,
        [id, this.accountId],
      );
      return 'queued';
    });
  }

  private async finish(
    db: PoolClient,
    id: string,
    state: TerminalState,
    reason: string | null,
  ): Promise<void> {
    await db.query(
      `UPDATE public."ramesh-message-jobs" SET state=$3,lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp()
      WHERE message_id=$1 AND account_id=$2`,
      [id, this.accountId, ['SENT', 'EXPIRED'].includes(state) ? 'DONE' : 'DEAD'],
    );
    await db.query(
      `UPDATE public."ramesh-messages" SET state=$3,reason=$4,payload_encrypted=NULL,
      finished_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 AND account_id=$2`,
      [id, this.accountId, state, reason],
    );
  }

  private async requeue(
    db: PoolClient,
    id: string,
    reason: string,
    delayMs: number,
  ): Promise<void> {
    await db.query(
      `UPDATE public."ramesh-message-jobs" SET state='READY',lease_token=NULL,lease_until=NULL,
      available_at=clock_timestamp()+$3*interval '1 millisecond',updated_at=clock_timestamp()
      WHERE message_id=$1 AND account_id=$2`,
      [id, this.accountId, delayMs],
    );
    await db.query(
      `UPDATE public."ramesh-messages" SET state='QUEUED',reason=$3,updated_at=clock_timestamp()
      WHERE id=$1 AND account_id=$2`,
      [id, this.accountId, reason],
    );
  }

  private async recover(db: PoolClient): Promise<void> {
    // Batch recovery avoids one network round trip per expired message after a long pause.
    await db.query(
      `WITH expired AS (
      SELECT m.id,CASE WHEN m.state='SENDING' THEN 'UNCERTAIN'
        WHEN j.attempts>=j.max_attempts THEN 'FAILED' ELSE 'QUEUED' END AS next_state
      FROM public."ramesh-message-jobs" j JOIN public."ramesh-messages" m ON m.id=j.message_id
      WHERE j.account_id=$1 AND j.state='LEASED' AND j.lease_until<=clock_timestamp() FOR UPDATE OF j,m
    ), changed AS (
      UPDATE public."ramesh-messages" m SET state=e.next_state,
        reason=CASE e.next_state WHEN 'UNCERTAIN' THEN 'send_interrupted' WHEN 'FAILED' THEN 'attempts_exhausted' ELSE 'lease_expired' END,
        payload_encrypted=CASE WHEN e.next_state='QUEUED' THEN m.payload_encrypted ELSE NULL END,
        finished_at=CASE WHEN e.next_state='QUEUED' THEN NULL ELSE clock_timestamp() END,
        updated_at=clock_timestamp() FROM expired e WHERE m.id=e.id RETURNING m.id,m.state
    ) UPDATE public."ramesh-message-jobs" j SET state=CASE WHEN c.state='QUEUED' THEN 'READY' ELSE 'DEAD' END,
      lease_token=NULL,lease_until=NULL,available_at=clock_timestamp(),updated_at=clock_timestamp()
      FROM changed c WHERE j.message_id=c.id`,
      [this.accountId],
    );
    await db.query(
      `WITH stale AS (
      UPDATE public."ramesh-messages" m SET state='EXPIRED',reason='message_too_old',payload_encrypted=NULL,
        finished_at=clock_timestamp(),updated_at=clock_timestamp()
      FROM public."ramesh-message-jobs" j WHERE j.message_id=m.id AND m.account_id=$1
        AND j.state='READY' AND m.expires_at<=clock_timestamp() RETURNING m.id
    ) UPDATE public."ramesh-message-jobs" j SET state='DONE',updated_at=clock_timestamp()
      FROM stale s WHERE j.message_id=s.id`,
      [this.accountId],
    );
  }

  async claim(leaseMs: number): Promise<MessageJob | null> {
    return this.transaction(async (db) => {
      await this.recover(db);
      if (
        (
          await db.query(
            `SELECT 1 FROM public."ramesh-message-jobs" WHERE account_id=$1 AND state='LEASED'`,
            [this.accountId],
          )
        ).rowCount
      )
        return null;
      const next = await db.query<{ id: string; payload: string; attempts: number }>(
        `SELECT m.id,m.payload_encrypted AS payload,j.attempts
        FROM public."ramesh-message-jobs" j JOIN public."ramesh-messages" m ON m.id=j.message_id
        WHERE j.account_id=$1 AND j.state='READY' AND j.available_at<=clock_timestamp()
        ORDER BY j.created_at,j.message_id LIMIT 1 FOR UPDATE OF j SKIP LOCKED`,
        [this.accountId],
      );
      const row = next.rows[0];
      if (!row) return null;
      const token = randomUUID();
      await db.query(
        `UPDATE public."ramesh-message-jobs" SET state='LEASED',lease_token=$2,
        lease_until=clock_timestamp()+$3*interval '1 millisecond',attempts=attempts+1,updated_at=clock_timestamp()
        WHERE message_id=$1`,
        [row.id, token, leaseMs],
      );
      await db.query(
        `UPDATE public."ramesh-messages" SET state='PROCESSING',reason=NULL,updated_at=clock_timestamp() WHERE id=$1`,
        [row.id],
      );
      return { ...row, token, attempts: row.attempts + 1 };
    });
  }

  async beginSend(job: MessageJob): Promise<boolean> {
    return this.transaction(async (db) => {
      const result = await db.query(
        `UPDATE public."ramesh-messages" m SET state='SENDING',updated_at=clock_timestamp()
        FROM public."ramesh-message-jobs" j WHERE m.id=$1 AND m.account_id=$2 AND m.state='PROCESSING'
        AND j.message_id=m.id AND j.state='LEASED' AND j.lease_token=$3
        AND j.lease_until>clock_timestamp() AND m.expires_at>clock_timestamp() RETURNING m.id`,
        [job.id, this.accountId, job.token],
      );
      return result.rowCount === 1;
    });
  }

  private async owned(db: PoolClient, job: MessageJob): Promise<OwnedRow | undefined> {
    return (
      await db.query<OwnedRow>(
        `SELECT m.id,m.state,j.attempts,j.max_attempts FROM public."ramesh-message-jobs" j
      JOIN public."ramesh-messages" m ON m.id=j.message_id WHERE j.message_id=$1 AND j.account_id=$2
      AND j.state='LEASED' AND j.lease_token=$3 FOR UPDATE OF j,m`,
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
      if (!row || (state === 'SENT' && row.state !== 'SENDING')) return false;
      await this.finish(db, job.id, state, reason);
      return true;
    });
  }

  /** Caller must know it has NOT invoked the WhatsApp send callback. */
  async releaseUnsent(job: MessageJob, paused = false): Promise<void> {
    await this.transaction(async (db) => {
      const row = await this.owned(db, job);
      if (!row) return;
      if (!paused && row.attempts >= row.max_attempts)
        await this.finish(db, job.id, 'FAILED', 'attempts_exhausted');
      else {
        if (paused)
          await db.query(
            `UPDATE public."ramesh-message-jobs" SET attempts=greatest(0,attempts-1) WHERE message_id=$1`,
            [job.id],
          );
        await this.requeue(
          db,
          job.id,
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
        AND finished_at < clock_timestamp()-interval '30 days' AND state IN ('SENT','EXPIRED','FAILED','UNCERTAIN')`,
        [this.accountId],
      );
    });
  }
}
