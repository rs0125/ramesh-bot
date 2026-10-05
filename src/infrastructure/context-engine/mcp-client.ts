/** Request-scoped MCP connections. No shared employee session, token cache or automatic consent flow. */
import {
  Client,
  ProtocolError,
  ProtocolErrorCode,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/client';
import { z } from 'zod';
import { loadContextEngineConfig, type ContextEngineConfig } from '../../config/context-engine.js';
import {
  ContextEngineError,
  type ContextCredentialResolver,
  type ContextEvidence,
  type ContextReadTool,
  type ContextSender,
  type ContextToolDefinition,
  type ContextToolGateway,
  type ContextWriteGateway,
  type ContextWriteResult,
  type EmployeeContextGrant,
} from '../../modules/context-engine/context.types.js';
import {
  admittedReadTool,
  argumentsSha256,
  MAX_CATALOGUE_BYTES,
  MAX_CATALOGUE_TOOLS,
  MAX_GUIDANCE_BYTES,
  modelContext,
  schemaAccepts,
  TOOL_NAME,
} from '../../modules/context-engine/read-contract.js';

import {
  admittedWriteTool,
  writeContract,
  writeResultSchema,
} from '../../modules/context-engine/write-contract.js';

const envelope = z
  .object({
    source_path: z.string().startsWith('/api/v1/').max(4096),
    status: z.literal(200),
    data: z.record(z.string(), z.unknown()),
    meta: z.object({ requestId: z.string().min(1), generatedAt: z.string().min(1) }).passthrough(),
  })
  .passthrough();
const identity = z.object({
  employee_id: z.number().int().positive(),
  scopes: z.array(z.string()),
  read_only: z.boolean(),
  write_capabilities: z.array(z.string().regex(TOOL_NAME)).max(32).optional(),
});

async function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new ContextEngineError('CANCELLED'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(work), cancelled]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function statusError(status: number, retryAfter?: number): ContextEngineError {
  if (status === 401) return new ContextEngineError('AUTH_REQUIRED');
  if (status === 403) return new ContextEngineError('ACCESS_DENIED');
  if (status === 429) return new ContextEngineError('RATE_LIMITED', true, retryAfter);
  if (status >= 500) return new ContextEngineError('UNAVAILABLE', true, retryAfter);
  return new ContextEngineError('INVALID_ARGUMENTS');
}
const gmailReadTools = new Set(['get_email_connection', 'list_email_drafts', 'read_email_draft']);
// Only authenticated, explicitly marked mailbox failures can bypass global
// employee-auth handling. Employee/key errors are deliberately absent here.
const gmailReadRecovery: Record<
  string,
  { action: NonNullable<ContextEngineError['recovery']>['action']; retryable: boolean }
> = {
  GMAIL_CONNECT_REQUIRED: { action: 'connect_gmail', retryable: false },
  GMAIL_RECONNECT_REQUIRED: { action: 'reconnect_gmail', retryable: false },
  GMAIL_AUTH_REQUIRED: { action: 'reconnect_gmail', retryable: false },
  GMAIL_REVOCATION_PENDING: { action: 'finish_gmail_disconnect', retryable: false },
  GMAIL_CONNECTION_CHANGED: { action: 'check_gmail_connection', retryable: false },
  GMAIL_DRAFT_UNAVAILABLE: { action: 'check_gmail_draft', retryable: false },
  GMAIL_NOT_FOUND: { action: 'check_gmail_draft', retryable: false },
  GMAIL_RESPONSE_TOO_LARGE: { action: 'check_gmail_draft', retryable: false },
  GMAIL_INVALID_INPUT: { action: 'correct_query', retryable: false },
  GMAIL_INVALID_CURSOR: { action: 'correct_query', retryable: false },
  GMAIL_ACCESS_DENIED: { action: 'check_google_access', retryable: false },
  GMAIL_CONFIGURATION: { action: 'check_source_configuration', retryable: false },
  GMAIL_ENCRYPTION_CONFIGURATION: { action: 'check_source_configuration', retryable: false },
  GMAIL_RATE_LIMITED: { action: 'retry_later', retryable: true },
  GMAIL_TIMEOUT: { action: 'retry_later', retryable: true },
  GMAIL_UNAVAILABLE: { action: 'retry_later', retryable: true },
  GMAIL_OAUTH_UNAVAILABLE: { action: 'retry_later', retryable: true },
  GMAIL_STORAGE_UNAVAILABLE: { action: 'retry_later', retryable: true },
  GMAIL_ABORTED: { action: 'investigate_source_response', retryable: false },
  GMAIL_RESPONSE_INVALID: { action: 'investigate_source_response', retryable: false },
};
function evidence(result: CallToolResult, toolName?: string): ContextEvidence {
  let value: unknown = result.structuredContent;
  if (!value) {
    const text = result.content?.find((part) => part.type === 'text');
    try {
      value = text?.type === 'text' ? JSON.parse(text.text) : undefined;
    } catch {
      throw new ContextEngineError('INVALID_RESPONSE');
    }
  }
  if (result.isError) {
    const failure = z
      .object({
        status: z.number().int(),
        retry_after_seconds: z.number().nonnegative().max(86400).optional(),
        error: z.unknown().optional(),
      })
      .safeParse(value);
    if (!failure.success) throw new ContextEngineError('UNAVAILABLE', true);
    const error = statusError(failure.data.status, failure.data.retry_after_seconds);
    const details = z
      .object({
        code: z.string().regex(/^[A-Z_]{1,80}$/),
        domain: z.literal('gmail').optional(),
        recovery: z.object({
          retryable: z.boolean(),
          action: z.enum([
            'check_source_configuration',
            'check_google_access',
            'check_capabilities',
            'correct_query',
            'check_engine_access',
            'retry_later',
            'investigate_source_response',
            'connect_gmail',
            'reconnect_gmail',
            'finish_gmail_disconnect',
            'check_gmail_connection',
            'check_gmail_draft',
          ]),
        }),
      })
      .safeParse(failure.data.error);
    const recovery = details.success ? details.data.recovery : undefined;
    const mailbox =
      details.success && details.data.domain === 'gmail' && gmailReadTools.has(toolName ?? '')
        ? gmailReadRecovery[details.data.code]
        : undefined;
    if (
      mailbox &&
      details.success &&
      recovery?.action === mailbox.action &&
      recovery.retryable === mailbox.retryable
    ) {
      const code =
        details.data.code === 'GMAIL_RATE_LIMITED'
          ? 'RATE_LIMITED'
          : details.data.code === 'GMAIL_RESPONSE_TOO_LARGE'
            ? 'RESPONSE_TOO_LARGE'
            : mailbox.action === 'correct_query'
              ? 'INVALID_ARGUMENTS'
              : 'UNAVAILABLE';
      throw new ContextEngineError(
        code,
        mailbox.retryable,
        mailbox.retryable ? failure.data.retry_after_seconds : undefined,
        { sourceCode: details.data.code, action: mailbox.action },
      );
    }
    throw recovery
      ? new ContextEngineError(
          error.code,
          recovery.retryable,
          recovery.retryable ? error.retryAfterSeconds : undefined,
          { sourceCode: details.success ? details.data.code : 'UNKNOWN', action: recovery.action },
        )
      : error;
  }
  const checked = envelope.safeParse(value);
  if (!checked.success) throw new ContextEngineError('INVALID_RESPONSE');
  return checked.data;
}

async function callDiscoveredTool(
  client: Client,
  tool: Tool,
  args: Record<string, unknown>,
  request: { signal: AbortSignal; timeout: number },
): Promise<CallToolResult> {
  try {
    // Do not allow schema extensions to mirror model arguments into HTTP headers.
    // Both schemas are validated here against the authenticated current descriptor.
    if (!schemaAccepts(tool.inputSchema, args)) throw new ContextEngineError('INVALID_ARGUMENTS');
    const result = await client.request(
      { method: 'tools/call', params: { name: tool.name, arguments: args } },
      request,
    );
    if (
      !result.isError &&
      tool.outputSchema &&
      !schemaAccepts(tool.outputSchema, evidence(result, tool.name))
    )
      throw new ContextEngineError('INVALID_RESPONSE');
    return result;
  } catch (error) {
    if (error instanceof ProtocolError && error.code === ProtocolErrorCode.InvalidParams) {
      // A platform selection or employee permission can change after discovery.
      // Refresh once to distinguish a removed tool from invalid arguments. Never
      // retry the tool call or fall back to the Claude connector.
      const catalogue = await listCurrentTools(client, request);
      if (
        !catalogue.some(
          (current) => current.name === tool.name && current.annotations?.readOnlyHint === true,
        )
      )
        throw new ContextEngineError('TOOL_UNAVAILABLE');
      throw new ContextEngineError('INVALID_ARGUMENTS');
    }
    throw error;
  }
}

/** Explicit pages avoid SDK auto-aggregation silently ending a repeated cursor. No shared cache. */
async function listCurrentTools(
  client: Client,
  request: { signal: AbortSignal; timeout: number },
): Promise<Tool[]> {
  const tools: Tool[] = [];
  const cursors = new Set<string>();
  const names = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 4; page++) {
    const result = await client.request(
      { method: 'tools/list', params: cursor === undefined ? {} : { cursor } },
      request,
    );
    for (const tool of result.tools) {
      if (names.has(tool.name)) throw new ContextEngineError('INVALID_RESPONSE');
      names.add(tool.name);
      tools.push(tool);
    }
    if (
      tools.length > MAX_CATALOGUE_TOOLS ||
      Buffer.byteLength(JSON.stringify(tools)) > MAX_CATALOGUE_BYTES
    )
      throw new ContextEngineError('RESPONSE_TOO_LARGE');
    if (result.nextCursor === undefined) return tools;
    if (!result.nextCursor || result.nextCursor.length > 2048 || cursors.has(result.nextCursor))
      throw new ContextEngineError('INVALID_RESPONSE');
    cursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new ContextEngineError('RESPONSE_TOO_LARGE');
}

export class ContextEngineMcpClient implements ContextToolGateway, ContextWriteGateway {
  private readonly config: ContextEngineConfig;
  constructor(
    config: ContextEngineConfig,
    private readonly credentials: ContextCredentialResolver,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    // Validate even manually constructed configuration before any bearer token can leave the process.
    this.config = loadContextEngineConfig({
      CONTEXT_MCP_URL: config.endpoint,
      CONTEXT_MCP_TIMEOUT_MS: String(config.timeoutMs),
      CONTEXT_MCP_MAX_RESPONSE_BYTES: String(config.maxResponseBytes),
    })!;
    if (!this.config) throw new ContextEngineError('NOT_CONFIGURED');
  }

  async discover(sender: ContextSender, signal?: AbortSignal): Promise<ContextToolDefinition[]> {
    return (await this.describe(sender, signal)).tools;
  }
  describe(sender: ContextSender, signal?: AbortSignal) {
    return this.withConnection(sender, signal, async (client, tools, context) => ({
      guidance: client.getInstructions(),
      context: modelContext(context.data),
      tools: tools.map((tool) => ({
        name: tool.name as ContextReadTool,
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
        ...(tool._meta ? { _meta: tool._meta } : {}),
      })),
    }));
  }

  async discoverWrites(
    sender: ContextSender,
    signal?: AbortSignal,
  ): Promise<ContextToolDefinition[]> {
    return (await this.describeWrites(sender, signal)).tools;
  }

  describeWrites(sender: ContextSender, signal?: AbortSignal) {
    return this.withConnection(
      sender,
      signal,
      async (client, _reads, context, _request, writes) => ({
        guidance: client.getInstructions(),
        context: modelContext(context.data),
        tools: writes.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema,
          annotations: tool.annotations,
          _meta: tool._meta,
        })),
      }),
    );
  }

  /** One dispatch only. The caller owns durable intent, authorization and same-operation recovery. */
  async callWrite(
    sender: ContextSender,
    name: string,
    args: Record<string, unknown>,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<ContextWriteResult> {
    if (!z.string().uuid().safeParse(operationId).success)
      throw new ContextEngineError('INVALID_ARGUMENTS');
    const id = operationId.toLowerCase();
    let dispatched = false;
    const failed = (code: string): ContextWriteResult => ({
      operation_id: id,
      outcome: dispatched ? 'outcome_unknown' : 'not_dispatched',
      code,
      message: dispatched
        ? 'The outcome could not be confirmed. Recover only with the same operation ID and unchanged arguments.'
        : 'The action was not dispatched. Refresh access or correct the request before proceeding.',
    });
    try {
      if (!TOOL_NAME.test(name)) throw new ContextEngineError('TOOL_UNAVAILABLE');
      const serialized = JSON.stringify(args);
      if (!serialized || Buffer.byteLength(serialized) > 16384)
        throw new ContextEngineError('INVALID_ARGUMENTS');
      const frozen = JSON.parse(serialized) as Record<string, unknown>;
      if (!frozen || typeof frozen !== 'object' || Array.isArray(frozen))
        throw new ContextEngineError('INVALID_ARGUMENTS');
      return await this.withConnection(
        sender,
        signal,
        async (client, _reads, context, request, writes) => {
          const tool = writes.find((tool) => tool.name === name),
            contract = tool && writeContract(tool);
          if (!tool || !contract) throw new ContextEngineError('TOOL_UNAVAILABLE');
          if (
            frozen[contract.idempotencyArgument] !== operationId ||
            !schemaAccepts(tool.inputSchema, frozen)
          )
            throw new ContextEngineError('INVALID_ARGUMENTS');
          const result = await client.request(
            { method: 'tools/call', params: { name, arguments: frozen } },
            request,
          );
          let raw: unknown = result.structuredContent;
          if (!raw) {
            const content = result.content?.find((part) => part.type === 'text');
            raw = content?.type === 'text' ? JSON.parse(content.text) : undefined;
          }
          if (Buffer.byteLength(JSON.stringify(raw) ?? '') > 64_000)
            throw new ContextEngineError('RESPONSE_TOO_LARGE');
          const checked = writeResultSchema.safeParse(raw);
          if (!checked.success || !schemaAccepts(tool.outputSchema!, raw))
            throw new ContextEngineError('INVALID_RESPONSE');
          const receipt = checked.data,
            success = ['created', 'updated', 'deleted', 'replayed', 'rolled_back'].includes(
              receipt.outcome,
            );
          if (
            receipt.operation_id.toLowerCase() !== id ||
            receipt.meta?.toolName !== name ||
            receipt.meta.argumentsSha256 !== argumentsSha256(frozen) ||
            receipt.meta.employeeId !== context.data.employee_id ||
            Boolean(result.isError) === success
          )
            throw new ContextEngineError('INVALID_RESPONSE');
          if (!success && receipt.data !== undefined)
            throw new ContextEngineError('INVALID_RESPONSE');
          return receipt;
        },
        {
          name,
          dispatch: () => {
            if (dispatched) throw new ContextEngineError('INVALID_RESPONSE');
            dispatched = true;
          },
        },
      );
    } catch (error) {
      return failed(
        dispatched
          ? 'WRITE_OUTCOME_UNKNOWN'
          : error instanceof ContextEngineError
            ? `WRITE_${error.code}`
            : 'WRITE_UNAVAILABLE',
      );
    }
  }

  async call(
    sender: ContextSender,
    name: ContextReadTool,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ContextEvidence> {
    if (!TOOL_NAME.test(name)) throw new ContextEngineError('TOOL_UNAVAILABLE');
    // Serialize once so callers cannot mutate arguments while authorization is in flight.
    let frozen: Record<string, unknown>;
    try {
      const serialized = JSON.stringify(args);
      if (Buffer.byteLength(serialized) > 16384) throw new Error();
      frozen = JSON.parse(serialized);
      if (!frozen || typeof frozen !== 'object' || Array.isArray(frozen)) throw new Error();
    } catch {
      throw new ContextEngineError('INVALID_ARGUMENTS');
    }
    return this.withConnection(sender, signal, async (client, tools, context, request) => {
      const tool = tools.find((tool) => tool.name === name);
      if (!tool) throw new ContextEngineError('TOOL_UNAVAILABLE');
      if (name === 'get_context') {
        if (Object.keys(frozen).length) throw new ContextEngineError('INVALID_ARGUMENTS');
        return context;
      }
      return evidence(await callDiscoveredTool(client, tool, frozen, request), name);
    });
  }

  private async withConnection<T>(
    sender: ContextSender,
    callerSignal: AbortSignal | undefined,
    work: (
      client: Client,
      tools: Tool[],
      context: ContextEvidence,
      request: { signal: AbortSignal; timeout: number },
      writes: Tool[],
    ) => Promise<T>,
    writeAttempt?: { name: string; dispatch: () => void },
  ): Promise<T> {
    if (sender.audience !== 'dm' || !/^\+[1-9]\d{7,14}$/.test(sender.phoneE164))
      throw new ContextEngineError('ACCESS_DENIED');
    const trustedSender = { ...sender };
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.config.timeoutMs);
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, deadline.signal])
      : deadline.signal;
    const client = new Client(
      { name: 'ramesh-context-reader', version: '0.1.0' },
      { listMaxPages: 4 },
    );
    let activeGrant: EmployeeContextGrant | undefined;
    try {
      signal.throwIfAborted();
      const resolved = await abortable(
        () => this.credentials.resolve(trustedSender, signal),
        signal,
      );
      const grant = resolved ? { ...resolved } : null;
      signal.throwIfAborted();
      if (
        !grant ||
        !grant.active ||
        grant.phoneE164 !== trustedSender.phoneE164 ||
        !Number.isSafeInteger(grant.employeeId) ||
        grant.employeeId <= 0 ||
        !Number.isFinite(grant.expiresAtMs) ||
        grant.expiresAtMs <= Date.now() + this.config.timeoutMs ||
        ('kind' in grant
          ? grant.kind !== 'signed-request' || typeof grant.authorize !== 'function'
          : !/^wog_mcp_at_[A-Za-z0-9_-]{43}$/.test(grant.accessToken))
      )
        throw new ContextEngineError('AUTH_REQUIRED');
      const signed = 'kind' in grant ? grant : undefined;
      const bearer = 'accessToken' in grant ? grant : undefined;
      if (
        (signed && !this.config.endpoint.endsWith('/mcp/ramesh')) ||
        (bearer && !this.config.endpoint.endsWith('/mcp'))
      )
        throw new ContextEngineError('ACCESS_DENIED');
      activeGrant = bearer;
      const request = { signal, timeout: this.config.timeoutMs };
      const transport = new StreamableHTTPClientTransport(new URL(this.config.endpoint), {
        requestInit: bearer
          ? { headers: { Authorization: `Bearer ${bearer.accessToken}` } }
          : undefined,
        onInsufficientScope: 'throw',
        reconnectionOptions: {
          maxRetries: 0,
          initialReconnectionDelay: 1000,
          maxReconnectionDelay: 1000,
          reconnectionDelayGrowFactor: 1,
        },
        fetch: async (input, init) => {
          let outgoing = new Request(input, init);
          if (outgoing.url !== this.config.endpoint) throw new ContextEngineError('ACCESS_DENIED');
          if (signed && outgoing.method === 'POST')
            outgoing = await signed.authorize(outgoing, signal);
          if (writeAttempt && outgoing.method === 'POST') {
            const rpc = (await outgoing.clone().json()) as {
              method?: string;
              params?: { name?: string };
            };
            if (rpc.method === 'tools/call' && rpc.params?.name === writeAttempt.name)
              writeAttempt.dispatch();
          }
          const response = await this.fetcher(outgoing, {
            redirect: 'error',
            signal: AbortSignal.any([signal, outgoing.signal]),
          });
          if (!response.ok && !(outgoing.method === 'GET' && response.status === 405)) {
            const delay = Number(response.headers.get('retry-after'));
            await response.body?.cancel();
            throw statusError(
              response.status,
              Number.isFinite(delay) && delay >= 0 && delay <= 86400 ? delay : undefined,
            );
          }
          const reader = response.body?.getReader();
          if (!reader) return response;
          const chunks: Uint8Array[] = [];
          let bytes = 0;
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              bytes += value.byteLength;
              if (bytes > this.config.maxResponseBytes) {
                await reader.cancel();
                throw new ContextEngineError('RESPONSE_TOO_LARGE');
              }
              chunks.push(value);
            }
          } finally {
            reader.releaseLock();
          }
          return new Response(Buffer.concat(chunks), {
            status: response.status,
            headers: response.headers,
          });
        },
      });
      await client.connect(transport, request);
      // The authenticated endpoint owns platform selection. Ramesh's signed
      // /mcp/ramesh catalog is refreshed for every read, including receipt replay.
      const catalogue = await listCurrentTools(client, request);
      const contextTool = catalogue.find(
        (tool) =>
          tool.name === 'get_context' &&
          tool.annotations?.readOnlyHint === true &&
          tool.annotations.destructiveHint !== true,
      );
      if (!contextTool) throw new ContextEngineError('TOOL_UNAVAILABLE');
      const context = evidence(
        await callDiscoveredTool(client, contextTool, {}, request),
        'get_context',
      );
      const current = identity.safeParse(context.data);
      if (!current.success) throw new ContextEngineError('INVALID_RESPONSE');
      if (current.data.employee_id !== grant.employeeId)
        throw new ContextEngineError('ACCESS_DENIED');
      const instructions = client.getInstructions();
      if (instructions && Buffer.byteLength(instructions) > MAX_GUIDANCE_BYTES)
        throw new ContextEngineError('RESPONSE_TOO_LARGE');
      const tools = catalogue.filter((tool) => admittedReadTool(tool, current.data.scopes));
      const possibleWrites = catalogue.filter((tool) =>
        admittedWriteTool(tool, current.data.scopes),
      );
      const advertised = current.data.write_capabilities ?? [];
      if (
        new Set(advertised).size !== advertised.length ||
        (current.data.read_only
          ? advertised.length > 0
          : !advertised.length ||
            advertised.some((name) => !possibleWrites.some((tool) => tool.name === name)))
      )
        throw new ContextEngineError('INVALID_RESPONSE');
      const writes = current.data.read_only
        ? []
        : possibleWrites.filter((tool) => advertised.includes(tool.name));
      return await work(client, tools, context, request, writes);
    } catch (error) {
      if (
        error instanceof ContextEngineError &&
        error.code === 'AUTH_REQUIRED' &&
        activeGrant &&
        this.credentials.invalidate &&
        !signal.aborted
      ) {
        await abortable(() => this.credentials.invalidate!(activeGrant!), signal).catch(
          () => undefined,
        );
      }
      if (callerSignal?.aborted) throw new ContextEngineError('CANCELLED');
      if (deadline.signal.aborted) throw new ContextEngineError('TIMEOUT', true);
      if (error instanceof ContextEngineError) throw error;
      // Raw SDK/provider exceptions can embed request arguments or credentials.
      throw new ContextEngineError('UNAVAILABLE', true);
    } finally {
      clearTimeout(timer);
      await client.close().catch(() => undefined);
    }
  }
}
