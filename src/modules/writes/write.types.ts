/** Durable business intent. Actor, leases and confirmation sources are supplied by the runtime. */
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
    | 'replayed'
    | 'not_dispatched'
    | 'rejected'
    | 'rolled_back'
    | 'outcome_unknown';
  code: string;
  message: string;
  data?: unknown;
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
