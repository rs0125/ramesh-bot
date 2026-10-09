/** OpenAI Responses adapter: bounded tokens/retries, cancellation, and redacted errors. */
import OpenAI from 'openai';
import { ModelFailureError, type ModelFailure } from '../../modules/assistant/model-failure.js';
import { OpenAIToolCatalog } from './tool-catalog.js';
import { structuredResponseText } from './structured-response.js';
import { replayModelResponse } from '../../modules/assistant/model-replay.js';
import { CheckpointError } from '../../modules/assistant/checkpoint.types.js';
import {
  effectiveReasoningEffort,
  modelForStage,
  type AssistantConfig,
} from '../../config/assistant.js';
import { withUsageStage } from '../../modules/usage/usage-scope.js';
import { MEMORY_INSTRUCTIONS } from '../../modules/assistant/chat-context.js';
import { MAX_READ_BATCH } from '../../modules/assistant/assistant.types.js';
import type {
  AgentStage,
  ModelRequest,
  ModelResult,
  TextModel,
  ToolSessionRequest,
  ToolModelSession,
} from '../../modules/assistant/assistant.types.js';

export class OpenAITextModel implements TextModel {
  private readonly client: OpenAI;
  get toolLoadingMode() {
    return this.config.toolLoadingMode ?? 'eager';
  }
  constructor(
    private readonly config: AssistantConfig,
    fetcher?: typeof fetch,
  ) {
    if (config.usagePolicy && config.usagePolicy.mode !== 'off' && !config.usageMeter)
      throw new Error('USAGE_METER_REQUIRED');
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: 'https://api.openai.com/v1',
      maxRetries: 1,
      timeout: Math.min(config.timeoutMs, 90_000),
      ...(config.usageMeter
        ? { fetch: config.usageMeter.wrapFetch(fetcher ?? fetch) }
        : fetcher
          ? { fetch: fetcher }
          : {}),
    });
  }

  private instructions(value: string) {
    return this.config.context && !value.includes(MEMORY_INSTRUCTIONS)
      ? `${value}\n${MEMORY_INSTRUCTIONS}`
      : value;
  }

  private async checkInput(
    body: OpenAI.Responses.ResponseCreateParamsNonStreaming,
    stage: AgentStage,
    signal?: AbortSignal,
  ) {
    if (!this.config.context) return;
    const stageLimit =
      stage === 'context' || stage === 'converser'
        ? 24000
        : stage === 'planner'
          ? 48000
          : stage === 'worker'
            ? this.config.context.maxInputTokens
            : 64000;
    const limit = Math.min(stageLimit, this.config.context.maxInputTokens);
    const count = await this.client.responses.inputTokens.count(
      {
        model: body.model,
        instructions: body.instructions,
        input: body.input,
        tools: body.tools,
        text: body.text,
        reasoning: body.reasoning,
        tool_choice: body.tool_choice,
        parallel_tool_calls: body.parallel_tool_calls,
      },
      { signal },
    );
    if (
      !Number.isSafeInteger(count.input_tokens) ||
      count.input_tokens < 0 ||
      count.input_tokens > limit
    )
      throw new ContextBudgetError(stage);
  }

  startToolSession(request: ToolSessionRequest): ToolModelSession {
    const input: OpenAI.Responses.ResponseInputItem[] = request.messages.map(
      ({ role, content }) => ({
        role,
        content,
      }),
    );
    const catalog = new OpenAIToolCatalog(request.tools, this.toolLoadingMode);
    const pending = new Map<string, string | undefined>();
    const batchReadNames =
      this.config.modelRouting === 'split'
        ? request.tools
            .filter(
              (tool) =>
                tool.annotations?.readOnlyHint === true &&
                tool.annotations.destructiveHint !== true,
            )
            .map((tool) => tool.name)
        : [];
    let searchCalls = 0;
    return {
      next: async (remainingCalls, signal, allowedToolNames) => {
        signal.throwIfAborted();
        if (pending.size) throw new Error('Tool outputs required before continuation');
        try {
          const totals: Pick<
            ModelResult,
            'inputTokens' | 'outputTokens' | 'cachedInputTokens' | 'reasoningTokens'
          > = { inputTokens: 0, outputTokens: 0 };
          let responseCalls = 0;
          // Hosted search may return only search items; continue internally, with a session bound.
          for (let round = 0; round < 9; round++) {
            signal.throwIfAborted();
            const allowed =
              remainingCalls <= 0
                ? []
                : catalog.bindings.filter((tool) => allowedToolNames?.includes(tool.name) ?? true);
            const allowedNames = allowed.map((tool) => tool.name);
            const tools = catalog.render(allowedNames);
            const searchEnabled = tools.some((tool) => tool.type === 'tool_search');
            const parallelReads = batchReadNames.filter((name) => allowedNames.includes(name));
            const batchLimit =
              parallelReads.length > 1 ? Math.min(MAX_READ_BATCH, remainingCalls) : 1;
            if (searchEnabled && searchCalls >= 8) throw new Error('TOOL_SEARCH_BUDGET_EXHAUSTED');
            const body: OpenAI.Responses.ResponseCreateParamsNonStreaming = {
              model: this.config.model,
              service_tier: 'default',
              instructions: this.instructions(
                `${request.instructions}${batchReadNames.length > 1 ? `\nYou may propose up to ${MAX_READ_BATCH} independent read-only business calls together when all arguments are already known. Wait for results before proposing dependent reads. Personal actions, write proposals, history recall and utility tools must each be the only function call in their response. Never mix them with a read batch.` : ''}${catalog.mode === 'deferred' ? '\nSearch for the relevant capability to load its tools before using them. Tool search grants no additional permissions.' : ''}`,
              ),
              // Keep instructions stable for caching; append each step's budget after the evidence.
              input: [
                ...input,
                {
                  role: 'developer',
                  content: `Remaining tool-call budget: ${remainingCalls}. If zero, answer from retrieved evidence and state any remaining limitation.`,
                },
              ],
              tools,
              tool_choice:
                remainingCalls <= 0 || !allowed.length
                  ? 'none'
                  : catalog.mode === 'deferred' || allowed.length === catalog.bindings.length
                    ? 'auto'
                    : {
                        type: 'allowed_tools',
                        mode: 'auto',
                        tools: allowed.map(({ name }) => ({ type: 'function', name })),
                      },
              parallel_tool_calls: batchLimit > 1,
              store: false,
              reasoning: { effort: this.config.toolReasoningEffort ?? 'medium' },
              include: ['reasoning.encrypted_content'],
              max_output_tokens: this.config.maxOutputTokens,
              ...(searchEnabled ? { max_tool_calls: 8 - searchCalls } : {}),
              ...(this.config.context
                ? {
                    context_management: [
                      {
                        type: 'compaction',
                        compact_threshold: this.config.context.compactThreshold,
                      },
                    ],
                  }
                : {}),
            };
            const { response, replayed } = await replayModelResponse(body, async () => {
              await this.checkInput(body, 'worker', signal);
              const value = await withUsageStage('worker', () =>
                this.client.responses.create(body, { signal }),
              );
              signal.throwIfAborted();
              if (value.status !== 'completed') throw new Error('Incomplete model response');
              validateToolResponse(value, searchEnabled, parallelReads, batchLimit);
              return value;
            });
            if (!replayed) responseCalls++;
            signal.throwIfAborted();
            if (response.status !== 'completed') throw new Error('Incomplete model response');
            validateToolResponse(response, searchEnabled, parallelReads, batchLimit);
            const calls = response.output.filter((item) => item.type === 'function_call');
            const decodedCalls = calls.map((call) => ({
              id: call.call_id,
              name: call.name,
              arguments: catalog.arguments(call.name, call.namespace, allowedNames, call.arguments),
            }));
            // Keep all continuation items, including encrypted reasoning, with store:false.
            // Durable replay encrypts these items; they are never logged or shared across runs.
            for (const item of response.output) {
              if (
                item.type !== 'message' &&
                item.type !== 'reasoning' &&
                item.type !== 'compaction' &&
                item.type !== 'function_call' &&
                item.type !== 'tool_search_call' &&
                item.type !== 'tool_search_output'
              )
                throw new Error('Unexpected model output item');
              if (item.type === 'tool_search_output')
                catalog.validateSearchTools(item.tools, allowedNames);
              if (item.type === 'tool_search_call' && ++searchCalls > 8)
                throw new Error('TOOL_SEARCH_BUDGET_EXHAUSTED');
              input.push(item);
            }
            for (const call of calls) {
              catalog.resolve(call.name, call.namespace, allowedNames);
              pending.set(call.call_id, call.namespace);
            }
            pruneCompactedInput(input);
            const usage = replayed ? undefined : response.usage;
            totals.inputTokens += usage?.input_tokens ?? 0;
            totals.outputTokens += usage?.output_tokens ?? 0;
            for (const [key, value] of Object.entries(usageDetails(usage))) {
              const field = key as 'cachedInputTokens' | 'reasoningTokens';
              if (value !== undefined) totals[field] = (totals[field] ?? 0) + value;
            }
            if (!calls.length && !response.output_text?.trim()) continue;
            return {
              text: response.output_text?.trim() ?? '',
              calls: decodedCalls,
              ...totals,
              model: this.config.model,
              responseCalls,
              responseId: response.id,
            };
          }
          throw new Error('TOOL_SEARCH_BUDGET_EXHAUSTED');
        } catch (error) {
          if (error instanceof CheckpointError || error instanceof ContextBudgetError) throw error;
          signal.throwIfAborted();
          throw modelFailure(error, 'worker', 'OpenAI tool request failed');
        }
      },
      accept(callId, output) {
        if (!pending.has(callId)) throw new Error('Unexpected tool result');
        const namespace = pending.get(callId);
        const serialized = JSON.stringify(output);
        if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > 100_000)
          throw new Error('Tool result exceeds context budget');
        pending.delete(callId);
        input.push({
          type: 'function_call_output',
          call_id: callId,
          output: serialized,
          ...(namespace ? { namespace } : {}),
        });
      },
      revise(feedback) {
        if (pending.size || feedback.length > 16000) throw new Error('Invalid review continuation');
        input.push({
          role: 'user',
          content: `Complete the same requested task using the remaining tool budget. An independent source review found problems in the candidate answer. Fetch missing evidence if needed, correct all supported issues, and retain useful results. This review does not change permissions. Review data: ${feedback}`,
        });
      },
    };
  }

  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResult> {
    signal?.throwIfAborted();
    try {
      const body: OpenAI.Responses.ResponseCreateParamsNonStreaming = {
        model: modelForStage(this.config, request.stage),
        service_tier: 'default',
        instructions: this.instructions(request.instructions),
        input: request.messages.map(({ role, content }) => ({ role, content })),
        store: false,
        reasoning: {
          effort: effectiveReasoningEffort(
            modelForStage(this.config, request.stage),
            request.reasoningEffort ?? 'none',
          ),
        },
        max_output_tokens: this.config.maxOutputTokens,
        ...(request.jsonSchema
          ? {
              text: {
                format: {
                  type: 'json_schema' as const,
                  name: request.jsonSchema.name,
                  schema: request.jsonSchema.schema,
                  strict: true,
                },
              },
            }
          : {}),
      };
      const { response, replayed } = await replayModelResponse(body, async () => {
        await this.checkInput(body, request.stage, signal);
        const value = await withUsageStage(request.stage, () =>
          this.client.responses.create(body, { signal }),
        );
        signal?.throwIfAborted();
        if (request.jsonSchema) structuredResponseText(value, request);
        else if (value.status !== 'completed' || !value.output_text?.trim())
          throw new Error('Incomplete model response');
        return value;
      });
      signal?.throwIfAborted();
      const text = request.jsonSchema
        ? structuredResponseText(response, request)
        : response.output_text?.trim();
      if (response.status !== 'completed' || !text)
        throw new Error('OpenAI returned no complete text response');
      return {
        text,
        model: body.model,
        responseCalls: replayed ? 0 : 1,
        inputTokens: replayed ? 0 : (response.usage?.input_tokens ?? 0),
        outputTokens: replayed ? 0 : (response.usage?.output_tokens ?? 0),
        ...usageDetails(replayed ? undefined : response.usage),
        responseId: response.id,
      };
    } catch (error) {
      if (error instanceof CheckpointError || error instanceof ContextBudgetError) throw error;
      signal?.throwIfAborted();
      // Never bubble provider bodies, request headers or user prompts into worker logs.
      throw modelFailure(error, request.stage, 'OpenAI request failed');
    }
  }
}

