/** Durable write intent and append-only receipts. No HTTP call runs inside these transactions. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { proto, type WAMessage } from '@whiskeysockets/baileys';
import type { Pool, PoolClient } from 'pg';
import { authCipher } from './auth-store.js';
import { toInboxCandidate } from '../whatsapp/message.mapper.js';
import type { InboxContent } from './inbox.repository.js';
import { decodeReply } from '../../modules/messaging/reply-payload.js';
import {
  WriteStorageError,
  type WriteActor,
  type WriteAttemptResult,
  type WriteAuditRecord,
  type WriteCommandContext,
  type WriteDispatchClaim,
  type WriteOperation,
  type WriteProposalPayload,
  type WriteRepositoryPort,
  type WriteSourceMessage,
  type WriteState,
} from '../../modules/writes/write.types.js';

type Row = Record<string, any>;
type Cipher = ReturnType<typeof authCipher>;
const uuid = (s: string) =>
  typeof s === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(s);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function jsonCopy<T>(value: T, limit: number): T {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    throw new WriteStorageError('WRITE_INVALID_PAYLOAD');
  }
  if (!text! || Buffer.byteLength(text) > limit) throw new WriteStorageError('WRITE_PAYLOAD_LIMIT');
  return JSON.parse(text) as T;
}
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

/** Shared by personal mutations inside their original transaction; never catches audit failures. */
export async function appendWriteAudit(
  db: PoolClient,
  cipher: Cipher,
  accountId: string,
  actor: WriteActor,
  event: {
    operationId?: string;
    personalCommandId?: string;
    sourceFamily: string;
    kind: string;
    actorType?: 'employee' | 'system';
    runId?: string;
    sourceMessageId?: string;
    operationVersion?: number;
    before: unknown;
    after: unknown;
  },
): Promise<void> {
  const id = randomUUID();
  const payload = jsonCopy({ before: event.before, after: event.after }, 900000);
  await db.query(
    `INSERT INTO public."ramesh-write-events"(id,account_id,owner_employee_id,phone_e164,chat_id,operation_id,personal_command_id,source_family,kind,actor_type,run_id,source_message_id,operation_version,payload_encrypted)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      id,
      accountId,
      actor.employeeId,
      actor.phoneE164,
      actor.chatId,
      event.operationId ?? null,
      event.personalCommandId ?? null,
      event.sourceFamily,
      event.kind,
      event.actorType ?? 'employee',
      event.runId ?? null,
      event.sourceMessageId ?? null,
      event.operationVersion ?? null,
      cipher.seal(`write-audit:${accountId}:${actor.employeeId}`, id, payload),
    ],
  );
}

export class WriteRepository implements WriteRepositoryPort {
  private readonly cipher: Cipher;
  constructor(
    private readonly pool: Pool,
    readonly accountId: string,
    key: string,
  ) {
    this.cipher = authCipher(key);
  }
  private actor(actor: WriteActor): void {
    if (
      !Number.isSafeInteger(actor.employeeId) ||
      actor.employeeId < 1 ||
      !/^\+[1-9]\d{7,14}$/.test(actor.phoneE164) ||
      !(/^[1-9]\d{7,14}@s\.whatsapp\.net$/.test(actor.chatId) || /^[\w.-]+@lid$/.test(actor.chatId))
    )
      throw new WriteStorageError('WRITE_ACCESS_DENIED');
    if (
      actor.chatId.endsWith('@s.whatsapp.net') &&
      actor.chatId !== `${actor.phoneE164.slice(1)}@s.whatsapp.net`
    )
      throw new WriteStorageError('WRITE_ACCESS_DENIED');
  }
  private async tx<T>(ctx: WriteCommandContext, work: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    let destroy = false;
    try {
      await db.query('BEGIN');
      await db.query("SET LOCAL lock_timeout='1000ms'");
      await db.query("SET LOCAL statement_timeout='4000ms'");
      await db.query("SET LOCAL idle_in_transaction_session_timeout='6000ms'");
      await this.fence(db, ctx);
      const result = await work(db);
      await this.fence(db, ctx);
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
  private async fence(db: PoolClient, ctx: WriteCommandContext): Promise<Row> {
    this.actor(ctx);
    if (
      !uuid(ctx.runId) ||
      !uuid(ctx.leaseToken) ||
      !uuid(ctx.sourceMessageId) ||
      !Number.isFinite(ctx.requestTimeMs)
    )
      throw new WriteStorageError('WRITE_LEASE_LOST');
    const row = (
      await db.query(
        `SELECT m.* FROM public."ramesh-messages" m JOIN public."ramesh-inbound-queue" q ON q.message_id=m.id AND q.account_id=m.account_id
      WHERE m.id=$1 AND m.account_id=$2 AND m.chat_id=$3 AND m.origin='whatsapp' AND m.state='PROCESSING' AND m.expires_at>clock_timestamp()
      AND q.state='LEASED' AND q.lease_token=$4 AND q.lease_until>clock_timestamp() AND q.batch_parent IS NULL FOR UPDATE OF m,q`,
        [ctx.runId, this.accountId, ctx.chatId, ctx.leaseToken],
      )
    ).rows[0];
    if (!row) throw new WriteStorageError('WRITE_LEASE_LOST');
    return row;
  }
  private decodeSource(row: Row, currentTurn: boolean): WriteSourceMessage | null {
    if (currentTurn && row.payload_encrypted) {
      const payload = this.cipher.open('message', row.id, row.payload_encrypted);
      if (!Buffer.isBuffer(payload) && !(payload instanceof Uint8Array))
        throw new WriteStorageError('WRITE_SOURCE_INVALID');
      const message = proto.WebMessageInfo.decode(payload);
      if (!message.key) return null;
      const candidate = toInboxCandidate(message as WAMessage, []);
      if (!candidate || candidate.fromMe || candidate.isGroup || candidate.chatId !== row.chat_id)
        return null;
      return {
        id: row.id,
        text: candidate.text ?? '',
        kind: candidate.kind ?? 'text',
        receivedAtMs: row.created_at.getTime(),
        currentTurn,
        forwarded: candidate.forwarded === true,
        ...(candidate.location ? { location: candidate.location } : {}),
      };
    }
    if (!row.content_encrypted) return null;
    const content = this.cipher.open('inbox', row.id, row.content_encrypted) as InboxContent;
    if (
      !content ||
      typeof content.text !== 'string' ||
      content.senderId !== row.chat_id ||
      typeof content.kind !== 'string'
    )
      return null;
    return {
      id: row.id,
      text: content.text,
      kind: content.kind,
      receivedAtMs: row.created_at.getTime(),
      currentTurn: false,
      forwarded: null,
      ...(content.location ? { location: content.location } : {}),
    };
  }
  private async source(db: PoolClient, ctx: WriteCommandContext): Promise<WriteSourceMessage> {
    const row = (
      await db.query(
        `SELECT m.* FROM public."ramesh-messages" m JOIN public."ramesh-inbound-queue" q ON q.message_id=m.id AND q.account_id=m.account_id
      WHERE m.id=$1 AND m.account_id=$2 AND m.chat_id=$3 AND m.origin='whatsapp' AND m.expires_at>clock_timestamp() AND (m.id=$4 OR q.batch_parent=$4)`,
        [ctx.sourceMessageId, this.accountId, ctx.chatId, ctx.runId],
      )
    ).rows[0];
    const source = row ? this.decodeSource(row, true) : null;
    if (
      !source ||
      source.forwarded !== false ||
      !['text', 'audio', 'image', 'video', 'document'].includes(source.kind)
    )
      throw new WriteStorageError('WRITE_DIRECT_SOURCE_REQUIRED');
    return source;
  }
  async authorizeSource(ctx: WriteCommandContext): Promise<WriteSourceMessage> {
    return this.tx(ctx, (db) => this.source(db, ctx));
  }
  async readSources(
    ctx: WriteCommandContext,
    ids?: readonly string[],
  ): Promise<WriteSourceMessage[]> {
    if (ids && (ids.length > 32 || ids.some((id) => !uuid(id))))
      throw new WriteStorageError('WRITE_SOURCE_LIMIT');
    return this.tx(ctx, async (db) => {
      const rows = (
        await db.query(
          `SELECT m.*, (m.id=$4 OR q.batch_parent=$4) AS current_turn FROM public."ramesh-messages" m
        LEFT JOIN public."ramesh-inbound-queue" q ON q.message_id=m.id AND q.account_id=m.account_id
        WHERE m.account_id=$1 AND m.chat_id=$2 AND m.origin='whatsapp' AND m.created_at>clock_timestamp()-interval '24 hours'
        AND ($3::uuid[] IS NULL OR m.id=ANY($3::uuid[]))
        AND (m.queue_order <= (SELECT max(mm.queue_order) FROM public."ramesh-messages" mm JOIN public."ramesh-inbound-queue" qq ON qq.message_id=mm.id WHERE mm.account_id=$1 AND (mm.id=$4 OR qq.batch_parent=$4)))
        ORDER BY m.queue_order DESC LIMIT 32`,
          [this.accountId, ctx.chatId, ids ? [...ids] : null, ctx.runId],
        )
      ).rows;
      const sources: WriteSourceMessage[] = [];
      let bytes = 0;
      for (const row of rows) {
        const source = this.decodeSource(row, row.current_turn === true);
        if (!source) continue;
        const size = Buffer.byteLength(JSON.stringify(source));
        if (bytes + size > 32000) continue;
        bytes += size;
        sources.push(source);
      }
      return sources.reverse();
    });
  }
  private codeHash(actor: WriteActor, code: string): string {
    return sha(
      JSON.stringify([
        this.accountId,
        actor.employeeId,
        actor.phoneE164,
        actor.chatId,
        code.toUpperCase(),
      ]),
    );
  }
  private operation(row: Row): WriteOperation {
    const envelope = this.cipher.open(
      `write-payload:${this.accountId}:${row.owner_employee_id}`,
      row.id,
      row.payload_encrypted,
    ) as { payload: WriteProposalPayload; confirmationCode: string };
    if (!envelope?.payload || !/^[A-F0-9]{8}$/.test(envelope.confirmationCode))
      throw new WriteStorageError('WRITE_STORAGE_INVALID');
    return {
      operationId: row.id,
      accountId: row.account_id,
      employeeId: row.owner_employee_id,
      phoneE164: row.phone_e164,
      chatId: row.chat_id,
      state: row.state,
      version: row.version,
      payload: envelope.payload,
      confirmationCode: envelope.confirmationCode,
      proposalRunId: row.proposal_run_id,
      sourceMessageId: row.source_message_id,
      approvalRunId: row.approval_run_id,
      approvalSourceMessageId: row.approval_source_message_id,
      deliveryMode: row.delivery_mode,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
      dispatchAttempts: row.dispatch_attempts,
      hasUncertainAttempt: row.has_uncertain_attempt,
      ...(row.result_encrypted
        ? {
            result: this.cipher.open(
              `write-result:${this.accountId}:${row.owner_employee_id}`,
              row.id,
              row.result_encrypted,
            ) as WriteAttemptResult,
          }
        : {}),
    };
  }
  private async owned(
    db: Pick<PoolClient, 'query'>,
    actor: WriteActor,
    id: string,
    lock = false,
  ): Promise<Row | null> {
    this.actor(actor);
    if (!uuid(id)) return null;
    return (
      (
        await db.query(
          `SELECT * FROM public."ramesh-write-operations" WHERE id=$1 AND account_id=$2 AND owner_employee_id=$3 AND phone_e164=$4 AND chat_id=$5 ${lock ? 'FOR UPDATE' : ''}`,
          [id, this.accountId, actor.employeeId, actor.phoneE164, actor.chatId],
        )
      ).rows[0] ?? null
    );
  }
  private async required(
    db: PoolClient,
    ctx: WriteCommandContext,
    id: string,
    version: number,
  ): Promise<Row> {
    const row = await this.owned(db, ctx, id, true);
    if (!row) throw new WriteStorageError('WRITE_NOT_FOUND');
    if (!Number.isSafeInteger(version) || row.version !== version)
      throw new WriteStorageError('WRITE_VERSION_CONFLICT');
    return row;
  }
  private async event(
    db: PoolClient,
    ctx: WriteCommandContext,
    row: Row,
    before: WriteOperation | null,
    kind: string,
  ): Promise<WriteOperation> {
    const after = this.operation(row);
    await appendWriteAudit(db, this.cipher, this.accountId, ctx, {
      operationId: row.id,
      sourceFamily: after.payload.sourceFamily ?? 'business',
      kind,
      runId: ctx.runId,
      sourceMessageId: ctx.sourceMessageId,
      operationVersion: row.version,
      before,
      after,
    });
    return after;
  }
  private async transition(
    db: PoolClient,
    ctx: WriteCommandContext,
    row: Row,
    state: WriteState,
    kind: string,
    extra?: {
      approval?: boolean;
      dispatchToken?: string;
      uncertain?: boolean;
      result?: WriteAttemptResult;
    },
  ): Promise<WriteOperation> {
    const before = this.operation(row);
    const updated = (
      await db.query(
        `UPDATE public."ramesh-write-operations" SET state=$2,version=version+1,updated_at=clock_timestamp(),published_version=CASE WHEN $2='PROPOSED' THEN version+1 ELSE published_version END,
      approval_run_id=CASE WHEN $3 THEN $4 ELSE approval_run_id END,approval_source_message_id=CASE WHEN $3 THEN $5 ELSE approval_source_message_id END,
      dispatch_token=$6,dispatch_until=CASE WHEN $6::uuid IS NULL THEN NULL ELSE clock_timestamp()+interval '90 seconds' END,
      dispatch_attempts=dispatch_attempts+CASE WHEN $6::uuid IS NULL THEN 0 ELSE 1 END,has_uncertain_attempt=COALESCE($7,has_uncertain_attempt),result_encrypted=COALESCE($8,result_encrypted)
      WHERE id=$1 RETURNING *`,
        [
          row.id,
          state,
          extra?.approval ?? false,
          ctx.runId,
          ctx.sourceMessageId,
          extra?.dispatchToken ?? null,
          extra?.uncertain ?? null,
          extra?.result
            ? this.cipher.seal(
                `write-result:${this.accountId}:${ctx.employeeId}`,
                row.id,
                jsonCopy(extra.result, 200000),
              )
            : null,
        ],
      )
    ).rows[0];
    return this.event(db, ctx, updated, before, kind);
  }
  async propose(ctx: WriteCommandContext, payload: WriteProposalPayload): Promise<WriteOperation> {
    const input = jsonCopy(payload, 180000);
    if (
      !input ||
      typeof input.toolName !== 'string' ||
      !/^[A-Za-z][\w.-]{0,127}$/.test(input.toolName) ||
      !input.toolSchema ||
      typeof input.toolSchema !== 'object' ||
      Array.isArray(input.toolSchema) ||
      !input.arguments ||
      typeof input.arguments !== 'object' ||
      Array.isArray(input.arguments) ||
      !/^[A-Za-z][\w]{0,63}$/.test(input.idempotencyArgument) ||
      (input.executionMode !== undefined &&
        !['direct_request', 'confirmation'].includes(input.executionMode)) ||
      typeof input.summary !== 'string' ||
      !input.summary.trim() ||
      input.summary.length > 5000 ||
      (input.sourceFamily !== undefined && !/^[\w.-]{1,64}$/.test(input.sourceFamily))
    )
      throw new WriteStorageError('WRITE_INVALID_PAYLOAD');
    if (
      (input.parentOperationId !== undefined) !== (input.parentExpectedVersion !== undefined) ||
      (input.parentOperationId &&
        (!uuid(input.parentOperationId) ||
          !Number.isSafeInteger(input.parentExpectedVersion) ||
          !input.reason?.trim() ||
          input.reason.length > 2000))
    )
      throw new WriteStorageError('WRITE_INVALID_CORRECTION');
    delete input.arguments[input.idempotencyArgument];
    const fingerprint = sha(canonical(input));
    return this.tx(ctx, async (db) => {
      await this.source(db, ctx);
      const old = (
        await db.query(
          `SELECT * FROM public."ramesh-write-operations" WHERE account_id=$1 AND proposal_run_id=$2 FOR UPDATE`,
          [this.accountId, ctx.runId],
        )
      ).rows[0];
      if (old) {
        if (
          old.owner_employee_id !== ctx.employeeId ||
          old.phone_e164 !== ctx.phoneE164 ||
          old.chat_id !== ctx.chatId
        )
          throw new WriteStorageError('WRITE_ACCESS_DENIED');
        if (old.fingerprint === fingerprint) return this.operation(old);
        if (old.state !== 'DRAFT' || old.dispatch_attempts !== 0)
          throw new WriteStorageError('WRITE_PROPOSAL_CONFLICT');
        if (old.expires_at.getTime() <= Date.now())
          return this.transition(db, ctx, old, 'EXPIRED', 'expired');
        if (input.parentOperationId) {
          const parent = await this.required(
            db,
            ctx,
            input.parentOperationId,
            input.parentExpectedVersion!,
          );
          if (parent.state !== 'SUCCEEDED') throw new WriteStorageError('WRITE_PARENT_UNRESOLVED');
        }
        const code = randomBytes(4).toString('hex').toUpperCase();
        input.arguments[input.idempotencyArgument] = old.id;
        const revised = (
          await db.query(
            `UPDATE public."ramesh-write-operations" SET fingerprint=$2,code_hash=$3,payload_encrypted=$4,parent_operation_id=$5,parent_expected_version=$6,source_message_id=$7,version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,
            [
              old.id,
              fingerprint,
              this.codeHash(ctx, code),
              this.cipher.seal(`write-payload:${this.accountId}:${ctx.employeeId}`, old.id, {
                payload: input,
                confirmationCode: code,
              }),
              input.parentOperationId ?? null,
              input.parentExpectedVersion ?? null,
              ctx.sourceMessageId,
            ],
          )
        ).rows[0];
        return this.event(db, ctx, revised, this.operation(old), 'draft_revised');
      }
      if (input.parentOperationId) {
        const parent = await this.required(
          db,
          ctx,
          input.parentOperationId,
          input.parentExpectedVersion!,
        );
        if (parent.state !== 'SUCCEEDED') throw new WriteStorageError('WRITE_PARENT_UNRESOLVED');
      }
      const id = randomUUID(),
        code = randomBytes(4).toString('hex').toUpperCase();
      input.arguments[input.idempotencyArgument] = id;
      const row = (
        await db.query(
          `INSERT INTO public."ramesh-write-operations"(id,account_id,owner_employee_id,phone_e164,chat_id,proposal_run_id,source_message_id,state,fingerprint,code_hash,payload_encrypted,parent_operation_id,parent_expected_version,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,'DRAFT',$8,$9,$10,$11,$12,clock_timestamp()+interval '1 hour') RETURNING *`,
          [
            id,
            this.accountId,
            ctx.employeeId,
            ctx.phoneE164,
            ctx.chatId,
            ctx.runId,
            ctx.sourceMessageId,
            fingerprint,
            this.codeHash(ctx, code),
            this.cipher.seal(`write-payload:${this.accountId}:${ctx.employeeId}`, id, {
              payload: input,
              confirmationCode: code,
            }),
            input.parentOperationId ?? null,
            input.parentExpectedVersion ?? null,
          ],
        )
      ).rows[0];
      return this.event(db, ctx, row, null, 'drafted');
    });
  }
  async findByRun(ctx: WriteCommandContext): Promise<WriteOperation | null> {
    return this.tx(ctx, async (db) => {
      const row = (
        await db.query(
          `SELECT * FROM public."ramesh-write-operations" WHERE account_id=$1 AND proposal_run_id=$2 AND owner_employee_id=$3 AND phone_e164=$4 AND chat_id=$5`,
          [this.accountId, ctx.runId, ctx.employeeId, ctx.phoneE164, ctx.chatId],
        )
      ).rows[0];
      return row ? this.operation(row) : null;
    });
  }
  async publish(
    ctx: WriteCommandContext,
    id: string,
    expectedVersion: number,
  ): Promise<WriteOperation> {
    return this.tx(ctx, async (db) => {
      await this.source(db, ctx);
      const row = await this.required(db, ctx, id, expectedVersion);
      if (row.proposal_run_id !== ctx.runId || row.state !== 'DRAFT')
        throw new WriteStorageError('WRITE_STATE_CONFLICT');
      if (row.expires_at.getTime() <= Date.now())
        return this.transition(db, ctx, row, 'EXPIRED', 'expired');
      return this.transition(db, ctx, row, 'PROPOSED', 'published');
    });
  }
  /** Called only after independent review of the current direct request and exact staged arguments. */
  async approveDirect(
    ctx: WriteCommandContext,
    id: string,
    expectedVersion: number,
  ): Promise<WriteOperation> {
    return this.tx(ctx, async (db) => {
      const source = await this.source(db, ctx);
      const row = await this.required(db, ctx, id, expectedVersion);
      if (
        row.proposal_run_id !== ctx.runId ||
        row.source_message_id !== ctx.sourceMessageId ||
        row.state !== 'DRAFT' ||
        this.operation(row).payload.executionMode !== 'direct_request' ||
        (source.kind !== 'audio' && !source.text.trim())
      )
        throw new WriteStorageError('WRITE_DIRECT_REQUEST_REQUIRED');
      if (row.expires_at.getTime() <= Date.now())
        return this.transition(db, ctx, row, 'EXPIRED', 'expired');
      return this.transition(db, ctx, row, 'APPROVED', 'direct_request_approved', {
        approval: true,
      });
    });
  }
  async findByCode(
    actor: WriteActor,
    code: string,
    ctx: WriteCommandContext,
  ): Promise<WriteOperation | null> {
    this.actor(actor);
    if (
      actor.employeeId !== ctx.employeeId ||
      actor.phoneE164 !== ctx.phoneE164 ||
      actor.chatId !== ctx.chatId
    )
      throw new WriteStorageError('WRITE_ACCESS_DENIED');
    if (!/^[a-f0-9]{8}$/i.test(code)) return null;
    return this.tx(ctx, async (db) => {
      const row = (
        await db.query(
          `SELECT * FROM public."ramesh-write-operations" WHERE account_id=$1 AND owner_employee_id=$2 AND phone_e164=$3 AND chat_id=$4 AND code_hash=$5`,
          [
            this.accountId,
            actor.employeeId,
            actor.phoneE164,
            actor.chatId,
            this.codeHash(actor, code),
          ],
        )
      ).rows[0];
      return row ? this.operation(row) : null;
    });
  }
  private async confirmation(
    db: PoolClient,
    ctx: WriteCommandContext,
    row: Row,
    actions: readonly string[],
    code?: string,
  ): Promise<void> {
    const source = await this.source(db, ctx);
    const match =
      source.kind === 'text'
        ? /^(confirm|cancel|retry) ([A-F0-9]{8})$/i.exec(source.text.trim())
        : null;
    if (
      !match ||
      !actions.includes(match[1]!.toLowerCase()) ||
      this.codeHash(ctx, match[2]!) !== row.code_hash ||
      (code !== undefined && match[2]!.toUpperCase() !== code.toUpperCase())
    )
      throw new WriteStorageError('WRITE_CONFIRMATION_REQUIRED');
    if (ctx.runId === row.proposal_run_id)
      throw new WriteStorageError('WRITE_LATER_CONFIRMATION_REQUIRED');
    // The durable approved transition records this proof before ordinary inbox cleanup.
    if (row.approval_run_id) return;
    const delivered = await db.query(
      `SELECT business_evidence_encrypted,reply_encrypted,reply_kind FROM public."ramesh-messages" WHERE id=$1 AND account_id=$2 AND chat_id=$3 AND origin='whatsapp' AND state='SENT' AND finished_at <= (SELECT created_at FROM public."ramesh-messages" WHERE id=$4 AND account_id=$2)`,
      [row.proposal_run_id, this.accountId, ctx.chatId, ctx.sourceMessageId],
    );
    if (!delivered.rowCount) throw new WriteStorageError('WRITE_PROPOSAL_NOT_DELIVERED');
    try {
      const message = delivered.rows[0]!;
      const bundle = this.cipher.open(
        'business-delivery',
        row.proposal_run_id,
        message.business_evidence_encrypted,
      ) as {
        kind?: string;
        version?: number;
        write?: {
          kind?: string;
          version?: number;
          employeeId?: number;
          phoneE164?: string;
          chatId?: string;
          runId?: string;
          operations?: Array<{ id?: string; version?: number }>;
        };
      };
      const proof = bundle?.write;
      const reply = decodeReply(
        this.cipher.open('outbound-reply', row.proposal_run_id, message.reply_encrypted),
        message.reply_kind,
      );
      if (
        bundle.kind !== 'write_bundle' ||
        bundle.version !== 1 ||
        proof?.kind !== 'business_write' ||
        proof.version !== 1 ||
        proof.employeeId !== ctx.employeeId ||
        proof.phoneE164 !== ctx.phoneE164 ||
        proof.chatId !== ctx.chatId ||
        proof.runId !== row.proposal_run_id ||
        !Array.isArray(proof.operations) ||
        !proof.operations.some((op) => op.id === row.id && op.version === row.published_version) ||
        !reply.text
          .split(/\r?\n/)
          .some((line) => line.trim() === `confirm ${this.operation(row).confirmationCode}`)
      )
        throw new Error();
    } catch {
      throw new WriteStorageError('WRITE_PROPOSAL_NOT_DELIVERED');
    }
  }
  async approve(
    ctx: WriteCommandContext,
    id: string,
    expectedVersion: number,
    code: string,
  ): Promise<WriteOperation> {
    return this.tx(ctx, async (db) => {
      const row = await this.required(db, ctx, id, expectedVersion);
      await this.confirmation(db, ctx, row, ['confirm'], code);
      if (row.state !== 'PROPOSED') throw new WriteStorageError('WRITE_STATE_CONFLICT');
      if (row.expires_at.getTime() <= Date.now())
        return this.transition(db, ctx, row, 'EXPIRED', 'expired');
      return this.transition(db, ctx, row, 'APPROVED', 'approved', { approval: true });
    });
  }
  async claim(
    ctx: WriteCommandContext,
    id: string,
    expectedVersion: number,
  ): Promise<WriteDispatchClaim | null> {
    return this.tx(ctx, async (db) => {
      const row = await this.required(db, ctx, id, expectedVersion);
      if (
        row.proposal_run_id === ctx.runId &&
        row.approval_run_id === ctx.runId &&
        row.source_message_id === ctx.sourceMessageId &&
        row.approval_source_message_id === ctx.sourceMessageId &&
        this.operation(row).payload.executionMode === 'direct_request'
      ) {
        // A restarted inbound run may recover only its already reviewed, frozen operation.
        await this.source(db, ctx);
      } else await this.confirmation(db, ctx, row, ['confirm', 'retry']);
      if (!['APPROVED', 'UNKNOWN', 'DISPATCHING'].includes(row.state))
        throw new WriteStorageError('WRITE_STATE_CONFLICT');
      if (row.state === 'DISPATCHING' && row.dispatch_until.getTime() > Date.now()) return null;
      if (
        row.expires_at.getTime() <= Date.now() &&
        ['UNKNOWN', 'DISPATCHING'].includes(row.state)
      ) {
        const payload = this.operation(row).payload;
        // A lost quota-rejection response may look uncertain here while Gmail
        // storage permits another POST. An expired mail approval cannot retry
        // the write endpoint, even for apparent recovery. Keep uncertainty intact.
        if (payload.toolName === 'create_email_draft' && payload.sourceFamily === 'mail')
          return null;
      }
      if (
        row.expires_at.getTime() <= Date.now() &&
        row.state === 'APPROVED' &&
        !row.has_uncertain_attempt
      ) {
        await this.transition(db, ctx, row, 'EXPIRED', 'expired');
        return null;
      }
      // Retrying uncertain work is safe only with the same durable operation and frozen arguments.
      const token = randomUUID();
      const operation = await this.transition(db, ctx, row, 'DISPATCHING', 'dispatch_claimed', {
        dispatchToken: token,
        uncertain:
          row.has_uncertain_attempt || row.state === 'DISPATCHING' || row.state === 'UNKNOWN',
      });
      return { operation, dispatchToken: token };
    });
  }
  async finish(
    ctx: WriteCommandContext,
    id: string,
    dispatchToken: string,
    result: WriteAttemptResult,
  ): Promise<WriteOperation> {
    const bounded = jsonCopy(result, 200000);
    if (
      !uuid(dispatchToken) ||
      bounded.operation_id !== id ||
      ![
        'created',
        'updated',
        'replayed',
        'not_dispatched',
        'rejected',
        'rolled_back',
        'outcome_unknown',
      ].includes(bounded.outcome) ||
      typeof bounded.code !== 'string' ||
      bounded.code.length > 128 ||
      typeof bounded.message !== 'string' ||
      bounded.message.length > 4000
    )
      throw new WriteStorageError('WRITE_RESULT_INVALID');
    return this.tx(ctx, async (db) => {
      const row = await this.owned(db, ctx, id, true);
      if (!row) throw new WriteStorageError('WRITE_NOT_FOUND');
      if (row.state !== 'DISPATCHING' || row.dispatch_token !== dispatchToken)
        throw new WriteStorageError('WRITE_DISPATCH_LOST');
      const success = ['created', 'updated', 'replayed', 'rolled_back'].includes(bounded.outcome);
      const uncertain =
        !success && (row.has_uncertain_attempt || bounded.outcome === 'outcome_unknown');
      const state: WriteState = success
        ? 'SUCCEEDED'
        : uncertain
          ? 'UNKNOWN'
          : bounded.outcome === 'not_dispatched'
            ? 'APPROVED'
            : 'REJECTED';
      return this.transition(db, ctx, row, state, 'dispatch_result', {
        result: bounded,
        uncertain,
      });
    });
  }
  async cancel(
    ctx: WriteCommandContext,
    id: string,
    expectedVersion: number,
    code?: string,
  ): Promise<WriteOperation> {
    return this.tx(ctx, async (db) => {
      const row = await this.required(db, ctx, id, expectedVersion);
      if (row.state === 'DRAFT' && row.proposal_run_id === ctx.runId && code === undefined)
        await this.source(db, ctx);
      else await this.confirmation(db, ctx, row, ['cancel'], code);
      if (!['DRAFT', 'PROPOSED', 'APPROVED'].includes(row.state) || row.has_uncertain_attempt)
        throw new WriteStorageError('WRITE_CANNOT_CANCEL_DISPATCHED');
      return this.transition(db, ctx, row, 'CANCELLED', 'cancelled');
    });
  }
  async receiptLookup(actor: WriteActor, id: string): Promise<WriteOperation | null> {
    const row = await this.owned(this.pool, actor, id);
    return row ? this.operation(row) : null;
  }
  async listRecent(actor: WriteActor, limit = 10): Promise<WriteOperation[]> {
    this.actor(actor);
    if (!Number.isInteger(limit) || limit < 1 || limit > 10)
      throw new WriteStorageError('WRITE_HISTORY_LIMIT');
    return (
      await this.pool.query(
        `SELECT * FROM public."ramesh-write-operations" WHERE account_id=$1 AND owner_employee_id=$2 AND phone_e164=$3 AND chat_id=$4 ORDER BY created_at DESC,id DESC LIMIT $5`,
        [this.accountId, actor.employeeId, actor.phoneE164, actor.chatId, limit],
      )
    ).rows.map((row) => this.operation(row));
  }
  async auditRecent(actor: WriteActor, limit = 10): Promise<WriteAuditRecord[]> {
    this.actor(actor);
    if (!Number.isInteger(limit) || limit < 1 || limit > 10)
      throw new WriteStorageError('WRITE_HISTORY_LIMIT');
    return (
      await this.pool.query(
        `SELECT * FROM public."ramesh-write-events" WHERE account_id=$1 AND owner_employee_id=$2 AND phone_e164=$3 AND chat_id=$4 ORDER BY created_at DESC,id DESC LIMIT $5`,
        [this.accountId, actor.employeeId, actor.phoneE164, actor.chatId, limit],
      )
    ).rows.map((row) => {
      const payload = this.cipher.open(
        `write-audit:${this.accountId}:${actor.employeeId}`,
        row.id,
        row.payload_encrypted,
      ) as { before: unknown; after: unknown };
      return {
        eventId: row.id,
        operationId: row.operation_id,
        personalCommandId: row.personal_command_id,
        sourceFamily: row.source_family,
        kind: row.kind,
        actorType: row.actor_type,
        employeeId: row.owner_employee_id,
        runId: row.run_id,
        createdAt: row.created_at.toISOString(),
        ...payload,
      };
    });
  }
}
