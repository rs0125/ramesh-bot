/** Owner-scoped personal intent, command receipts and occurrence leases in the message database. */
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { authCipher } from './auth-store.js';
import { appendWriteAudit } from './write.repository.js';
import {
  PERSONAL_LIST_MAX_CHARACTERS,
  renderList,
} from '../../modules/scheduling/personal-presentation.js';
import {
  nextOccurrence,
  validateSchedule,
  validateTaskDeadline,
} from '../../modules/scheduling/schedule-time.js';
import {
  SchedulingError,
  type PersonalActor,
  type PersonalCommandContext,
  type PersonalCommandReceipt,
  type PersonalOperation,
  type PersonalRecord,
  type PersonalListResult,
  type VersionedTarget,
  type ScheduleSpec,
  type DueReminder,
  type ReminderDeliveryRef,
  type PersonalCommandMember,
  type PersonalRecallResult,
} from '../../modules/scheduling/scheduling.types.js';

type Row = Record<string, any>;
const activeOccurrences = ['pending', 'preparing', 'waiting_source', 'queued'];
const uuid = (s: string) => /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(s);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export class PersonalRepository {
  private readonly cipher;
  constructor(
    private readonly pool: Pool,
    readonly accountId: string,
    key: string,
  ) {
    this.cipher = authCipher(key);
  }
  private actor(actor: PersonalActor) {
    if (
      !Number.isSafeInteger(actor.employeeId) ||
      actor.employeeId <= 0 ||
      !/^\+[1-9]\d{7,14}$/.test(actor.phoneE164) ||
      !(/^[1-9]\d{7,14}@s\.whatsapp\.net$/.test(actor.chatId) || /^[\w.-]+@lid$/.test(actor.chatId))
    )
      throw new SchedulingError('PERSONAL_ACCESS_DENIED');
  }
  private async tx<T>(work: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    let destroy = false;
    try {
      await db.query('BEGIN');
      await db.query("SET LOCAL lock_timeout='1000ms'");
      await db.query("SET LOCAL idle_in_transaction_session_timeout='6000ms'");
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `ramesh:queue:${this.accountId}`,
      ]);
      const value = await work(db);
      await db.query('COMMIT');
      return value;
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
  private async fence(db: PoolClient, ctx: PersonalCommandContext) {
    this.actor(ctx);
    if (!uuid(ctx.runId) || !uuid(ctx.leaseToken) || !Number.isFinite(ctx.requestTimeMs))
      throw new SchedulingError('PERSONAL_LEASE_LOST');
    const owned = await db.query(
      `SELECT m.id FROM public."ramesh-messages" m JOIN public."ramesh-inbound-queue" q ON q.message_id=m.id
      WHERE m.id=$1 AND m.account_id=$2 AND m.chat_id=$3 AND m.origin='whatsapp' AND m.state='PROCESSING'
      AND m.expires_at>clock_timestamp() AND q.state='LEASED' AND q.lease_token=$4 AND q.lease_until>clock_timestamp()`,
      [ctx.runId, this.accountId, ctx.chatId, ctx.leaseToken],
    );
    if (!owned.rowCount) throw new SchedulingError('PERSONAL_LEASE_LOST');
  }
  private record(kind: 'task' | 'reminder', row: Row): PersonalRecord {
    const text = this.cipher.open(
      `personal-${kind}:${row.owner_employee_id}`,
      row.id,
      row.text_encrypted,
    );
    if (typeof text !== 'string') throw new SchedulingError('PERSONAL_STORAGE_INVALID');
    return {
      kind,
      id: row.id,
      text,
      state: row.state,
      version: row.version,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      ...(row.deadline ? { deadline: row.deadline } : {}),
      ...(row.schedule
        ? { schedule: row.schedule, nextDueAt: row.next_due_at?.toISOString() ?? null }
        : {}),
      ...(row.task_id ? { taskId: row.task_id } : {}),
      ...(row.last_outcome ? { lastOutcome: row.last_outcome } : {}),
      ...(row.occurrence_id
        ? {
            occurrenceId: row.occurrence_id,
            occurrenceState: row.occurrence_state,
            occurrenceDueAt: row.occurrence_due_at.toISOString(),
          }
        : {}),
    };
  }
  private receipt(row: Row): PersonalCommandReceipt {
    return this.cipher.open(
      `personal-result:${row.owner_employee_id}`,
      row.id,
      row.result_encrypted,
    ) as PersonalCommandReceipt;
  }
  async getReceipt(ctx: PersonalCommandContext): Promise<PersonalCommandReceipt | null> {
    return this.tx(async (db) => {
      await this.fence(db, ctx);
      const row = (
        await db.query(
          `SELECT * FROM public."ramesh-assistant-commands" WHERE account_id=$1 AND run_id=$2 AND kind='mutation'`,
          [this.accountId, ctx.runId],
        )
      ).rows[0];
      if (!row) return null;
      if (row.owner_employee_id !== ctx.employeeId)
        throw new SchedulingError('PERSONAL_ACCESS_DENIED');
      return { ...this.receipt(row), replayed: true };
    });
  }
  /** Application supplies admitted, non-forwarded members, never model-generated history. */
  async saveContext(ctx: PersonalCommandContext, members: PersonalCommandMember[]): Promise<void> {
    if (!members.length) return;
    if (
      members.length > 32 ||
      members.some(
        (m) =>
          !uuid(m.id) ||
          typeof m.text !== 'string' ||
          !m.text.trim() ||
          !Number.isFinite(m.receivedAtMs),
      ) ||
      Buffer.byteLength(JSON.stringify(members)) > 180000
    )
      throw new SchedulingError('PERSONAL_CONTEXT_INVALID');
    await this.tx(async (db) => {
      await this.fence(db, ctx);
      const id = randomUUID();
      await db.query(
        `INSERT INTO public."ramesh-assistant-commands"(id,account_id,owner_employee_id,run_id,kind,payload_encrypted,finished_at,expires_at)
         VALUES($1,$2,$3,$4,'context',$5,clock_timestamp(),clock_timestamp()+interval '24 hours')
         ON CONFLICT(account_id,run_id) WHERE kind='context' DO NOTHING`,
        [
          id,
          this.accountId,
          ctx.employeeId,
          ctx.runId,
          this.cipher.seal(`personal-context:${ctx.employeeId}`, id, {
            phoneE164: ctx.phoneE164,
            chatId: ctx.chatId,
            members,
          }),
        ],
      );
    });
  }
  async recall(
    actor: PersonalActor,
    kind: 'instructions' | 'task' | 'reminder',
  ): Promise<PersonalRecallResult> {
    this.actor(actor);
    if (kind === 'instructions') {
      const rows = (
        await this.pool.query(
          `SELECT c.* FROM public."ramesh-assistant-commands" c JOIN public."ramesh-messages" m ON m.id=c.run_id AND m.account_id=c.account_id
         WHERE c.account_id=$1 AND c.owner_employee_id=$2 AND c.kind='context' AND c.expires_at>clock_timestamp()
         AND c.created_at>clock_timestamp()-interval '24 hours' AND m.origin='whatsapp' AND m.chat_id=$3 AND m.state='SENT'
         ORDER BY m.finished_at DESC,c.created_at DESC LIMIT 32`,
          [this.accountId, actor.employeeId, actor.chatId],
        )
      ).rows;
      const members: Array<PersonalCommandMember & { runId: string }> = [];
      const cutoff = Date.now() - 86400000;
      let bytes = 0,
        truncated = false;
      for (const row of rows) {
        const payload = this.cipher.open(
          `personal-context:${actor.employeeId}`,
          row.id,
          row.payload_encrypted,
        ) as { phoneE164: string; chatId: string; members: PersonalCommandMember[] };
        if (payload.phoneE164 !== actor.phoneE164 || payload.chatId !== actor.chatId) continue;
        for (const member of [...payload.members].reverse()) {
          if (member.receivedAtMs < cutoff) continue;
          const recalled = { ...member, runId: row.run_id };
          const size = Buffer.byteLength(JSON.stringify(recalled));
          if (members.length >= 32 || bytes + size > 32000) {
            truncated = true;
            continue;
          }
          members.push(recalled);
          bytes += size;
        }
      }
      return { kind, members: members.reverse(), ...(truncated ? { truncated: true } : {}) };
    }
    return this.tx(async (db) => {
      const rows = (
        await db.query(
          `SELECT c.*,m.finished_at AS delivered_at FROM public."ramesh-assistant-commands" c JOIN public."ramesh-messages" m ON m.id=c.run_id AND m.account_id=c.account_id
         WHERE c.account_id=$1 AND c.owner_employee_id=$2 AND c.kind IN('mutation','selection') AND c.expires_at>clock_timestamp()
         AND (c.kind='mutation' OR c.presented) AND m.origin='whatsapp' AND m.chat_id=$3 AND m.reply_kind='business' AND m.state='SENT'
         ORDER BY m.finished_at DESC,m.id DESC,(c.kind='selection') DESC,c.created_at DESC LIMIT 50`,
          [this.accountId, actor.employeeId, actor.chatId],
        )
      ).rows;
      let selected: Row | undefined;
      let targets: VersionedTarget[] = [];
      for (const row of rows) {
        if (row.kind === 'mutation') {
          targets = this.receipt(row)
            .records.filter((r) => r.kind === kind)
            .map((r) => ({ id: r.id, expectedVersion: r.version }));
        } else {
          const payload = this.cipher.open(
            `personal-selection:${actor.employeeId}`,
            row.id,
            row.payload_encrypted,
          ) as { kind: string; records: VersionedTarget[] };
          if (payload.kind !== kind) continue;
          targets = payload.records;
        }
        // Within one delivered reply the presented list defines follow-up order. An
        // empty list is also an authoritative result, not permission to revive an older
        // selection or the mutation's affected (potentially now closed) records.
        if (row.kind === 'selection' || targets.length) {
          selected = row;
          break;
        }
      }
      if (kind === 'reminder') {
        const latest = (
          await db.query(
            `SELECT r.*,o.id AS occurrence_id,o.state AS occurrence_state,o.eligible_at AS occurrence_due_at,m.finished_at AS delivered_at
           FROM public."ramesh-reminder-occurrences" o JOIN public."ramesh-reminders" r ON r.id=o.reminder_id AND r.account_id=o.account_id
           JOIN public."ramesh-messages" m ON m.id=o.outbound_message_id AND m.account_id=o.account_id
           WHERE r.account_id=$1 AND r.owner_employee_id=$2 AND o.recipient_employee_id=$2 AND o.recipient_phone_e164=$3 AND o.recipient_chat_id=$4
           AND o.state='sent' AND m.state='SENT' AND m.chat_id=$4 AND o.schedule_version=r.version
           ORDER BY m.finished_at DESC,o.id DESC LIMIT 1`,
            [this.accountId, actor.employeeId, actor.phoneE164, actor.chatId],
          )
        ).rows[0];
        if (latest && (!selected || latest.delivered_at > selected.delivered_at))
          return { kind, records: [this.record(kind, latest)] };
      }
      const records: PersonalRecord[] = [];
      for (const target of targets.slice(0, 50))
        records.push(this.record(kind, await this.target(db, actor, kind, target.id)));
      return {
        kind,
        records,
        ...(selected?.kind === 'selection' ? { selectionId: selected.id } : {}),
      };
    });
  }
  async applyBatch(
    ctx: PersonalCommandContext,
    operations: PersonalOperation[],
    selectionIds: string[] = [],
  ): Promise<PersonalCommandReceipt> {
    this.actor(ctx);
    if (
      !operations.length ||
      operations.length > 12 ||
      Buffer.byteLength(JSON.stringify(operations)) > 24000
    )
      throw new SchedulingError('PERSONAL_BATCH_LIMIT');
    if (
      selectionIds.length > 2 ||
      selectionIds.some((id) => !uuid(id)) ||
      new Set(selectionIds).size !== selectionIds.length
    )
      throw new SchedulingError('PERSONAL_SELECTION_INVALID');
    const fingerprint = createHash('sha256').update(canonical(operations)).digest('hex');
    return this.tx(async (db) => {
      await this.fence(db, ctx);
      const old = (
        await db.query(
          `SELECT * FROM public."ramesh-assistant-commands" WHERE account_id=$1 AND run_id=$2 AND kind='mutation' FOR UPDATE`,
          [this.accountId, ctx.runId],
        )
      ).rows[0];
      if (old) {
        if (old.owner_employee_id !== ctx.employeeId)
          throw new SchedulingError('PERSONAL_ACCESS_DENIED');
        if (old.fingerprint !== fingerprint) throw new SchedulingError('PERSONAL_COMMAND_CONFLICT');
        return { ...this.receipt(old), replayed: true };
      }
      const targetIds = operations.flatMap((operation) =>
        'id' in operation ? [operation.id] : [],
      );
      const occurrenceIds = operations.flatMap((operation) =>
        'occurrenceId' in operation ? [operation.occurrenceId] : [],
      );
      const before = await this.auditSnapshot(db, ctx, targetIds, occurrenceIds);
      const id = randomUUID();
      await db.query(
        `INSERT INTO public."ramesh-assistant-commands"(id,account_id,owner_employee_id,run_id,kind,fingerprint,payload_encrypted,expires_at)
        VALUES($1,$2,$3,$4,'mutation',$5,$6,clock_timestamp()+interval '30 days')`,
        [
          id,
          this.accountId,
          ctx.employeeId,
          ctx.runId,
          fingerprint,
          this.cipher.seal(`personal-command:${ctx.employeeId}`, id, {
            operations,
            requestTimeMs: ctx.requestTimeMs,
          }),
        ],
      );
      const aliases = new Map<string, string>();
      const records: PersonalRecord[] = [];
      for (const [index, op] of operations.entries())
        records.push(await this.apply(db, ctx, op, `${ctx.runId}:${index}`, aliases));
      const lists = await this.reconcileSelections(
        db,
        ctx,
        selectionIds,
        records.filter((_, index) => operations[index]!.kind.endsWith('_create')),
      );
      const receipt: PersonalCommandReceipt = {
        commandId: id,
        runId: ctx.runId,
        records,
        ...(lists.length ? { lists } : {}),
      };
      await db.query(
        `UPDATE public."ramesh-assistant-commands" SET result_encrypted=$2,finished_at=clock_timestamp() WHERE id=$1`,
        [id, this.cipher.seal(`personal-result:${ctx.employeeId}`, id, receipt)],
      );
      const after = await this.auditSnapshot(
        db,
        ctx,
        [
          ...targetIds,
          ...records.map((record) => record.id),
          ...before.reminders.map((record) => record.id),
        ],
        [...occurrenceIds, ...before.occurrences.map((row) => row.id)],
      );
      await appendWriteAudit(db, this.cipher, this.accountId, ctx, {
        personalCommandId: id,
        sourceFamily: 'personal',
        kind: 'personal_batch_applied',
        runId: ctx.runId,
        before,
        after: { ...after, operations, receipt },
      });
      return receipt;
    });
  }
  /** Refresh exactly the requested pages after the batch, including linked cancellations.
   * The displayed versions/order and the mutation receipt commit together, so replay cannot
   * lose the list or make an ordinal resolve to a pre-mutation version.
   */
  private async reconcileSelections(
    db: PoolClient,
    ctx: PersonalCommandContext,
    ids: string[],
    created: PersonalRecord[],
  ): Promise<NonNullable<PersonalCommandReceipt['lists']>> {
    const lists: NonNullable<PersonalCommandReceipt['lists']> = [];
    for (const id of ids) {
      const selected = (
        await db.query(
          `SELECT * FROM public."ramesh-assistant-commands" WHERE id=$1 AND account_id=$2 AND owner_employee_id=$3 AND run_id=$4 AND kind='selection' AND expires_at>clock_timestamp() FOR UPDATE`,
          [id, this.accountId, ctx.employeeId, ctx.runId],
        )
      ).rows[0];
      if (!selected) throw new SchedulingError('PERSONAL_SELECTION_INVALID');
      const payload = this.cipher.open(
        `personal-selection:${ctx.employeeId}`,
        id,
        selected.payload_encrypted,
      ) as {
        kind: 'task' | 'reminder';
        records: VersionedTarget[];
        state: string;
        nextCursor: string | null;
      };
      if (
        !['task', 'reminder'].includes(payload.kind) ||
        !Array.isArray(payload.records) ||
        payload.records.length > 50 ||
        payload.records.some((record) => !uuid(record.id))
      )
        throw new SchedulingError('PERSONAL_STORAGE_INVALID');
      // A completed page can include this batch's new records at its end. For an incomplete
      // page, keep new records behind its saved cursor rather than jumping over unseen rows.
      const recordIds = [
        ...new Set([
          ...payload.records.map((record) => record.id),
          ...(!payload.nextCursor
            ? created.filter((record) => record.kind === payload.kind).map((record) => record.id)
            : []),
        ]),
      ];
      const kind = payload.kind;
      const rows = (
        await db.query(
          `SELECT t.*,t.created_at::text AS cursor_time ${kind === 'reminder' ? ',o.id AS occurrence_id,o.state AS occurrence_state,o.eligible_at AS occurrence_due_at' : ''}
         FROM public."ramesh-${kind === 'task' ? 'tasks' : 'reminders'}" t
         ${kind === 'reminder' ? `LEFT JOIN LATERAL(SELECT id,state,eligible_at FROM public."ramesh-reminder-occurrences" WHERE account_id=t.account_id AND reminder_id=t.id AND schedule_version=t.version ORDER BY CASE WHEN state IN('pending','preparing','waiting_source','queued') THEN 0 ELSE 1 END,eligible_at DESC,dispatch_generation DESC LIMIT 1)o ON true` : ''}
         WHERE t.account_id=$1 AND t.owner_employee_id=$2 AND t.id=ANY($3::uuid[]) AND ($4='all' OR t.state=$4)
         ORDER BY t.created_at,t.id FOR UPDATE OF t`,
          [this.accountId, ctx.employeeId, recordIds, payload.state],
        )
      ).rows;
      const records: PersonalRecord[] = [];
      for (const row of rows) {
        const candidate = this.record(kind, row);
        if (
          records.length >= 50 ||
          renderList(kind, {
            records: [...records, candidate],
            selectionId: id,
            nextCursor: 'more',
          }).length > PERSONAL_LIST_MAX_CHARACTERS
        )
          break;
        records.push(candidate);
      }
      const last = rows[records.length - 1];
      const nextCursor =
        rows.length > records.length && last
          ? Buffer.from(JSON.stringify([last.cursor_time, last.id])).toString('base64url')
          : payload.nextCursor;
      await db.query(
        `UPDATE public."ramesh-assistant-commands" SET payload_encrypted=$2 WHERE id=$1`,
        [
          id,
          this.cipher.seal(`personal-selection:${ctx.employeeId}`, id, {
            ...payload,
            records: records.map((record) => ({ id: record.id, expectedVersion: record.version })),
            nextCursor,
          }),
        ],
      );
      lists.push({ kind, result: { records, selectionId: id, nextCursor } });
    }
    if (ids.length) await this.markSelections(db, ctx, ids);
    return lists;
  }
  /** Includes linked reminder cancellation and snooze occurrences, not only direct return records. */
  private async auditSnapshot(
    db: PoolClient,
    actor: PersonalActor,
    ids: string[],
    occurrenceIds: string[] = [],
  ) {
    const validIds = [...new Set(ids.filter(uuid))];
    const tasks = (
      await db.query(
        `SELECT * FROM public."ramesh-tasks" WHERE account_id=$1 AND owner_employee_id=$2 AND id=ANY($3::uuid[]) ORDER BY id`,
        [this.accountId, actor.employeeId, validIds],
      )
    ).rows;
    const reminders = (
      await db.query(
        `SELECT * FROM public."ramesh-reminders" WHERE account_id=$1 AND owner_employee_id=$2 AND (id=ANY($3::uuid[]) OR (task_id=ANY($3::uuid[]) AND state='scheduled')) ORDER BY id`,
        [this.accountId, actor.employeeId, validIds],
      )
    ).rows;
    const occurrences = (
      await db.query(
        `SELECT id,reminder_id,schedule_version,slot_key,dispatch_generation,scheduled_for,eligible_at,not_after,state,reason_code,outbound_message_id,created_at,finished_at
      FROM public."ramesh-reminder-occurrences" WHERE account_id=$1 AND reminder_id=ANY($2::uuid[]) AND (state=ANY($3::text[]) OR id=ANY($4::uuid[])) ORDER BY reminder_id,created_at,id LIMIT 1001`,
        [
          this.accountId,
          reminders.map((row) => row.id),
          activeOccurrences,
          occurrenceIds.filter(uuid),
        ],
      )
    ).rows;
    if (occurrences.length > 1000) throw new SchedulingError('PERSONAL_AUDIT_LIMIT');
    return {
      tasks: tasks.map((row) => this.record('task', row)),
      reminders: reminders.map((row) => this.record('reminder', row)),
      occurrences,
    };
  }
  private text(text: string) {
    if (typeof text !== 'string' || !text.trim() || text.length > 2000)
      throw new SchedulingError('PERSONAL_INVALID_TEXT');
    return text.trim();
  }
  private async target(
    db: PoolClient,
    ctx: PersonalActor,
    kind: 'task' | 'reminder',
    id: string,
    version?: number,
  ) {
    if (!uuid(id)) throw new SchedulingError('PERSONAL_NOT_FOUND');
    const row = (
      await db.query(
        `SELECT t.* ${kind === 'reminder' ? ',o.id AS occurrence_id,o.state AS occurrence_state,o.eligible_at AS occurrence_due_at' : ''}
         FROM public."ramesh-${kind === 'task' ? 'tasks' : 'reminders'}" t
         ${kind === 'reminder' ? `LEFT JOIN LATERAL(SELECT id,state,eligible_at FROM public."ramesh-reminder-occurrences" WHERE account_id=t.account_id AND reminder_id=t.id AND schedule_version=t.version ORDER BY CASE WHEN state IN('pending','preparing','waiting_source','queued') THEN 0 ELSE 1 END,eligible_at DESC,dispatch_generation DESC LIMIT 1)o ON true` : ''}
         WHERE t.id=$1 AND t.account_id=$2 AND t.owner_employee_id=$3 FOR UPDATE OF t`,
        [id, this.accountId, ctx.employeeId],
      )
    ).rows[0];
    if (!row) throw new SchedulingError('PERSONAL_NOT_FOUND');
    if (version !== undefined && row.version !== version)
      throw new SchedulingError('PERSONAL_VERSION_CONFLICT');
    return row;
  }
  private async quota(db: PoolClient, ctx: PersonalActor, kind: 'task' | 'reminder') {
    const row = (
      await db.query(
        `SELECT count(*)::int AS n FROM public."ramesh-${kind === 'task' ? 'tasks' : 'reminders'}" WHERE account_id=$1 AND owner_employee_id=$2 AND state=$3`,
        [this.accountId, ctx.employeeId, kind === 'task' ? 'open' : 'scheduled'],
      )
    ).rows[0];
    if (row.n >= (kind === 'task' ? 50 : 100)) throw new SchedulingError('PERSONAL_CAPACITY');
  }
  private async apply(
    db: PoolClient,
    ctx: PersonalCommandContext,
    op: PersonalOperation,
    creationKey: string,
    aliases: Map<string, string>,
  ): Promise<PersonalRecord> {
    if (op.kind === 'task_create') {
      await this.quota(db, ctx, 'task');
      const id = randomUUID();
      if (op.alias) {
        if (!/^[a-zA-Z][\w-]{0,39}$/.test(op.alias) || aliases.has(op.alias))
          throw new SchedulingError('PERSONAL_INVALID_ALIAS');
        aliases.set(op.alias, id);
      }
      const row = (
        await db.query(
          `INSERT INTO public."ramesh-tasks"(id,account_id,owner_employee_id,text_encrypted,deadline,creation_command_key)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
          [
            id,
            this.accountId,
            ctx.employeeId,
            this.cipher.seal(`personal-task:${ctx.employeeId}`, id, this.text(op.text)),
            op.deadline ? validateTaskDeadline(op.deadline) : null,
            creationKey,
          ],
        )
      ).rows[0];
      return this.record('task', row);
    }
    if (op.kind === 'reminder_create') {
      await this.quota(db, ctx, 'reminder');
      const schedule = validateSchedule(op.schedule);
      if (Date.parse(schedule.dueAt) < ctx.requestTimeMs)
        throw new SchedulingError('PERSONAL_PAST_TIME');
      const taskId = op.taskRef ? (aliases.get(op.taskRef) ?? op.taskRef) : null;
      if (taskId && (await this.target(db, ctx, 'task', taskId)).state !== 'open')
        throw new SchedulingError('PERSONAL_TASK_CLOSED');
      const id = randomUUID();
      const row = (
        await db.query(
          `INSERT INTO public."ramesh-reminders"(id,account_id,owner_employee_id,recipient_phone_e164,recipient_chat_id,text_encrypted,task_id,schedule,next_due_at,creation_command_key)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [
            id,
            this.accountId,
            ctx.employeeId,
            ctx.phoneE164,
            ctx.chatId,
            this.cipher.seal(`personal-reminder:${ctx.employeeId}`, id, this.text(op.text)),
            taskId,
            schedule,
            schedule.dueAt,
            creationKey,
          ],
        )
      ).rows[0];
      return this.record('reminder', row);
    }
    if (!('id' in op) || !Number.isSafeInteger(op.expectedVersion) || op.expectedVersion < 1)
      throw new SchedulingError('PERSONAL_INVALID_OPERATION');
    const kind = op.kind.startsWith('task_') ? 'task' : 'reminder';
    const old = await this.target(db, ctx, kind, op.id, op.expectedVersion);
    if (kind === 'task') {
      if (old.state !== 'open') throw new SchedulingError('PERSONAL_TASK_CLOSED');
      if (op.kind === 'task_update') {
        const row = (
          await db.query(
            `UPDATE public."ramesh-tasks" SET text_encrypted=$4,deadline=$5,version=version+1,updated_at=clock_timestamp() WHERE id=$1 AND account_id=$2 AND owner_employee_id=$3 RETURNING *`,
            [
              op.id,
              this.accountId,
              ctx.employeeId,
              op.text === undefined
                ? old.text_encrypted
                : this.cipher.seal(`personal-task:${ctx.employeeId}`, op.id, this.text(op.text)),
              op.deadline === undefined
                ? old.deadline
                : op.deadline === null
                  ? null
                  : validateTaskDeadline(op.deadline),
            ],
          )
        ).rows[0];
        return this.record('task', row);
      }
      if (op.kind !== 'task_complete' && op.kind !== 'task_cancel')
        throw new SchedulingError('PERSONAL_INVALID_OPERATION');
      const linked = (
        await db.query(
          `SELECT id FROM public."ramesh-reminders" WHERE account_id=$1 AND owner_employee_id=$2 AND task_id=$3 AND state='scheduled' ORDER BY id FOR UPDATE`,
          [this.accountId, ctx.employeeId, op.id],
        )
      ).rows;
      let alreadySending = false;
      for (const r of linked) {
        alreadySending = (await this.cancel(db, r.id)) || alreadySending;
      }
      const row = (
        await db.query(
          `UPDATE public."ramesh-tasks" SET state=$4,version=version+1,finished_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 AND account_id=$2 AND owner_employee_id=$3 RETURNING *`,
          [
            op.id,
            this.accountId,
            ctx.employeeId,
            op.kind === 'task_complete' ? 'done' : 'cancelled',
          ],
        )
      ).rows[0];
      return { ...this.record('task', row), affectedReminders: linked.length, alreadySending };
    }
    if (op.kind === 'reminder_cancel') {
      const alreadySending = await this.cancel(db, op.id);
      const row = (
        await db.query(`SELECT * FROM public."ramesh-reminders" WHERE id=$1 AND account_id=$2`, [
          op.id,
          this.accountId,
        ])
      ).rows[0];
      return { ...this.record('reminder', row), alreadySending };
    }
    if (op.kind === 'reminder_reschedule') {
      if (old.state !== 'scheduled') await this.quota(db, ctx, 'reminder');
      const schedule = validateSchedule(op.schedule);
      if (Date.parse(schedule.dueAt) < ctx.requestTimeMs)
        throw new SchedulingError('PERSONAL_PAST_TIME');
      if (old.task_id && (await this.target(db, ctx, 'task', old.task_id)).state !== 'open')
        throw new SchedulingError('PERSONAL_TASK_CLOSED');
      const alreadySending = await this.cancelOccurrences(db, op.id);
      const row = (
        await db.query(
          `UPDATE public."ramesh-reminders" SET schedule=$3,next_due_at=$4,recipient_phone_e164=$5,recipient_chat_id=$6,state='scheduled',consumed=false,version=version+1,finished_at=NULL,updated_at=clock_timestamp() WHERE id=$1 AND account_id=$2 RETURNING *`,
          [op.id, this.accountId, schedule, schedule.dueAt, ctx.phoneE164, ctx.chatId],
        )
      ).rows[0];
      return { ...this.record('reminder', row), alreadySending };
    }
    if (op.kind === 'reminder_snooze') {
      const schedule = validateSchedule({ dueAt: op.dueAt, timezone: 'Asia/Kolkata' });
      if (Date.parse(schedule.dueAt) < ctx.requestTimeMs)
        throw new SchedulingError('PERSONAL_PAST_TIME');
      if (!uuid(op.occurrenceId)) throw new SchedulingError('PERSONAL_NOT_FOUND');
      const occurrence = (
        await db.query(
          `SELECT * FROM public."ramesh-reminder-occurrences" WHERE id=$1 AND account_id=$2 AND reminder_id=$3 AND schedule_version=$4 FOR UPDATE`,
          [op.occurrenceId, this.accountId, op.id, old.version],
        )
      ).rows[0];
      if (
        !occurrence ||
        !['pending', 'preparing', 'waiting_source', 'queued', 'sent', 'missed'].includes(
          occurrence.state,
        ) ||
        old.state === 'cancelled'
      )
        throw new SchedulingError('PERSONAL_OCCURRENCE_CONFLICT');
      const newer = await db.query(
        `SELECT 1 FROM public."ramesh-reminder-occurrences" WHERE account_id=$1 AND reminder_id=$2 AND schedule_version=$3 AND slot_key=$4 AND dispatch_generation>$5 LIMIT 1`,
        [this.accountId, op.id, old.version, occurrence.slot_key, occurrence.dispatch_generation],
      );
      if (newer.rowCount) throw new SchedulingError('PERSONAL_OCCURRENCE_CONFLICT');
      if (old.task_id && (await this.target(db, ctx, 'task', old.task_id)).state !== 'open')
        throw new SchedulingError('PERSONAL_TASK_CLOSED');
      if (old.state !== 'scheduled') await this.quota(db, ctx, 'reminder');
      if (await this.cancelOccurrences(db, op.id, op.occurrenceId))
        throw new SchedulingError('PERSONAL_ALREADY_SENDING');
      const updated = (
        await db.query(
          `UPDATE public."ramesh-reminders" SET dispatch_counter=dispatch_counter+1,recipient_phone_e164=$3,recipient_chat_id=$4,state='scheduled',finished_at=NULL,updated_at=clock_timestamp() WHERE id=$1 AND account_id=$2 RETURNING *`,
          [op.id, this.accountId, ctx.phoneE164, ctx.chatId],
        )
      ).rows[0];
      const replacement = await this.insertOccurrence(
        db,
        updated,
        new Date(occurrence.slot_key),
        new Date(schedule.dueAt),
        updated.dispatch_counter,
      );
      return {
        ...this.record('reminder', updated),
        occurrenceId: replacement.id,
        occurrenceState: replacement.state,
        occurrenceDueAt: schedule.dueAt,
      };
    }
    throw new SchedulingError('PERSONAL_INVALID_OPERATION');
  }
  private async cancel(db: PoolClient, id: string) {
    const started = await this.cancelOccurrences(db, id);
    await db.query(
      `UPDATE public."ramesh-reminders" SET state='cancelled',version=version+1,next_due_at=NULL,finished_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 AND account_id=$2`,
      [id, this.accountId],
    );
    return started;
  }
  private async cancelOccurrences(db: PoolClient, id: string, occurrenceId?: string) {
    const rows = (
      await db.query(
        `SELECT o.*,m.state AS message_state FROM public."ramesh-reminder-occurrences" o LEFT JOIN public."ramesh-messages" m ON m.id=o.outbound_message_id
      WHERE o.account_id=$1 AND o.reminder_id=$2 AND ($3::uuid IS NULL OR o.id=$3) AND o.state=ANY($4::text[]) ORDER BY o.id FOR UPDATE OF o`,
        [this.accountId, id, occurrenceId ?? null, activeOccurrences],
      )
    ).rows;
    let started = false;
    for (const row of rows) {
      if (row.message_state === 'SENDING') {
        started = true;
        continue;
      }
      await db.query(
        `UPDATE public."ramesh-reminder-occurrences" SET state='cancelled',lease_token=NULL,lease_until=NULL,finished_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`,
        [row.id],
      );
      if (row.outbound_message_id) {
        await db.query(
          `UPDATE public."ramesh-outbound-queue" SET state='DONE',lease_token=NULL,lease_until=NULL,payload_encrypted=NULL,updated_at=clock_timestamp() WHERE message_id=$1 AND account_id=$2 AND state IN('READY','LEASED')`,
          [row.outbound_message_id, this.accountId],
        );
        await db.query(
          `UPDATE public."ramesh-messages" SET state='EXPIRED',reason='reminder_cancelled',payload_encrypted=NULL,finished_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 AND account_id=$2 AND state='READY_TO_SEND'`,
          [row.outbound_message_id, this.accountId],
        );
      }
    }
    return started;
  }
  async list(
    actor: PersonalActor,
    kind: 'task' | 'reminder',
    runId: string,
    options: {
      state?: string;
      limit?: number;
      cursor?: string;
      continuation?: 'latest';
      appendSelectionId?: string;
    } = {},
  ): Promise<PersonalListResult> {
    this.actor(actor);
    if (!uuid(runId)) throw new SchedulingError('PERSONAL_INVALID_RUN');
    const limit = options.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50)
      throw new SchedulingError('PERSONAL_LIST_LIMIT');
    let state = options.state ?? (kind === 'task' ? 'open' : 'scheduled');
    if (
      !(
        kind === 'task'
          ? ['open', 'done', 'cancelled', 'all']
          : ['scheduled', 'completed', 'cancelled', 'all']
      ).includes(state)
    )
      throw new SchedulingError('PERSONAL_INVALID_STATE');
    let cursor: [string, string] | undefined;
    if (options.cursor) {
      try {
        const c = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8'));
        if (
          !Array.isArray(c) ||
          c.length !== 2 ||
          !Number.isFinite(Date.parse(c[0])) ||
          !uuid(c[1])
        )
          throw new Error();
        cursor = c as [string, string];
      } catch {
        throw new SchedulingError('PERSONAL_INVALID_CURSOR');
      }
    }
    return this.tx(async (db) => {
      let previous: VersionedTarget[] = [];
      if (options.continuation && (options.cursor || options.appendSelectionId))
        throw new SchedulingError('PERSONAL_INVALID_CURSOR');
      if (options.continuation || options.appendSelectionId) {
        if (options.appendSelectionId && !uuid(options.appendSelectionId))
          throw new SchedulingError('PERSONAL_SELECTION_INVALID');
        const selections = (
          await db.query(
            `SELECT c.* FROM public."ramesh-assistant-commands" c JOIN public."ramesh-messages" m ON m.id=c.run_id AND m.account_id=c.account_id
           WHERE c.account_id=$1 AND c.owner_employee_id=$2 AND c.kind='selection' AND c.expires_at>clock_timestamp() AND m.chat_id=$3
           AND (($4::uuid IS NOT NULL AND c.id=$4 AND c.run_id=$5) OR ($4::uuid IS NULL AND c.presented AND m.reply_kind='business' AND m.state='SENT'))
           ORDER BY m.finished_at DESC NULLS LAST,c.created_at DESC,c.id DESC LIMIT 50`,
            [
              this.accountId,
              actor.employeeId,
              actor.chatId,
              options.appendSelectionId ?? null,
              runId,
            ],
          )
        ).rows;
        let found = false;
        for (const row of selections) {
          const payload = this.cipher.open(
            `personal-selection:${actor.employeeId}`,
            row.id,
            row.payload_encrypted,
          ) as {
            kind: string;
            records: VersionedTarget[];
            state: string;
            nextCursor?: string | null;
          };
          if (payload.kind !== kind) continue;
          if (options.state !== undefined && options.state !== payload.state)
            throw new SchedulingError('PERSONAL_INVALID_STATE');
          state = payload.state;
          if (!payload.nextCursor) throw new SchedulingError('PERSONAL_LIST_COMPLETE');
          const savedCursor = JSON.parse(
            Buffer.from(payload.nextCursor, 'base64url').toString('utf8'),
          ) as [string, string];
          if (options.cursor && (cursor?.[0] !== savedCursor[0] || cursor?.[1] !== savedCursor[1]))
            throw new SchedulingError('PERSONAL_INVALID_CURSOR');
          cursor = savedCursor;
          if (options.appendSelectionId) previous = payload.records;
          found = true;
          break;
        }
        if (!found) throw new SchedulingError('PERSONAL_SELECTION_NOT_FOUND');
      }
      const pageLimit = Math.min(limit, 50 - previous.length);
      if (pageLimit < 1) throw new SchedulingError('PERSONAL_LIST_LIMIT');
      const table = kind === 'task' ? 'ramesh-tasks' : 'ramesh-reminders';
      const rows = (
        await db.query(
          `SELECT t.*,t.created_at::text AS cursor_time ${kind === 'reminder' ? ',o.id AS occurrence_id,o.state AS occurrence_state,o.eligible_at AS occurrence_due_at' : ''}
        FROM public."${table}" t ${kind === 'reminder' ? `LEFT JOIN LATERAL(SELECT id,state,eligible_at FROM public."ramesh-reminder-occurrences" WHERE account_id=t.account_id AND reminder_id=t.id AND schedule_version=t.version ORDER BY CASE WHEN state IN('pending','preparing','waiting_source','queued') THEN 0 ELSE 1 END,eligible_at DESC,dispatch_generation DESC LIMIT 1)o ON true` : ''}
        WHERE t.account_id=$1 AND t.owner_employee_id=$2 AND ($3='all' OR t.state=$3)
        AND ($4::timestamptz IS NULL OR (t.created_at,t.id)>($4::timestamptz,$5::uuid))
        ORDER BY t.created_at,t.id LIMIT $6`,
          [
            this.accountId,
            actor.employeeId,
            state,
            cursor?.[0] ?? null,
            cursor?.[1] ?? null,
            pageLimit + 1,
          ],
        )
      ).rows;
      const records: PersonalRecord[] = [];
      for (const target of previous)
        records.push(
          this.record(kind, await this.target(db, actor, kind, target.id, target.expectedVersion)),
        );
      let included = 0;
      for (const row of rows.slice(0, pageLimit)) {
        const candidate = this.record(kind, row);
        // Reserve the continuation footer while fitting the actual rendered presentation.
        if (
          renderList(kind, {
            records: [...records, candidate],
            selectionId: '',
            nextCursor: 'more',
          }).length > PERSONAL_LIST_MAX_CHARACTERS
        )
          break;
        records.push(candidate);
        included++;
      }
      if (!included && rows.length) throw new SchedulingError('PERSONAL_LIST_LIMIT');
      const last = rows[included - 1];
      const nextCursor =
        rows.length > included && last
          ? Buffer.from(JSON.stringify([last.cursor_time, last.id])).toString('base64url')
          : null;
      const id = randomUUID();
      await db.query(
        `INSERT INTO public."ramesh-assistant-commands"(id,account_id,owner_employee_id,run_id,kind,payload_encrypted,finished_at,expires_at)
        VALUES($1,$2,$3,$4,'selection',$5,clock_timestamp(),clock_timestamp()+interval '30 days')`,
        [
          id,
          this.accountId,
          actor.employeeId,
          runId,
          this.cipher.seal(`personal-selection:${actor.employeeId}`, id, {
            kind,
            records: records.map((r) => ({ id: r.id, expectedVersion: r.version })),
            state,
            nextCursor,
          }),
        ],
      );
      return {
        records,
        selectionId: id,
        nextCursor,
      };
    });
  }
  async finalizeSelections(ctx: PersonalCommandContext, ids: string[]): Promise<void> {
    if (ids.length > 8 || ids.some((id) => !uuid(id)))
      throw new SchedulingError('PERSONAL_SELECTION_INVALID');
    await this.tx(async (db) => {
      await this.fence(db, ctx);
      await this.markSelections(db, ctx, ids);
    });
  }
  private async markSelections(
    db: PoolClient,
    ctx: PersonalCommandContext,
    ids: string[],
  ): Promise<void> {
    const found = (
      await db.query(
        `SELECT id FROM public."ramesh-assistant-commands" WHERE account_id=$1 AND owner_employee_id=$2 AND run_id=$3 AND kind='selection' AND id=ANY($4::uuid[]) AND expires_at>clock_timestamp()`,
        [this.accountId, ctx.employeeId, ctx.runId, ids],
      )
    ).rows;
    if (found.length !== new Set(ids).size) throw new SchedulingError('PERSONAL_SELECTION_INVALID');
    await db.query(
      `UPDATE public."ramesh-assistant-commands" SET presented=(id=ANY($4::uuid[])) WHERE account_id=$1 AND owner_employee_id=$2 AND run_id=$3 AND kind='selection'`,
      [this.accountId, ctx.employeeId, ctx.runId, ids],
    );
  }
  async resolveSelection(
    actor: PersonalActor,
    kind: 'task' | 'reminder',
    selectionId: string,
    ordinal: number,
  ): Promise<VersionedTarget> {
    this.actor(actor);
    if (
      !Number.isInteger(ordinal) ||
      ordinal < 1 ||
      ordinal > 50 ||
      !(selectionId === 'latest' || uuid(selectionId))
    )
      throw new SchedulingError('PERSONAL_SELECTION_INVALID');
    return this.tx(async (db) => {
      const rows = (
        await db.query(
          `SELECT c.*,m.state AS delivery_state FROM public."ramesh-assistant-commands" c JOIN public."ramesh-messages" m ON m.id=c.run_id AND m.account_id=c.account_id
        WHERE c.account_id=$1 AND c.owner_employee_id=$2 AND c.kind='selection' AND c.presented AND c.expires_at>clock_timestamp()
        AND ($3::uuid IS NULL OR c.id=$3) AND m.reply_kind='business' AND m.state IN('SENT','UNCERTAIN') ORDER BY c.created_at DESC,c.id DESC LIMIT 50`,
          [this.accountId, actor.employeeId, selectionId === 'latest' ? null : selectionId],
        )
      ).rows;
      for (const row of rows) {
        const payload = this.cipher.open(
          `personal-selection:${actor.employeeId}`,
          row.id,
          row.payload_encrypted,
        ) as { kind: string; records: VersionedTarget[] };
        if (payload.kind !== kind) continue;
        if (row.delivery_state !== 'SENT')
          throw new SchedulingError('PERSONAL_SELECTION_UNCERTAIN');
        const selected = payload.records[ordinal - 1];
        if (!selected) throw new SchedulingError('PERSONAL_SELECTION_INVALID');
        await this.target(db, actor, kind, selected.id, selected.expectedVersion);
        return selected;
      }
      throw new SchedulingError('PERSONAL_SELECTION_NOT_FOUND');
    });
  }
  private async insertOccurrence(
    db: PoolClient,
    reminder: Row,
    slot: Date,
    due: Date,
    generation = 0,
  ) {
    const id = randomUUID();
    const inserted = (
      await db.query(
        `INSERT INTO public."ramesh-reminder-occurrences"(id,account_id,reminder_id,schedule_version,slot_key,dispatch_generation,scheduled_for,eligible_at,not_after,next_attempt_at,recipient_employee_id,recipient_phone_e164,recipient_chat_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$7,$7::timestamptz+interval '1 hour',$7,$8,$9,$10)
      ON CONFLICT(account_id,reminder_id,schedule_version,slot_key,dispatch_generation) DO NOTHING RETURNING *`,
        [
          id,
          this.accountId,
          reminder.id,
          reminder.version,
          slot,
          generation,
          due,
          reminder.owner_employee_id,
          reminder.recipient_phone_e164,
          reminder.recipient_chat_id,
        ],
      )
    ).rows[0];
    return (
      inserted ??
      (
        await db.query(
          `SELECT * FROM public."ramesh-reminder-occurrences" WHERE account_id=$1 AND reminder_id=$2 AND schedule_version=$3 AND slot_key=$4 AND dispatch_generation=$5`,
          [this.accountId, reminder.id, reminder.version, slot, generation],
        )
      ).rows[0]
    );
  }
  private async reconcileIn(db: PoolClient) {
    await db.query(
      `UPDATE public."ramesh-reminder-occurrences" SET state='missed',lease_token=NULL,lease_until=NULL,reason_code='deadline_expired',finished_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE account_id=$1 AND state IN('pending','preparing','waiting_source') AND not_after<=clock_timestamp()`,
      [this.accountId],
    );
    await db.query(
      `UPDATE public."ramesh-reminder-occurrences" SET state=CASE WHEN attempts>=5 THEN 'failed' ELSE 'pending' END,reason_code=CASE WHEN attempts>=5 THEN 'attempts_exhausted' ELSE 'lease_expired' END,
      lease_token=NULL,lease_until=NULL,next_attempt_at=clock_timestamp(),finished_at=CASE WHEN attempts>=5 THEN clock_timestamp() ELSE NULL END,updated_at=clock_timestamp()
      WHERE account_id=$1 AND state='preparing' AND lease_until<=clock_timestamp()`,
      [this.accountId],
    );
    await db.query(
      `UPDATE public."ramesh-reminder-occurrences" o SET state=CASE m.state WHEN 'SENT' THEN 'sent' WHEN 'EXPIRED' THEN 'missed' WHEN 'UNCERTAIN' THEN 'uncertain' ELSE 'failed' END,
      reason_code=left(m.reason,64),finished_at=coalesce(m.finished_at,clock_timestamp()),updated_at=clock_timestamp()
      FROM public."ramesh-messages" m WHERE o.account_id=$1 AND o.outbound_message_id=m.id AND m.account_id=o.account_id AND o.state='queued' AND m.state IN('SENT','EXPIRED','FAILED','UNCERTAIN')`,
      [this.accountId],
    );
    await db.query(
      `UPDATE public."ramesh-reminders" r SET state='completed',last_outcome=(SELECT o.state FROM public."ramesh-reminder-occurrences" o WHERE o.account_id=r.account_id AND o.reminder_id=r.id AND o.schedule_version=r.version ORDER BY o.updated_at DESC LIMIT 1),finished_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE r.account_id=$1 AND r.state='scheduled' AND r.next_due_at IS NULL AND r.consumed
      AND NOT EXISTS(SELECT 1 FROM public."ramesh-reminder-occurrences" o WHERE o.account_id=r.account_id AND o.reminder_id=r.id AND o.state IN('pending','preparing','waiting_source','queued'))`,
      [this.accountId],
    );
  }
  async reconcile() {
    await this.tx((db) => this.reconcileIn(db));
  }
  private async materializeDue(db: PoolClient): Promise<void> {
    const now = (await db.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
    const ready = (
      await db.query(
        `WITH ranked AS (SELECT id,row_number() OVER(PARTITION BY owner_employee_id ORDER BY next_due_at,id) AS owner_rank
          FROM public."ramesh-reminders" WHERE account_id=$1 AND state='scheduled' AND next_due_at<=clock_timestamp())
          SELECT r.*,t.state AS task_state FROM ranked JOIN public."ramesh-reminders" r ON r.id=ranked.id
          LEFT JOIN public."ramesh-tasks" t ON t.id=r.task_id AND t.account_id=r.account_id AND t.owner_employee_id=r.owner_employee_id
          ORDER BY ranked.owner_rank,r.next_due_at,r.id LIMIT 25 FOR UPDATE OF r SKIP LOCKED`,
        [this.accountId],
      )
    ).rows;
    const slots: Array<{
      id: string;
      occurrence_id: string;
      due: string;
      next_due: string | null;
    }> = [];
    for (const r of ready) {
      if (r.task_id) {
        if (r.task_state !== 'open') {
          await this.cancel(db, r.id);
          continue;
        }
      }
      let schedule: ScheduleSpec;
      try {
        schedule = validateSchedule(r.schedule as ScheduleSpec);
      } catch {
        // A corrupt definition must not roll back progress for every other owner.
        await this.cancel(db, r.id);
        await db.query(
          `UPDATE public."ramesh-reminders" SET state='completed',consumed=true,last_outcome='invalid_schedule' WHERE id=$1 AND account_id=$2`,
          [r.id, this.accountId],
        );
        continue;
      }
      let due = new Date(r.next_due_at);
      if (schedule.recurrence && due.getTime() <= now.getTime() - 3600000) {
        const recent = nextOccurrence(schedule, new Date(now.getTime() - 3600000));
        if (recent && recent <= now) due = recent;
      }
      const next = schedule.recurrence ? nextOccurrence(schedule, now) : null;
      slots.push({
        id: r.id,
        occurrence_id: randomUUID(),
        due: due.toISOString(),
        next_due: next?.toISOString() ?? null,
      });
    }
    if (slots.length)
      await db.query(
        `WITH slots AS (SELECT * FROM jsonb_to_recordset($2::jsonb) AS s(id uuid,occurrence_id uuid,due timestamptz,next_due timestamptz)),
         inserted AS (
           INSERT INTO public."ramesh-reminder-occurrences"(id,account_id,reminder_id,schedule_version,slot_key,scheduled_for,eligible_at,not_after,next_attempt_at,recipient_employee_id,recipient_phone_e164,recipient_chat_id)
           SELECT s.occurrence_id,r.account_id,r.id,r.version,s.due,s.due,s.due,s.due+interval '1 hour',s.due,r.owner_employee_id,r.recipient_phone_e164,r.recipient_chat_id
           FROM slots s JOIN public."ramesh-reminders" r ON r.id=s.id AND r.account_id=$1
           ON CONFLICT(account_id,reminder_id,schedule_version,slot_key,dispatch_generation) DO NOTHING
         )
         UPDATE public."ramesh-reminders" r SET next_due_at=s.next_due,consumed=true,updated_at=clock_timestamp() FROM slots s WHERE r.id=s.id AND r.account_id=$1`,
        [this.accountId, JSON.stringify(slots)],
      );
  }
  /** Materialize and reconcile once per scheduler tick, outside its per-occurrence claim loop. */
  async prepareDue(): Promise<void> {
    await this.tx(async (db) => {
      await this.materializeDue(db);
      await this.reconcileIn(db);
    });
  }
  async claimDue(leaseMs: number): Promise<DueReminder | null> {
    return this.claim(leaseMs, [], true);
  }
  async claimPrepared(
    leaseMs: number,
    excludedEmployeeIds: number[] = [],
  ): Promise<DueReminder | null> {
    return this.claim(leaseMs, excludedEmployeeIds, false);
  }
  private async claim(
    leaseMs: number,
    excludedEmployeeIds: number[],
    prepare: boolean,
  ): Promise<DueReminder | null> {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 100 || leaseMs > 120000)
      throw new SchedulingError('PERSONAL_INVALID_LEASE');
    if (
      excludedEmployeeIds.length > 100 ||
      excludedEmployeeIds.some((id) => !Number.isSafeInteger(id) || id < 1)
    )
      throw new SchedulingError('PERSONAL_INVALID_OWNER');
    return this.tx(async (db) => {
      if (prepare) {
        await this.materializeDue(db);
        await this.reconcileIn(db);
      }
      const candidates = (
        await db.query(
          `SELECT o.*,r.text_encrypted,r.owner_employee_id FROM public."ramesh-reminder-occurrences" o JOIN public."ramesh-reminders" r ON r.id=o.reminder_id AND r.account_id=o.account_id
        WHERE o.account_id=$1 AND o.state IN('pending','waiting_source') AND o.next_attempt_at<=clock_timestamp() AND o.eligible_at<=clock_timestamp() AND o.not_after>clock_timestamp()
        AND r.state='scheduled' AND r.version=o.schedule_version AND o.attempts<5 AND NOT (o.recipient_employee_id=ANY($2::integer[]))
        AND NOT EXISTS(SELECT 1 FROM public."ramesh-reminder-occurrences" busy WHERE busy.account_id=o.account_id AND busy.recipient_employee_id=o.recipient_employee_id AND busy.state='preparing')
        ORDER BY o.eligible_at,o.id LIMIT 25 FOR UPDATE OF o SKIP LOCKED`,
          [this.accountId, excludedEmployeeIds],
        )
      ).rows;
      for (const row of candidates) {
        let text: unknown;
        try {
          text = this.cipher.open(
            `personal-reminder:${row.owner_employee_id}`,
            row.reminder_id,
            row.text_encrypted,
          );
          if (typeof text !== 'string') throw new Error('Invalid stored reminder');
        } catch {
          await db.query(
            `UPDATE public."ramesh-reminder-occurrences" SET state='failed',reason_code='invalid_content',finished_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 AND account_id=$2`,
            [row.id, this.accountId],
          );
          await this.reconcileIn(db);
          continue;
        }
        const token = randomUUID();
        await db.query(
          `UPDATE public."ramesh-reminder-occurrences" SET state='preparing',lease_token=$2,lease_until=least(not_after,clock_timestamp()+$3*interval '1 millisecond'),attempts=attempts+1,updated_at=clock_timestamp() WHERE id=$1`,
          [row.id, token, leaseMs],
        );
        return {
          id: row.id,
          reminderId: row.reminder_id,
          employeeId: row.recipient_employee_id,
          phoneE164: row.recipient_phone_e164,
          chatId: row.recipient_chat_id,
          text: text as string,
          dueAt: row.eligible_at.toISOString(),
          notAfter: row.not_after.toISOString(),
          leaseToken: token,
          scheduleVersion: row.schedule_version,
          dispatchGeneration: row.dispatch_generation,
        };
      }
      return null;
    });
  }
  private async ownDue(db: PoolClient, due: DueReminder) {
    return (
      await db.query(
        `SELECT o.* FROM public."ramesh-reminder-occurrences" o JOIN public."ramesh-reminders" r ON r.id=o.reminder_id AND r.account_id=o.account_id
      LEFT JOIN public."ramesh-tasks" t ON t.id=r.task_id AND t.account_id=r.account_id
      WHERE o.id=$1 AND o.account_id=$2 AND o.state='preparing' AND o.lease_token=$3 AND o.lease_until>clock_timestamp() AND o.not_after>clock_timestamp()
      AND r.state='scheduled' AND r.version=o.schedule_version AND (r.task_id IS NULL OR t.state='open') FOR UPDATE OF o,r`,
        [due.id, this.accountId, due.leaseToken],
      )
    ).rows[0];
  }
  async renewDue(due: DueReminder, leaseMs: number): Promise<boolean> {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 100 || leaseMs > 120000)
      throw new SchedulingError('PERSONAL_INVALID_LEASE');
    return this.tx(async (db) => {
      if (!(await this.ownDue(db, due))) return false;
      await db.query(
        `UPDATE public."ramesh-reminder-occurrences" SET lease_until=least(not_after,clock_timestamp()+$3*interval '1 millisecond') WHERE id=$1 AND account_id=$2`,
        [due.id, this.accountId, leaseMs],
      );
      return true;
    });
  }
  async releaseDue(
    due: DueReminder,
    reason: string,
    terminal?: 'suppressed' | 'failed',
  ): Promise<void> {
    if (!/^[a-zA-Z0-9_]{1,64}$/.test(reason)) throw new SchedulingError('PERSONAL_INVALID_REASON');
    await this.tx(async (db) => {
      const row = await this.ownDue(db, due);
      if (!row) return;
      const paused = reason === 'scheduler_paused' && terminal === undefined;
      const state =
        terminal ?? (paused ? 'pending' : row.attempts >= 5 ? 'failed' : 'waiting_source');
      await db.query(
        `UPDATE public."ramesh-reminder-occurrences" SET state=$3,reason_code=$4,lease_token=NULL,lease_until=NULL,attempts=greatest(0,attempts-CASE WHEN $5 THEN 1 ELSE 0 END),next_attempt_at=least(not_after,clock_timestamp()+CASE WHEN $5 THEN interval '0 seconds' ELSE interval '30 seconds' END),finished_at=CASE WHEN $3 IN('failed','suppressed') THEN clock_timestamp() ELSE NULL END,updated_at=clock_timestamp() WHERE id=$1 AND account_id=$2`,
        [due.id, this.accountId, state, reason, paused],
      );
      await this.reconcileIn(db);
    });
  }
  async enqueueDue(
    due: DueReminder,
    actor: PersonalActor,
    enqueue: (db: PoolClient, ref: ReminderDeliveryRef) => Promise<string | 'full'>,
  ): Promise<'queued' | 'full' | 'stale'> {
    this.actor(actor);
    return this.tx(async (db) => {
      const row = await this.ownDue(db, due);
      if (!row) return 'stale';
      if (
        row.recipient_employee_id !== actor.employeeId ||
        row.recipient_phone_e164 !== actor.phoneE164 ||
        row.recipient_chat_id !== actor.chatId
      ) {
        await db.query(
          `UPDATE public."ramesh-reminder-occurrences" SET state='suppressed',reason_code='recipient_changed',lease_token=NULL,lease_until=NULL,finished_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 AND account_id=$2`,
          [row.id, this.accountId],
        );
        await this.reconcileIn(db);
        return 'stale';
      }
      const ref: ReminderDeliveryRef = {
        occurrenceId: row.id,
        reminderId: row.reminder_id,
        scheduleVersion: row.schedule_version,
        dispatchGeneration: row.dispatch_generation,
        ownerEmployeeId: row.recipient_employee_id,
        recipientPhoneE164: row.recipient_phone_e164,
        notAfterMs: row.not_after.getTime(),
      };
      const messageId = await enqueue(db, ref);
      if (messageId === 'full') {
        await db.query(
          `UPDATE public."ramesh-reminder-occurrences" SET state='pending',lease_token=NULL,lease_until=NULL,attempts=greatest(0,attempts-1),next_attempt_at=least(not_after,clock_timestamp()+interval '30 seconds'),updated_at=clock_timestamp() WHERE id=$1`,
          [row.id],
        );
        return 'full';
      }
      if (!uuid(messageId)) throw new SchedulingError('PERSONAL_INVALID_OUTBOUND');
      const message = (
        await db.query(
          `SELECT id FROM public."ramesh-messages" WHERE id=$1 AND account_id=$2 AND chat_id=$3 AND origin='reminder' AND state='READY_TO_SEND' AND expires_at<=$4`,
          [messageId, this.accountId, actor.chatId, row.not_after],
        )
      ).rows[0];
      if (!message) throw new SchedulingError('PERSONAL_INVALID_OUTBOUND');
      await db.query(
        `UPDATE public."ramesh-reminder-occurrences" SET state='queued',outbound_message_id=$3,lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1 AND account_id=$2`,
        [row.id, this.accountId, messageId],
      );
      return 'queued';
    });
  }
  async canDeliver(ref: ReminderDeliveryRef, actor: PersonalActor): Promise<boolean> {
    this.actor(actor);
    const row = (
      await this.pool.query(
        `SELECT 1 FROM public."ramesh-reminder-occurrences" o JOIN public."ramesh-reminders" r ON r.id=o.reminder_id AND r.account_id=o.account_id
      LEFT JOIN public."ramesh-tasks" t ON t.id=r.task_id AND t.account_id=r.account_id
      WHERE o.id=$1 AND o.account_id=$2 AND o.reminder_id=$3 AND o.schedule_version=$4 AND o.dispatch_generation=$5
      AND o.state='queued' AND o.not_after>clock_timestamp() AND r.state='scheduled' AND r.version=o.schedule_version
      AND r.owner_employee_id=$6 AND o.recipient_employee_id=$6 AND r.recipient_phone_e164=$7 AND o.recipient_phone_e164=$7
      AND r.recipient_chat_id=$8 AND o.recipient_chat_id=$8 AND (r.task_id IS NULL OR t.state='open')`,
        [
          ref.occurrenceId,
          this.accountId,
          ref.reminderId,
          ref.scheduleVersion,
          ref.dispatchGeneration,
          actor.employeeId,
          actor.phoneE164,
          actor.chatId,
        ],
      )
    ).rows[0];
    return (
      !!row &&
      ref.ownerEmployeeId === actor.employeeId &&
      ref.recipientPhoneE164 === actor.phoneE164 &&
      ref.notAfterMs > Date.now()
    );
  }
  async clean(): Promise<void> {
    await this.tx(async (db) => {
      await this.reconcileIn(db);
      await db.query(
        `DELETE FROM public."ramesh-assistant-commands" c WHERE c.account_id=$1 AND c.finished_at IS NOT NULL AND c.expires_at<clock_timestamp()
      AND NOT EXISTS(SELECT 1 FROM public."ramesh-messages" m WHERE m.id=c.run_id AND m.account_id=c.account_id AND m.state IN('QUEUED','PROCESSING','READY_TO_SEND','SENDING'))`,
        [this.accountId],
      );
      await db.query(
        `DELETE FROM public."ramesh-reminder-occurrences" WHERE account_id=$1 AND state IN('sent','cancelled','missed','failed','uncertain','suppressed') AND finished_at<clock_timestamp()-interval '30 days'`,
        [this.accountId],
      );
    });
  }
}
