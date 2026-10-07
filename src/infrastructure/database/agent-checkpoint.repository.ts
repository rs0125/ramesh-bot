/** Encrypted model-response replay with queue ownership checked on every operation. */
import { createHmac } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Pool, PoolClient } from 'pg';
import {
  CheckpointError,
  type AgentCheckpointBegin,
  type AgentCheckpointMetadata,
  type AgentCheckpointSession,
  type AgentCheckpointStore,
} from '../../modules/assistant/checkpoint.types.js';
import { authCipher } from './auth-store.js';

export const CHECKPOINT_MAX_STEPS = 96;
export const CHECKPOINT_MAX_BYTES = 4 * 1024 * 1024;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
export const CHECKPOINT_OPERATION_LIMITS = Object.freeze({ tool: 72, web: 4, bytes: 600_000 });
const DIGEST = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

interface Step {
  requestDigest: string;
  response: unknown;
}
interface Snapshot {
  version: 1;
  bindingDigest: string;
  metadata: AgentCheckpointMetadata;
  steps: Step[];
  consumed: Record<keyof typeof CHECKPOINT_OPERATION_LIMITS, number>;
  policy: Record<string, unknown>;
}
export type AgentCheckpointOptions = {
  encryptionKey: string;
  accountId: string;
} & ({ namespace: 'production' } | { namespace: 'capture'; employeeId: number });

/** Normalize JSON object order without storing request material alongside the ciphertext. */
export function canonicalCheckpointJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined || Buffer.byteLength(json) > CHECKPOINT_MAX_BYTES)
    throw new Error('CHECKPOINT_INPUT_INVALID');
  const order = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(order)
      : item && typeof item === 'object'
        ? Object.fromEntries(
            Object.entries(item)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([name, child]) => [name, order(child)]),
          )
        : item;
  return JSON.stringify(order(JSON.parse(json)));
}

function metadataValid(value: AgentCheckpointMetadata): boolean {
  return (
    !!value &&
    [value.requestTimeMs, value.startedAtMs, value.deadlineAtMs].every(
      (number) => Number.isSafeInteger(number) && number > 0,
    ) &&
    value.deadlineAtMs > value.startedAtMs &&
    value.deadlineAtMs - value.startedAtMs <= MAX_TTL_MS
  );
}

export class AgentCheckpointRepository implements AgentCheckpointStore {
  private readonly cipher;
  private readonly digestKey: Buffer;
  private readonly table: string;
  private readonly category: string;
  private readonly employeeId: number;

  constructor(
    private readonly pool: Pool,
    private readonly options: AgentCheckpointOptions,
  ) {
    if (
      !options.accountId ||
      options.accountId.length > 512 ||
      !['production', 'capture'].includes(options.namespace) ||
      (options.namespace === 'capture' &&
        (!Number.isSafeInteger(options.employeeId) || options.employeeId <= 0))
    )
      throw new Error('CHECKPOINT_SCOPE_INVALID');
    this.cipher = authCipher(options.encryptionKey);
    this.digestKey = createHmac('sha256', Buffer.from(options.encryptionKey, 'base64url'))
      .update('ramesh:agent-checkpoint:request-digest:v1')
      .digest();
    this.employeeId = options.namespace === 'capture' ? options.employeeId : 0;
    this.table =
      options.namespace === 'capture'
        ? 'public."ramesh-test-agent-checkpoints"'
        : 'public."ramesh-agent-checkpoints"';
    this.category = `agent-checkpoint:${options.namespace}:${options.accountId}:${this.employeeId}`;
  }

  private digest(value: unknown): string {
    return createHmac('sha256', this.digestKey)
      .update(canonicalCheckpointJson(value))
      .digest('hex');
  }

