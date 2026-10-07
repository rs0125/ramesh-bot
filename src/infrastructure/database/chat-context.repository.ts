/** Encrypted per-owner chat state with optimistic concurrency and inbound-lease fencing. */
import type { Pool, PoolClient } from 'pg';
import { authCipher } from './auth-store.js';
import { CheckpointError } from '../../modules/assistant/checkpoint.types.js';
import {
  contextStateSchema,
  type ContextStore,
  type ContextScope,
  type ContextLease,
  type ContextState,
} from '../../modules/assistant/chat-context.js';

export class ChatContextRepository implements ContextStore {
  private readonly cipher;
  constructor(
    private readonly pool: Pool,
    private readonly accountId: string,
    encryptionKey: string,
  ) {
    this.cipher = authCipher(encryptionKey);
  }
  private category(scope: ContextScope) {
    return `chat-context:${this.accountId}:${scope.employeeId}:${scope.owner}`;
  }
  private async transaction<T>(work: (db: PoolClient) => Promise<T>, lease?: ContextLease) {
    const db = await this.pool.connect();
    let broken = false;
    try {
      await db.query('BEGIN');
      await db.query("SET LOCAL lock_timeout='2000ms'");
      await db.query("SET LOCAL idle_in_transaction_session_timeout='6000ms'");
      await db.query("SELECT set_config('ramesh.context_account',$1,true)", [this.accountId]);
      if (lease) {
        // Same ordering as queue handoff and checkpoints, never hold locks during inference.
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `ramesh:queue:${this.accountId}`,
        ]);
        const owned = await db.query(
          `SELECT j.message_id FROM public."ramesh-inbound-queue" j
          JOIN public."ramesh-messages" m ON m.id=j.message_id AND m.account_id=j.account_id
          WHERE j.account_id=$1 AND j.message_id=$2 AND j.lease_token=$3 AND m.chat_id=$4
          AND j.state='LEASED' AND m.state='PROCESSING' AND j.lease_until>clock_timestamp()
          AND m.expires_at>clock_timestamp() FOR UPDATE OF j,m`,
          [this.accountId, lease.jobId, lease.leaseToken, lease.chatId],
        );
        if (!owned.rowCount) throw new CheckpointError();
      }
      const result = await work(db);
      await db.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await db.query('ROLLBACK');
      } catch {
        broken = true;
      }
      throw error;
    } finally {
      db.release(broken);
    }
  }
  async health() {
    await this.transaction(async (db) => {
      await db.query(
        'SELECT scope_key,owner_binding,payload_encrypted,revision FROM public."ramesh-conversation-context" LIMIT 0',
      );
    });
  }
  async load(scope: ContextScope, lease?: ContextLease) {
    if (!lease) throw new CheckpointError();
    return this.transaction(async (db) => {
      const row = (
        await db.query<{ revision: number; payload_encrypted: string }>(
          `SELECT revision,payload_encrypted FROM public."ramesh-conversation-context" WHERE account_id=$1 AND scope_key=$2 AND employee_id=$3 AND owner_binding=$4`,
          [this.accountId, scope.key, scope.employeeId, scope.owner],
        )
      ).rows[0];
      return row
        ? {
            revision: row.revision,
            state: contextStateSchema.parse(
              this.cipher.open(this.category(scope), scope.key, row.payload_encrypted),
            ),
          }
        : null;
    }, lease);
  }
  async save(
    scope: ContextScope,
    expectedRevision: number,
    state: ContextState,
    lease?: ContextLease,
  ) {
    if (!lease) throw new CheckpointError();
    const encrypted = this.cipher.seal(
      this.category(scope),
      scope.key,
      contextStateSchema.parse(state),
    );
    return this.transaction(async (db) => {
      const result =
        expectedRevision === 0
          ? await db.query(
              `INSERT INTO public."ramesh-conversation-context"(account_id,scope_key,employee_id,revision,payload_encrypted,has_pins,owner_binding) VALUES($1,$2,$3,1,$4,$5,$6)
               ON CONFLICT(account_id,scope_key) DO UPDATE SET employee_id=EXCLUDED.employee_id,revision=1,payload_encrypted=EXCLUDED.payload_encrypted,has_pins=EXCLUDED.has_pins,owner_binding=EXCLUDED.owner_binding,updated_at=clock_timestamp()
               WHERE "ramesh-conversation-context".owner_binding<>EXCLUDED.owner_binding`,
              [
                this.accountId,
                scope.key,
                scope.employeeId,
                encrypted,
                state.pins.length > 0,
                scope.owner,
              ],
            )
          : await db.query(
              `UPDATE public."ramesh-conversation-context" SET revision=revision+1,payload_encrypted=$4,has_pins=$5,updated_at=clock_timestamp() WHERE account_id=$1 AND scope_key=$2 AND employee_id=$3 AND revision=$6 AND owner_binding=$7`,
              [
                this.accountId,
                scope.key,
                scope.employeeId,
                encrypted,
                state.pins.length > 0,
                expectedRevision,
                scope.owner,
              ],
            );
      return result.rowCount === 1;
    }, lease);
  }
  async clean() {
    await this.transaction(async (db) => {
      await db.query(
        `DELETE FROM public."ramesh-conversation-context" WHERE account_id=$1 AND NOT has_pins AND updated_at<clock_timestamp()-interval '30 days'`,
        [this.accountId],
      );
      const rows = (
        await db.query<{
          scope_key: string;
          employee_id: number;
          owner_binding: string;
          revision: number;
          payload_encrypted: string;
        }>(
          `SELECT scope_key,employee_id,owner_binding,revision,payload_encrypted FROM public."ramesh-conversation-context" WHERE account_id=$1 AND has_pins AND updated_at<clock_timestamp()-interval '30 days' LIMIT 100 FOR UPDATE SKIP LOCKED`,
          [this.accountId],
        )
      ).rows;
      for (const row of rows) {
        const scope = { key: row.scope_key, owner: row.owner_binding, employeeId: row.employee_id };
        const state = contextStateSchema.parse(
          this.cipher.open(this.category(scope), scope.key, row.payload_encrypted),
        );
        state.summary = { notes: [] };
        state.summaryAt = Date.now();
        state.selections = [];
        state.businessReplies = [];
        state.command = null;
        await db.query(
          `UPDATE public."ramesh-conversation-context" SET revision=revision+1,payload_encrypted=$4,updated_at=clock_timestamp() WHERE account_id=$1 AND scope_key=$2 AND revision=$3 AND owner_binding=$5`,
          [
            this.accountId,
            scope.key,
            row.revision,
            this.cipher.seal(this.category(scope), scope.key, state),
            scope.owner,
          ],
        );
      }
    });
  }
}
