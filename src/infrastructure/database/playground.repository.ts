/** Physically separate capture queues. No production queue names are used for writes. */
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  batchDeadline,
  combinedTurn,
  type DebouncePolicy,
} from '../../modules/messaging/debounce.js';
import { authCipher } from './auth-store.js';
import type { AgentTrace, ChatMessage } from '../../modules/assistant/assistant.types.js';
import type { VoiceReplyReference } from '../../modules/media/voice-reply.js';
import {
  MAX_HISTORY_MESSAGES,
  MAX_HISTORY_CHARACTERS,
  PRIVATE_HISTORY_REPLY,
} from '../../modules/assistant/conversation-memory.js';

export interface CaptureInput {
  id: string;
  conversation: string;
  sender: 'me' | 'teammate';
  group: boolean;
  text: string;
  forwarded?: boolean;
  mediaIds?: string[];
}
export interface CaptureJob extends CaptureInput {
  token: string;
  createdAt: Date;
  memberIds?: string[];
}
export interface CapturedReply {
  text: string;
  trace: AgentTrace;
  businessEvidence?: unknown;
  voice?: VoiceReplyReference;
}
export class PlaygroundRepository {
  private readonly cipher;
  constructor(
    private readonly pool: Pool,
    readonly namespace: string,
    readonly employeeId: number,
    key: string,
    private readonly debounce?: DebouncePolicy,
  ) {
    this.cipher = authCipher(key);
  }
  async health() {
    const role = (
      await this.pool
        .query(`SELECT current_user AS name,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication
      FROM pg_roles WHERE rolname=current_user`)
    ).rows[0];
    if (
      role?.name !== 'ramesh_playground' ||
      Object.entries(role).some(([key, value]) => key !== 'name' && value)
    )
      throw new Error('PLAYGROUND_DEDICATED_LOGIN_REQUIRED');
    if (
      (await this.pool.query('SELECT 1 FROM pg_auth_members WHERE member=current_user::regrole'))
        .rowCount
    )
      throw new Error('PLAYGROUND_ROLE_MEMBERSHIP_FORBIDDEN');
    const exposed = await this.pool
      .query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','v') AND (
        (c.relname LIKE 'ramesh-%' AND c.relname NOT LIKE 'ramesh-test-%' AND (has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE') OR has_any_column_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE')))
        OR (c.relname LIKE 'ramesh-test-%' AND (has_table_privilege('ramesh_worker',c.oid,'SELECT,INSERT,UPDATE,DELETE') OR has_any_column_privilege('ramesh_worker',c.oid,'SELECT,INSERT,UPDATE')))
      )`);
    if (exposed.rowCount) throw new Error('PLAYGROUND_QUEUE_ISOLATION_FAILED');
    if (
      !(
        await this.pool.query(
          'SELECT 1 FROM public."ramesh-test-schema-migrations" WHERE version=$1',
          ['202610030005'],
        )
      ).rowCount
    )
      throw new Error('PLAYGROUND_SCHEMA_REQUIRED');
    const roster = (
      await this.pool
        .query(`SELECT bool_and(has_column_privilege(current_user,'public."VerifiedNumber"',name,'SELECT')) AS readable,
      (has_table_privilege(current_user,'public."VerifiedNumber"','INSERT,UPDATE,DELETE') OR has_any_column_privilege(current_user,'public."VerifiedNumber"','INSERT,UPDATE')) AS writable
      FROM unnest(ARRAY['id','phone_number','email','is_active']) columns(name)`)
    ).rows[0];
    if (!roster?.readable || roster.writable)
      throw new Error('PLAYGROUND_ROSTER_PRIVILEGES_INVALID');
  }
  private async tx<T>(work: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const result = await work(db);
      await db.query('COMMIT');
      return result;
    } catch (error) {
      await db.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      db.release();
    }
  }
  async enqueue(input: CaptureInput) {
    const hash = createHash('sha256')
      .update(
        JSON.stringify([
          this.namespace,
          this.employeeId,
          input.conversation,
          input.sender,
          input.group,
          input.text,
          input.mediaIds ?? [],
          !!input.forwarded,
        ]),
      )
      .digest('hex');
    await this.tx(async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `capture:${this.namespace}:${this.employeeId}:${input.conversation}:${input.sender}:${input.group}`,
      ]);
      const prior = (
        await db.query(
          `SELECT request_hash FROM public."ramesh-test-inbound-queue" WHERE id=$1 AND namespace=$2 AND employee_id=$3`,
          [input.id, this.namespace, this.employeeId],
        )
      ).rows[0];
      if (prior) {
        if (prior.request_hash !== hash) throw new Error('PLAYGROUND_REQUEST_CONFLICT');
        return;
      }
      const parent = this.debounce
        ? (
            await db.query(
              `SELECT id,created_at FROM public."ramesh-test-inbound-queue" WHERE namespace=$1 AND employee_id=$2 AND conversation=$3 AND sender=$4 AND audience=$5 AND batch_parent IS NULL AND NOT batch_closed AND state='QUEUED'
        AND available_at>clock_timestamp() AND created_at+$6*interval '1 millisecond'>clock_timestamp() AND batch_count<8 AND batch_chars+$7<=24000
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
              [
                this.namespace,
                this.employeeId,
                input.conversation,
                input.sender,
                input.group ? 'group' : 'dm',
                this.debounce.maxMs,
                input.text.length,
              ],
            )
          ).rows[0]
        : undefined;
      const at = this.debounce
        ? new Date(
            batchDeadline(
              parent?.created_at.getTime() ?? Date.now(),
              Date.now(),
              { media: !!input.mediaIds?.length, forwarded: input.forwarded },
              this.debounce,
            ),
          )
        : new Date();
      await db.query(
        `INSERT INTO public."ramesh-test-inbound-queue" (id,namespace,employee_id,conversation,sender,audience,input_encrypted,request_hash,batch_parent,available_at,batch_chars,media_ids,forwarded) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          input.id,
          this.namespace,
          this.employeeId,
          input.conversation,
          input.sender,
          input.group ? 'group' : 'dm',
          this.cipher.seal('test-input', input.id, input.text),
          hash,
          parent?.id ?? null,
          at,
          input.text.length,
          input.mediaIds ?? [],
          !!input.forwarded,
        ],
      );
      if (parent)
        await db.query(
          `UPDATE public."ramesh-test-inbound-queue" SET available_at=$2,batch_count=batch_count+1,batch_chars=batch_chars+$3 WHERE id=$1`,
          [parent.id, at, input.text.length],
        );
    });
  }
  async batch(id: string): Promise<{ id: string; availableAt: Date }> {
    const r = (
      await this.pool.query(
        `SELECT p.id,p.available_at FROM public."ramesh-test-inbound-queue" i JOIN public."ramesh-test-inbound-queue" p ON p.id=coalesce(i.batch_parent,i.id) WHERE i.id=$1 AND i.namespace=$2 AND i.employee_id=$3`,
        [id, this.namespace, this.employeeId],
      )
    ).rows[0];
    if (!r) throw new Error('CAPTURE_INPUT_MISSING');
    return { id: r.id, availableAt: r.available_at };
  }
  async claim(id: string, leaseMs: number): Promise<CaptureJob | null> {
    const token = randomUUID();
    const row = (
      await this.pool.query(
        `UPDATE public."ramesh-test-inbound-queue" SET state='PROCESSING',batch_closed=true,
      lease_token=$4,lease_until=clock_timestamp()+$5*interval '1 millisecond',attempts=attempts+1
      WHERE id=$1 AND namespace=$2 AND employee_id=$3 AND expires_at>clock_timestamp() AND attempts<3
      AND batch_parent IS NULL AND available_at<=clock_timestamp() AND (state='QUEUED' OR (state='PROCESSING' AND lease_until<clock_timestamp())) RETURNING *`,
        [id, this.namespace, this.employeeId, token, leaseMs],
      )
    ).rows[0];
    if (!row) return null;
    const text = this.cipher.open('test-input', id, row.input_encrypted);
    if (typeof text !== 'string') throw new Error('INVALID_CAPTURE_INPUT');
    const children = (
      await this.pool.query(
        `SELECT id,input_encrypted,media_ids,forwarded FROM public."ramesh-test-inbound-queue" WHERE batch_parent=$1 AND namespace=$2 AND employee_id=$3 ORDER BY created_at,id`,
        [id, this.namespace, this.employeeId],
      )
    ).rows;
    const parts = [
      { id, text, forwarded: row.forwarded, mediaIds: row.media_ids },
      ...children.map((c) => ({
        id: c.id,
        text: this.cipher.open('test-input', c.id, c.input_encrypted) as string,
        forwarded: c.forwarded,
        mediaIds: c.media_ids,
      })),
    ];
    return {
      id,
      token,
      text: combinedTurn(parts),
      mediaIds: parts.flatMap((p) => p.mediaIds ?? []),
      memberIds: parts.map((p) => p.id),
      conversation: row.conversation,
      sender: row.sender,
      group: row.audience === 'group',
      createdAt: row.created_at,
    };
  }
  async record(
    job: CaptureJob,
    kind: 'tool_started' | 'tool_succeeded' | 'tool_failed',
    value: unknown,
  ) {
    const inserted = await this.pool.query(
      `WITH owned AS (
      SELECT id,attempts FROM public."ramesh-test-inbound-queue" WHERE id=$1 AND namespace=$2 AND employee_id=$3
      AND lease_token=$4 AND lease_until>clock_timestamp() AND state='PROCESSING' FOR UPDATE)
      INSERT INTO public."ramesh-test-agent-events" (message_id,attempt,kind,payload_encrypted)
      SELECT id,attempts,$5,$6 FROM owned RETURNING id`,
      [
        job.id,
        this.namespace,
        this.employeeId,
        job.token,
        kind,
        this.cipher.seal(`test-event:${kind}`, job.id, value),
      ],
    );
    if (!inserted.rowCount) throw new Error('CAPTURE_LEASE_EXPIRED');
  }
  async finalize(job: CaptureJob, reply: CapturedReply) {
    await this.tx(async (db) => {
      const updated = await db.query(
        `UPDATE public."ramesh-test-inbound-queue" SET state='COMPLETED',lease_token=NULL,lease_until=NULL
        WHERE id=$1 AND namespace=$2 AND employee_id=$3 AND state='PROCESSING' AND lease_token=$4
        AND lease_until>clock_timestamp() AND expires_at>clock_timestamp() RETURNING id`,
        [job.id, this.namespace, this.employeeId, job.token],
      );
      if (!updated.rowCount) throw new Error('CAPTURE_LEASE_EXPIRED');
      await db.query(
        `UPDATE public."ramesh-test-inbound-queue" SET state='COMPLETED' WHERE batch_parent=$1 AND namespace=$2 AND employee_id=$3`,
        [job.id, this.namespace, this.employeeId],
      );
      await db.query(
        `INSERT INTO public."ramesh-test-outbound-queue" (message_id,state,reply_kind,output_encrypted)
        VALUES ($1,'CAPTURED',$2,$3)`,
        [
          job.id,
          reply.businessEvidence === undefined ? 'conversation' : 'business',
          this.cipher.seal('test-output', job.id, reply),
        ],
      );
    });
  }
  async release(job: CaptureJob, cancelled: boolean) {
    await this.pool.query(
      `UPDATE public."ramesh-test-inbound-queue" SET state=CASE WHEN attempts>=3 OR expires_at<=clock_timestamp() THEN 'FAILED' ELSE 'QUEUED' END,
      attempts=CASE WHEN $5 THEN greatest(0,attempts-1) ELSE attempts END,lease_token=NULL,lease_until=NULL
      WHERE id=$1 AND namespace=$2 AND employee_id=$3 AND state='PROCESSING' AND lease_token=$4`,
      [job.id, this.namespace, this.employeeId, job.token, cancelled],
    );
  }
  async output(
    id: string,
  ): Promise<{ reply: CapturedReply; state: 'CAPTURED' | 'SUPPRESSED' } | null> {
    const row = (
      await this.pool.query(
        `SELECT o.* FROM public."ramesh-test-outbound-queue" o JOIN public."ramesh-test-inbound-queue" i ON i.id=o.message_id
      WHERE i.id=$1 AND i.namespace=$2 AND i.employee_id=$3`,
        [id, this.namespace, this.employeeId],
      )
    ).rows[0];
    if (!row) return null;
    const reply = this.cipher.open('test-output', id, row.output_encrypted) as CapturedReply;
    if (typeof reply?.text !== 'string' || !reply.trace) throw new Error('INVALID_CAPTURE_OUTPUT');
    return { reply, state: row.state };
  }
  async suppress(id: string) {
    await this.pool.query(
      `UPDATE public."ramesh-test-outbound-queue" o SET state='SUPPRESSED' FROM public."ramesh-test-inbound-queue" i
      WHERE o.message_id=i.id AND i.id=$1 AND i.namespace=$2 AND i.employee_id=$3`,
      [id, this.namespace, this.employeeId],
    );
  }
  async history(job: CaptureJob): Promise<ChatMessage[]> {
    const rows = (
      await this.pool.query(
        `SELECT i.id,i.input_encrypted,o.state='CAPTURED' AND o.reply_kind='business' AS private_reply,
      CASE WHEN o.state='CAPTURED' THEN o.output_encrypted ELSE NULL END AS output_encrypted
      FROM public."ramesh-test-inbound-queue" i LEFT JOIN public."ramesh-test-outbound-queue" o ON o.message_id=i.id
      WHERE i.namespace=$1 AND i.employee_id=$2 AND i.conversation=$3 AND i.sender=$4 AND i.audience=$5 AND i.state='COMPLETED' AND i.batch_parent IS NULL
      AND (i.created_at,i.id)<(SELECT created_at,id FROM public."ramesh-test-inbound-queue" WHERE id=$6)
      ORDER BY i.created_at DESC,i.id DESC LIMIT 40`,
        [
          this.namespace,
          this.employeeId,
          job.conversation,
          job.sender,
          job.group ? 'group' : 'dm',
          job.id,
        ],
      )
    ).rows;
    const history: ChatMessage[] = [];
    let remaining = MAX_HISTORY_CHARACTERS;
    for (const row of rows) {
      let text = this.cipher.open('test-input', row.id, row.input_encrypted);
      const children = (
        await this.pool.query(
          `SELECT id,input_encrypted,forwarded FROM public."ramesh-test-inbound-queue" WHERE batch_parent=$1 AND namespace=$2 AND employee_id=$3 ORDER BY created_at,id`,
          [row.id, this.namespace, this.employeeId],
        )
      ).rows;
      if (children.length && typeof text === 'string')
        text = combinedTurn([
          { id: row.id, text },
          ...children.map((c) => ({
            id: c.id,
            text: this.cipher.open('test-input', c.id, c.input_encrypted) as string,
            forwarded: c.forwarded,
          })),
        ]);
      if (typeof text !== 'string') throw new Error('INVALID_CAPTURE_HISTORY');
      const output = row.output_encrypted
        ? (this.cipher.open('test-output', row.id, row.output_encrypted) as CapturedReply)
        : undefined;
      const reply = row.private_reply ? PRIVATE_HISTORY_REPLY : output?.text;
      const size = text.length + (reply?.length ?? 0);
      if (size > remaining) break;
      remaining -= size;
      history.unshift(
        { role: 'user', content: text },
        ...(reply
          ? [
              {
                role: 'assistant' as const,
                content: reply,
                ...(row.private_reply && output?.businessEvidence !== undefined && !job.group
                  ? { protectedReply: { text: output.text, receipt: output.businessEvidence } }
                  : {}),
              },
            ]
          : []),
      );
    }
    return history.slice(-MAX_HISTORY_MESSAGES);
  }
  async clear(conversation: string, sender: string, group: boolean) {
    await this.pool.query(
      `DELETE FROM public."ramesh-test-inbound-queue" WHERE namespace=$1 AND employee_id=$2 AND conversation=$3 AND sender=$4 AND audience=$5`,
      [this.namespace, this.employeeId, conversation, sender, group ? 'group' : 'dm'],
    );
  }
  async clean() {
    await this.pool.query(
      `DELETE FROM public."ramesh-test-inbound-queue" WHERE namespace=$1 AND employee_id=$2 AND created_at<clock_timestamp()-interval '24 hours'`,
      [this.namespace, this.employeeId],
    );
  }
}