  private decode(jobId: string, encrypted: string): Snapshot {
    if (Buffer.byteLength(encrypted) > CHECKPOINT_MAX_BYTES)
      throw new Error('CHECKPOINT_PAYLOAD_INVALID');
    const snapshot = this.cipher.open(this.category, jobId, encrypted) as Snapshot;
    if (
      !snapshot ||
      snapshot.version !== 1 ||
      !DIGEST.test(snapshot.bindingDigest) ||
      !metadataValid(snapshot.metadata) ||
      !Array.isArray(snapshot.steps) ||
      snapshot.steps.length > CHECKPOINT_MAX_STEPS ||
      snapshot.steps.some(
        (step) => !step || !DIGEST.test(step.requestDigest) || step.response === undefined,
      ) ||
      !snapshot.consumed ||
      Object.entries(CHECKPOINT_OPERATION_LIMITS).some(([name, limit]) => {
        const value = snapshot.consumed[name as keyof typeof CHECKPOINT_OPERATION_LIMITS];
        return !Number.isSafeInteger(value) || value < 0 || value > limit;
      }) ||
      !snapshot.policy ||
      typeof snapshot.policy !== 'object' ||
      Array.isArray(snapshot.policy) ||
      Object.keys(snapshot.policy).length > 48
    )
      throw new Error('CHECKPOINT_PAYLOAD_INVALID');
    return snapshot;
  }

