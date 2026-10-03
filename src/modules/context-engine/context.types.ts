/** Trusted application context is separate from model-visible tool arguments. */
export interface ContextSender {
  readonly phoneE164: string;
  readonly audience: 'dm' | 'group';
}

export interface EmployeeContextGrant {
  employeeId: number;
  phoneE164: string;
  active: boolean;
  accessToken: string;
  expiresAtMs: number;
}

/** Application-owned live roster + signed requests (or the optional OAuth adapter).
 * Resolve current access on every call; never return a REST API key.
 * Phone input must come from the verified transport identity, never message text or an LLM.
 */
export interface ContextCredentialResolver {
  resolve(
    sender: ContextSender,
    signal: AbortSignal,
  ): Promise<EmployeeContextGrant | EmployeeRequestGrant | null>;
  invalidate?(grant: EmployeeContextGrant): Promise<void>;
}

/** First-party service identity, bound to an employee. The signer never reaches an agent or tool argument. */
export interface EmployeeRequestGrant {
  kind: 'signed-request';
  employeeId: number;
  phoneE164: string;
  active: boolean;
  expiresAtMs: number;
  authorize(request: Request, signal: AbortSignal): Promise<Request>;
}

/** Legacy semantic validators, not the universe of admissible tools. Live MCP owns admission. */
export const CONTEXT_READ_TOOLS: Readonly<Record<string, string | null | undefined>> = {
  get_context: null,
  search_knowledge: 'knowledge:read',
  read_knowledge: 'knowledge:read',
  warehouse_filters: 'warehouses:read',
  search_warehouses: 'warehouses:read',
  warehouse_summary: 'warehouses:read',
  read_warehouse: 'warehouses:read',
  crm_filters: 'crm:read',
  search_crm_leads: 'crm:read',
  crm_summary: 'crm:read',
  read_crm_lead: 'crm:read',
  read_crm_lead_context: 'crm:read',
  crm_briefing: 'crm:read',
  assess_shortlist: 'crm:read',
  analytics_capabilities: 'analytics:read',
  ga4_report: 'analytics:read',
  search_console_report: 'analytics:read',
} as const;
export type ContextReadTool = string;
export const isContextReadTool = (name: string): boolean => Object.hasOwn(CONTEXT_READ_TOOLS, name);

/** Preserve source metadata, cursors, uncertainty and access/freshness evidence for the verifier. */
export interface ContextEvidence {
  source_path: string;
  status: 200;
  data: Record<string, unknown>;
  meta: { requestId: string; generatedAt: string; [field: string]: unknown };
  [field: string]: unknown;
}
export interface ContextToolDefinition {
  name: ContextReadTool;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
    [field: string]: unknown;
  };
  _meta?: Record<string, unknown>;
}
export interface ContextCatalogue {
  tools: ContextToolDefinition[];
  guidance?: string;
  /** Bounded orientation metadata from authenticated get_context, never caller identity input. */
  context?: Record<string, unknown>;
}
export interface ContextToolGateway {
  describe?(sender: ContextSender, signal?: AbortSignal): Promise<ContextCatalogue>;
  discover(sender: ContextSender, signal?: AbortSignal): Promise<ContextToolDefinition[]>;
  call(
    sender: ContextSender,
    name: ContextReadTool,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ContextEvidence>;
}

export type ContextErrorCode =
  | 'NOT_CONFIGURED'
  | 'AUTH_REQUIRED'
  | 'ACCESS_DENIED'
  | 'TOOL_UNAVAILABLE'
  | 'INVALID_ARGUMENTS'
  | 'INVALID_RESPONSE'
  | 'RESPONSE_TOO_LARGE'
  | 'PAGINATION_STALLED'
  | 'RATE_LIMITED'
  | 'UNAVAILABLE'
  | 'TIMEOUT'
  | 'CANCELLED';
export class ContextEngineError extends Error {
  constructor(
    readonly code: ContextErrorCode,
    readonly retryable = false,
    readonly retryAfterSeconds?: number,
    readonly recovery?: {
      sourceCode: string;
      action:
        | 'check_source_configuration'
        | 'check_google_access'
        | 'check_capabilities'
        | 'correct_query'
        | 'check_engine_access'
        | 'retry_later'
        | 'investigate_source_response';
    },
  ) {
    super(`Context Engine: ${code}`);
    this.name = 'ContextEngineError';
  }
}

/** Default remains closed unless the concrete employee credential adapter is supplied. */
export const disconnectedContextCredentials: ContextCredentialResolver = {
  async resolve() {
    return null;
  },
};

/** Separate action port. Reads, evidence replay and delivery verification never call this port. */
export interface ContextWriteResult {
  operation_id: string;
  outcome:
    | 'created'
    | 'replayed'
    | 'rolled_back'
    | 'not_dispatched'
    | 'rejected'
    | 'outcome_unknown';
  code: string;
  message: string;
  data?: Record<string, unknown>;
  meta?: { toolName: string; argumentsSha256: string; employeeId: number };
}
export interface ContextWriteGateway {
  discoverWrites(sender: ContextSender, signal?: AbortSignal): Promise<ContextToolDefinition[]>;
  describeWrites(sender: ContextSender, signal?: AbortSignal): Promise<ContextCatalogue>;
  callWrite(
    sender: ContextSender,
    name: string,
    args: Record<string, unknown>,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<ContextWriteResult>;
}
export interface BoundContextWriter {
  employeeId: number;
  discover(signal: AbortSignal): Promise<ContextToolDefinition[]>;
  describe(signal: AbortSignal): Promise<ContextCatalogue>;
  call(
    name: string,
    args: Record<string, unknown>,
    operationId: string,
    signal: AbortSignal,
  ): Promise<ContextWriteResult>;
}
