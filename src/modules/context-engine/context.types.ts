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

export const CONTEXT_READ_TOOLS = {
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
} as const;
export type ContextReadTool = keyof typeof CONTEXT_READ_TOOLS;
export const isContextReadTool = (name: string): name is ContextReadTool =>
  Object.hasOwn(CONTEXT_READ_TOOLS, name);

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
}
export interface ContextToolGateway {
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
  | 'RATE_LIMITED'
  | 'UNAVAILABLE'
  | 'TIMEOUT'
  | 'CANCELLED';
export class ContextEngineError extends Error {
  constructor(
    readonly code: ContextErrorCode,
    readonly retryable = false,
    readonly retryAfterSeconds?: number,
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
