/** Request-scoped MCP connections. No shared employee session, token cache or automatic consent flow. */
import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/client';
import { z } from 'zod';
import { loadContextEngineConfig, type ContextEngineConfig } from '../../config/context-engine.js';
import {
  CONTEXT_READ_TOOLS,
  ContextEngineError,
  isContextReadTool,
  type ContextCredentialResolver,
  type ContextEvidence,
  type ContextReadTool,
  type ContextSender,
  type ContextToolDefinition,
  type ContextToolGateway,
  type EmployeeContextGrant,
} from '../../modules/context-engine/context.types.js';

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
  read_only: z.literal(true),
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
function evidence(result: CallToolResult): ContextEvidence {
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
        retry_after_seconds: z.number().nonnegative().max(3600).optional(),
        error: z.unknown().optional(),
      })
      .safeParse(value);
    if (!failure.success) throw new ContextEngineError('UNAVAILABLE', true);
    const error = statusError(failure.data.status, failure.data.retry_after_seconds);
    const details = z
      .object({
        code: z.string().regex(/^[A-Z_]{1,80}$/),
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
          ]),
        }),
      })
      .safeParse(failure.data.error);
    const recovery = details.success ? details.data.recovery : undefined;
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

export class ContextEngineMcpClient implements ContextToolGateway {
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
    return this.withConnection(sender, signal, async (client, tools) => ({
      guidance: client.getInstructions(),
      tools: tools.map((tool) => ({
        name: tool.name as ContextReadTool,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    }));
  }

  async call(
    sender: ContextSender,
    name: ContextReadTool,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ContextEvidence> {
    if (!isContextReadTool(name)) throw new ContextEngineError('TOOL_UNAVAILABLE');
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
      if (name === 'get_context') return context;
      if (!tools.some((tool) => tool.name === name))
        throw new ContextEngineError('TOOL_UNAVAILABLE');
      return evidence(await client.callTool({ name, arguments: frozen }, request));
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
    ) => Promise<T>,
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
          const response = await this.fetcher(outgoing, {
            redirect: 'error',
            signal: AbortSignal.any([signal, outgoing.signal]),
          });
          if (!response.ok && !(outgoing.method === 'GET' && response.status === 405)) {
            const delay = Number(response.headers.get('retry-after'));
            await response.body?.cancel();
            throw statusError(
              response.status,
              Number.isFinite(delay) && delay >= 0 && delay <= 3600 ? delay : undefined,
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
      const catalogue = await client.listTools({}, request);
      if (catalogue.nextCursor) throw new ContextEngineError('INVALID_RESPONSE');
      if (
        !catalogue.tools.some(
          (tool) => tool.name === 'get_context' && tool.annotations?.readOnlyHint === true,
        )
      )
        throw new ContextEngineError('TOOL_UNAVAILABLE');
      const context = evidence(
        await client.callTool({ name: 'get_context', arguments: {} }, request),
      );
      const current = identity.safeParse(context.data);
      if (!current.success) throw new ContextEngineError('INVALID_RESPONSE');
      if (current.data.employee_id !== grant.employeeId)
        throw new ContextEngineError('ACCESS_DENIED');
      const tools = catalogue.tools.filter(
        (tool) =>
          isContextReadTool(tool.name) &&
          tool.annotations?.readOnlyHint === true &&
          (CONTEXT_READ_TOOLS[tool.name] === null ||
            current.data.scopes.includes(CONTEXT_READ_TOOLS[tool.name]!)),
      );
      return await work(client, tools, context, request);
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