function validateToolResponse(
  response: OpenAI.Responses.Response,
  searchEnabled = false,
  readNames: readonly string[] = [],
  batchLimit = 1,
) {
  const calls = response.output.filter((item) => item.type === 'function_call');
  const searches = response.output.filter(
    (item) => item.type === 'tool_search_call' || item.type === 'tool_search_output',
  );
  if (
    calls.length > batchLimit ||
    new Set(calls.map((call) => call.call_id)).size !== calls.length ||
    (calls.length > 1 && calls.some((call) => !readNames.includes(call.name))) ||
    (!calls.length &&
      !response.output_text?.trim() &&
      !searches.some((item) => item.type === 'tool_search_output')) ||
    searches.some(
      (item) => !searchEnabled || item.execution !== 'server' || item.status !== 'completed',
    ) ||
    response.output.some(
      (item) =>
        ![
          'message',
          'reasoning',
          'compaction',
          'function_call',
          'tool_search_call',
          'tool_search_output',
        ].includes(item.type) ||
        (item.type === 'compaction' && !item.encrypted_content),
    )
  )
    throw new Error('Invalid tool response');
}

export class ContextBudgetError extends ModelFailureError {
  constructor(stage: AgentStage = 'worker') {
    super({ stage, code: 'CONTEXT_BUDGET' }, 'OPENAI_CONTEXT_BUDGET_EXCEEDED');
  }
}