  private async guard<T>(work: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await work();
      } catch (error) {
        const pgCode =
          error && typeof error === 'object' && 'code' in error ? error.code : undefined;
        // These PostgreSQL failures roll back the transaction. Retry the checkpoint,
        // retaining live evidence; never replay an ambiguous commit or remote action.
        const transient = ['55P03', '40P01', '40001'].includes(String(pgCode));
        if (transient && attempt < 2) {
          await delay(50 * (attempt + 1));
          continue;
        }
        const message = error instanceof Error ? error.message : '';
        const known =
          /^(?:CHECKPOINT_(?:SCOPE_INVALID|OWNER_INVALID|CLOCK_INVALID|PAYLOAD_INVALID|INPUT_INVALID|SEQUENCE_INVALID|SEQUENCE_GAP|RESPONSE_INVALID|CONSUMPTION_INVALID|POLICY_INVALID|POLICY_CAPACITY_EXCEEDED|LEASE_EXPIRED|EXPIRED|BINDING_CHANGED|CAPACITY_EXCEEDED))$/;
        throw new CheckpointError(
          transient
            ? `CHECKPOINT_DB_${pgCode}`
            : known.test(message)
              ? message
              : 'CHECKPOINT_OPERATION_FAILED',
        );
      }
    }
  }

  private async transaction<T>(work: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    let destroy = false;
    try {
      await db.query('BEGIN');
      await db.query("SET LOCAL lock_timeout='2000ms'");
      await db.query("SET LOCAL idle_in_transaction_session_timeout='6000ms'");
      // Queue recovery/handoff can lock messages before queue rows. Take its same
      // short transaction lock before either relation to prevent a lock-order cycle.
      // Capture operations lock only the inbound row first, matching owned() below.
      if (this.options.namespace === 'production')
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `ramesh:queue:${this.options.accountId}`,
        ]);
      await db.query(
        `SELECT set_config('ramesh.checkpoint_account',$1,true),set_config('ramesh.checkpoint_employee',$2,true)`,
        [this.options.accountId, String(this.employeeId)],
      );
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

  /** The queue row lock fences both lease replacement and checkpoint mutation. */
  private async owned(db: PoolClient, input: Pick<AgentCheckpointBegin, 'jobId' | 'leaseToken'>) {
    const row =
      this.options.namespace === 'capture'
        ? (
            await db.query<{ expires_at: Date; owner_binding: string[] }>(
              `SELECT expires_at,ARRAY[conversation,sender,audience] AS owner_binding FROM public."ramesh-test-inbound-queue"
               WHERE id=$1 AND namespace=$2 AND employee_id=$4 AND state='PROCESSING'
               AND lease_token=$3 AND lease_until>clock_timestamp() AND expires_at>clock_timestamp()
               FOR UPDATE`,
              [input.jobId, this.options.accountId, input.leaseToken, this.employeeId],
            )
          ).rows[0]
        : (
            await db.query<{ expires_at: Date; owner_binding: string[] }>(
              `SELECT m.expires_at,ARRAY[m.chat_id,j.sender_key] AS owner_binding FROM public."ramesh-inbound-queue" j
               JOIN public."ramesh-messages" m ON m.id=j.message_id AND m.account_id=j.account_id
               WHERE j.message_id=$1 AND j.account_id=$2 AND j.state='LEASED' AND m.state='PROCESSING'
               AND j.lease_token=$3 AND j.lease_until>clock_timestamp() AND m.expires_at>clock_timestamp()
               FOR UPDATE OF j,m`,
              [input.jobId, this.options.accountId, input.leaseToken],
            )
          ).rows[0];
    if (!row) throw new Error('CHECKPOINT_LEASE_EXPIRED');
    return { expiresAt: row.expires_at.getTime(), binding: row.owner_binding };
  }

  private async readSnapshot(db: PoolClient, jobId: string) {
    const row = (
      await db.query<{ payload_encrypted: string; expires_at: Date }>(
        `SELECT payload_encrypted,expires_at FROM ${this.table}
         WHERE message_id=$1 AND account_id=$2 AND employee_id=$3 FOR UPDATE`,
        [jobId, this.options.accountId, this.employeeId],
      )
    ).rows[0];
    return row
      ? { snapshot: this.decode(jobId, row.payload_encrypted), expiresAt: row.expires_at }
      : undefined;
  }

  private async writeSnapshot(
    db: PoolClient,
    jobId: string,
    snapshot: Snapshot,
    expiresAt: number,
  ) {
    const encrypted = this.cipher.seal(this.category, jobId, snapshot);
    if (Buffer.byteLength(encrypted) > CHECKPOINT_MAX_BYTES)
      throw new Error('CHECKPOINT_CAPACITY_EXCEEDED');
    await db.query(
      `INSERT INTO ${this.table} (message_id,account_id,employee_id,payload_encrypted,expires_at)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT(message_id) DO UPDATE SET
       payload_encrypted=EXCLUDED.payload_encrypted,expires_at=EXCLUDED.expires_at,updated_at=clock_timestamp()
       WHERE ${this.table.split('.')[1]}.account_id=EXCLUDED.account_id
         AND ${this.table.split('.')[1]}.employee_id=EXCLUDED.employee_id`,
      [jobId, this.options.accountId, this.employeeId, encrypted, new Date(expiresAt)],
    );
  }

  async begin(input: AgentCheckpointBegin): Promise<AgentCheckpointSession> {
    return this.guard(() => this.beginSession(input));
  }

  private async beginSession(input: AgentCheckpointBegin): Promise<AgentCheckpointSession> {
    if (!UUID.test(input.jobId) || !UUID.test(input.leaseToken))
      throw new Error('CHECKPOINT_OWNER_INVALID');
    const proposed: AgentCheckpointMetadata = {
      requestTimeMs: input.requestTimeMs,
      startedAtMs: input.startedAtMs ?? Date.now(),
      deadlineAtMs: input.deadlineAtMs,
    };
    if (!metadataValid(proposed)) throw new Error('CHECKPOINT_CLOCK_INVALID');
    const { metadata, bindingDigest } = await this.transaction(async (db) => {
      const owner = await this.owned(db, input);
      const bindingDigest = this.digest([
        this.options.namespace,
        this.options.accountId,
        this.employeeId,
        input.jobId,
        owner.binding,
        input.binding,
      ]);
      const prior = await this.readSnapshot(db, input.jobId);
      if (prior && prior.expiresAt.getTime() <= Date.now()) throw new Error('CHECKPOINT_EXPIRED');
      const snapshot: Snapshot = prior?.snapshot ?? {
        version: 1,
        bindingDigest,
        metadata: proposed,
        steps: [],
        consumed: { tool: 0, web: 0, bytes: 0 },
        policy: {},
      };
      if (snapshot.bindingDigest !== bindingDigest) {
        snapshot.bindingDigest = bindingDigest;
        snapshot.steps = [];
      }
      await this.writeSnapshot(
        db,
        input.jobId,
        snapshot,
        Math.min(owner.expiresAt, snapshot.metadata.startedAtMs + MAX_TTL_MS),
      );
      return { metadata: Object.freeze({ ...snapshot.metadata }), bindingDigest };
    });
    const operate = <T>(work: (snapshot: Snapshot) => { result: T; changed: boolean }) =>
      this.transaction(async (db) => {
        await this.owned(db, input);
        const row = await this.readSnapshot(db, input.jobId);
        if (!row || row.expiresAt.getTime() <= Date.now()) throw new Error('CHECKPOINT_EXPIRED');
        if (row.snapshot.bindingDigest !== bindingDigest)
          throw new Error('CHECKPOINT_BINDING_CHANGED');
        const { result, changed } = work(row.snapshot);
        if (changed)
          await this.writeSnapshot(db, input.jobId, row.snapshot, row.expiresAt.getTime());
        return result;
      });
    const sequenceValid = (sequence: number) => {
      if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence >= CHECKPOINT_MAX_STEPS)
        throw new Error('CHECKPOINT_SEQUENCE_INVALID');
    };
    return {
      metadata,
      read: async <T>(sequence: number, request: unknown): Promise<T | undefined> =>
        this.guard(async () => {
          sequenceValid(sequence);
          const digest = this.digest(request);
          return operate((snapshot) => {
            if (sequence > snapshot.steps.length) throw new Error('CHECKPOINT_SEQUENCE_GAP');
            const step = snapshot.steps[sequence];
            if (step?.requestDigest === digest)
              return { result: structuredClone(step.response) as T, changed: false };
            snapshot.steps.length = sequence;
            return { result: undefined, changed: !!step };
          });
        }),
      save: async (sequence, request, response) =>
        this.guard(async () => {
          sequenceValid(sequence);
          if (response === undefined) throw new Error('CHECKPOINT_RESPONSE_INVALID');
          const requestDigest = this.digest(request);
          // Validate size/JSON shape before opening the transaction, without retaining raw requests.
          canonicalCheckpointJson(response);
          await operate((snapshot) => {
            if (sequence > snapshot.steps.length) throw new Error('CHECKPOINT_SEQUENCE_GAP');
            snapshot.steps.length = sequence;
            snapshot.steps.push({ requestDigest, response });
            return { result: undefined, changed: true };
          });
        }),
      consume: async (resource, amount) =>
        this.guard(async () => {
          if (
            !Object.hasOwn(CHECKPOINT_OPERATION_LIMITS, resource) ||
            !Number.isSafeInteger(amount) ||
            amount < 0
          )
            throw new Error('CHECKPOINT_CONSUMPTION_INVALID');
          return operate((snapshot) => {
            if (amount > CHECKPOINT_OPERATION_LIMITS[resource] - snapshot.consumed[resource])
              return { result: false, changed: false };
            snapshot.consumed[resource] += amount;
            return { result: true, changed: amount > 0 };
          });
        }),
      policy: async <T>(
        key: string,
        update?: (current: T | undefined) => T,
      ): Promise<T | undefined> =>
        this.guard(async () => {
          if (
            !/^[A-Za-z0-9_:.@/-]{1,128}$/.test(key) ||
            ['__proto__', 'constructor', 'prototype'].includes(key)
          )
            throw new Error('CHECKPOINT_POLICY_INVALID');
          return operate((snapshot) => {
            const value = Object.hasOwn(snapshot.policy, key)
              ? (structuredClone(snapshot.policy[key]) as T)
              : undefined;
            if (!update) return { result: value, changed: false };
            if (!Object.hasOwn(snapshot.policy, key) && Object.keys(snapshot.policy).length >= 48)
              throw new Error('CHECKPOINT_POLICY_CAPACITY_EXCEEDED');
            const next = update(value);
            if (Buffer.byteLength(canonicalCheckpointJson(next)) > 16_384)
              throw new Error('CHECKPOINT_POLICY_CAPACITY_EXCEEDED');
            snapshot.policy[key] = next;
            return { result: structuredClone(next), changed: true };
          });
        }),
    };
  }

  /** Payload retention does not depend on another message arriving in the same conversation. */
  async clean(): Promise<void> {
    await this.guard(() =>
      this.transaction(async (db) => {
        const terminal =
          this.options.namespace === 'capture'
            ? `EXISTS(SELECT 1 FROM public."ramesh-test-inbound-queue" q WHERE q.id=c.message_id AND q.state IN ('COMPLETED','FAILED'))`
            : `EXISTS(SELECT 1 FROM public."ramesh-inbound-queue" q WHERE q.message_id=c.message_id AND q.state IN ('DONE','DEAD'))`;
        await db.query(
          `DELETE FROM ${this.table} c WHERE account_id=$1 AND employee_id=$2
         AND (expires_at<=clock_timestamp() OR ${terminal})`,
          [this.options.accountId, this.employeeId],
        );
      }),
    );
  }
}
