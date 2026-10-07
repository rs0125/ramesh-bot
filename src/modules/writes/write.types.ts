/** Durable business intent. Actor, leases and confirmation sources are supplied by the runtime. */
import type { GmailWriteRecovery } from '../context-engine/context.types.js';
export type WriteState =
  | 'DRAFT'
  | 'PROPOSED'
  | 'APPROVED'
  | 'DISPATCHING'
  | 'SUCCEEDED'
  | 'REJECTED'
  | 'UNKNOWN'
  | 'CANCELLED'
  | 'EXPIRED';
export interface WriteActor {
  employeeId: number;
  phoneE164: string;
  chatId: string;
}
export interface WriteCommandContext extends WriteActor {
  runId: string;
  leaseToken: string;
  sourceMessageId: string;
  requestTimeMs: number;
}
export interface WriteProposalPayload {
  toolName: string;
  toolSchema: Record<string, unknown>;
  toolDescription?: string;
  /** Frozen authenticated tool policy, never a model argument. Omission means confirmation. */
  executionMode?: 'direct_request' | 'confirmation';
  toolMeta?: Record<string, unknown>;
  requiredScopes?: string[];
  sourceFamily?: string;
  arguments: Record<string, unknown>;
  idempotencyArgument: string;
  summary: string;
  /** Bounded source evidence, not an instruction or transport identity assertion. */
  source: unknown;
  parentOperationId?: string;
  parentExpectedVersion?: number;
  reason?: string;
}
export interface WriteAttemptResult {
  operation_id: string;
  outcome:
    | 'created'
    | 'updated'
    | 'deleted'
    | 'replayed'
    | 'not_dispatched'
    | 'rejected'
    | 'rolled_back'
    | 'outcome_unknown';
  code: string;
  message: string;
  data?: unknown;
  recovery?: GmailWriteRecovery;
  retry_at?: string;
  meta?: unknown;
}
export interface WriteOperation extends WriteActor {
  operationId: string;
  accountId: string;
  state: WriteState;
  version: number;
  payload: WriteProposalPayload;
  confirmationCode: string;
  proposalRunId: string;
  sourceMessageId: string;
  approvalRunId: string | null;
  approvalSourceMessageId: string | null;
  /** Derived from the admitted production message, never model input. Capture has no production journal access. */
  deliveryMode: 'production';
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  dispatchAttempts: number;
  hasUncertainAttempt: boolean;
  result?: WriteAttemptResult;
}
export interface WriteDispatchClaim {
  operation: WriteOperation;
  dispatchToken: string;
}
export interface WriteRepositoryPort {
  authorizeSource(ctx: WriteCommandContext): Promise<WriteSourceMessage>;
  readSources(ctx: WriteCommandContext, ids?: readonly string[]): Promise<WriteSourceMessage[]>;
  propose(ctx: WriteCommandContext, payload: WriteProposalPayload): Promise<WriteOperation>;
  findByRun(ctx: WriteCommandContext): Promise<WriteOperation | null>;
  publish(ctx: WriteCommandContext, id: string, expectedVersion: number): Promise<WriteOperation>;
  approveDirect(
    ctx: WriteCommandContext,
    id: string,
    expectedVersion: number,
  ): Promise<WriteOperation>;
  /** Only a standalone direct recovery request for the sole unresolved approved direct operation. */
  findDirectRecovery(ctx: WriteCommandContext): Promise<WriteOperation | null>;
  findByCode(
    actor: WriteActor,
    code: string,
    ctx: WriteCommandContext,
  ): Promise<WriteOperation | null>;
  approve(
    ctx: WriteCommandContext,
    id: string,
    expectedVersion: number,
    code: string,
  ): Promise<WriteOperation>;
  claim(
    ctx: WriteCommandContext,
    id: string,
    expectedVersion: number,
  ): Promise<WriteDispatchClaim | null>;
  finish(
    ctx: WriteCommandContext,
    id: string,
    dispatchToken: string,
    result: WriteAttemptResult,
  ): Promise<WriteOperation>;
  cancel(
    ctx: WriteCommandContext,
    id: string,
    expectedVersion: number,
    code?: string,
  ): Promise<WriteOperation>;
  receiptLookup(actor: WriteActor, id: string): Promise<WriteOperation | null>;
  listRecent(actor: WriteActor, limit?: number): Promise<WriteOperation[]>;
  auditRecent(actor: WriteActor, limit?: number): Promise<WriteAuditRecord[]>;
}
export interface WriteSourceMessage {
  id: string;
  text: string;
  kind: string;
  receivedAtMs: number;
  currentTurn: boolean;
  /** Historical inbox rows did not retain forwarding metadata. Unknown must never mean direct. */
  forwarded: boolean | null;
  location?: import('../messaging/native-location.js').NativeLocation;
}
export interface WriteAuditRecord {
  eventId: string;
  operationId: string | null;
  personalCommandId: string | null;
  sourceFamily: string;
  kind: string;
  actorType: 'employee' | 'system';
  employeeId: number;
  runId: string | null;
  createdAt: string;
  before: unknown;
  after: unknown;
}
export class WriteStorageError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'WriteStorageError';
  }
}

/** Narrow runtime commands. Quoted/forwarded source text never reaches this authority boundary. */
export function directRecoveryAction(text: string): 'retry' | 'cancel' | undefined {
  const value = text.trim().toLowerCase().replace(/[.!]$/, '').trim();
  if (
    /^(?:please )?(?:retry|try again|retry (?:that|the last) (?:rfq|change|action)|try (?:that|the last) (?:rfq|change|action) again)$/.test(
      value,
    )
  )
    return 'retry';
  if (
    /^(?:please )?(?:retry (?:that|the last) draft|try (?:that|the last) draft again)$/.test(value)
  )
    return 'retry';
  if (/^(?:please )?cancel (?:that|the last) draft attempt$/.test(value)) return 'cancel';
  return undefined;
}