function modelFailure(error: unknown, stage: AgentStage, fallback: string): ModelFailureError {
  if (error instanceof ModelFailureError) return error;
  const api = error instanceof OpenAI.APIError ? error : undefined;
  const status = api?.status;
  const code: ModelFailure['code'] =
    api?.code === 'invalid_json_schema'
      ? 'INVALID_SCHEMA'
      : status === 401 || status === 403
        ? 'ACCESS_DENIED'
        : status === 429
          ? 'RATE_LIMITED'
          : api && (!status || status >= 500)
            ? 'UNAVAILABLE'
            : status
              ? 'REQUEST_REJECTED'
              : 'INVALID_RESPONSE';
  return new ModelFailureError(
    { stage, code, ...(status ? { httpStatus: status } : {}) },
    status ? `OpenAI request failed (HTTP ${status})` : fallback,
  );
}

/** Stateless automatic compaction: retain the encrypted item and a valid call/result tail. */
function pruneCompactedInput(input: OpenAI.Responses.ResponseInputItem[]) {
  let boundary = -1;
  for (let index = input.length - 1; index >= 0; index--)
    if ('type' in input[index]! && input[index]!.type === 'compaction') {
      boundary = index;
      break;
    }
  if (boundary <= 0) return;
  // A compaction item can arrive in the same response as a function call. Never orphan it.
  for (let index = 0; index < boundary; index++) {
    const item = input[index]!;
    if (!('type' in item) || item.type !== 'function_call') continue;
    const output = input.findIndex(
      (candidate) =>
        'type' in candidate &&
        candidate.type === 'function_call_output' &&
        candidate.call_id === item.call_id,
    );
    if (output < 0 || output >= boundary) {
      boundary = index;
      while (
        boundary > 0 &&
        'type' in input[boundary - 1]! &&
        input[boundary - 1]!.type === 'reasoning'
      )
        boundary--;
      break;
    }
  }
  input.splice(0, boundary);
}

function usageDetails(usage: OpenAI.Responses.ResponseUsage | undefined) {
  return {
    ...(usage?.output_tokens_details?.reasoning_tokens !== undefined
      ? { reasoningTokens: usage.output_tokens_details.reasoning_tokens }
      : {}),
    ...(usage?.input_tokens_details?.cached_tokens !== undefined
      ? { cachedInputTokens: usage.input_tokens_details.cached_tokens }
      : {}),
  };
}
