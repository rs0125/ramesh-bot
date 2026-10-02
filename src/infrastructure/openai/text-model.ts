/** OpenAI Responses adapter: bounded tokens/retries, cancellation, and redacted errors. */
import OpenAI from 'openai';
import { effectiveReasoningEffort, type AssistantConfig } from '../../config/assistant.js';
import { withUsageStage } from '../../modules/usage/usage-scope.js';
import type {
  ModelRequest,
  ModelResult,
  TextModel,
  ToolSessionRequest,
  ToolModelSession,
} from '../../modules/assistant/assistant.types.js';

export class OpenAITextModel implements TextModel {
  private readonly client: OpenAI;
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

  startToolSession(request: ToolSessionRequest): ToolModelSession {
    const input: OpenAI.Responses.ResponseInputItem[] = request.messages.map(
      ({ role, content }) => ({
        role,
        content,
      }),
    );
    const tools: OpenAI.Responses.FunctionTool[] = request.tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: structuredClone(tool.inputSchema),
      strict: false,
    }));
    const pending = new Set<string>();
    return {
      next: async (remainingCalls, signal) => {
        signal.throwIfAborted();
        if (pending.size) throw new Error('Tool outputs required before continuation');
        try {
          const response = await withUsageStage('worker', () =>
            this.client.responses.create(
              {
                model: this.config.model,
                service_tier: 'default',
                instructions: `${request.instructions}\nRemaining tool-call budget: ${remainingCalls}. If zero, give an honest answer from the evidence already retrieved and state any remaining limitation.`,
                input,
                tools,
                tool_choice: remainingCalls > 0 ? 'auto' : 'none',
                parallel_tool_calls: false,
                store: false,
                reasoning: { effort: this.config.toolReasoningEffort ?? 'medium' },
                include: ['reasoning.encrypted_content'],
                max_output_tokens: this.config.maxOutputTokens,
              },
              { signal },
            ),
          );
          signal.throwIfAborted();
          if (response.status !== 'completed') throw new Error('Incomplete model response');
          const calls = response.output.filter((item) => item.type === 'function_call');
          if (calls.length > 1 || (!calls.length && !response.output_text?.trim()))
            throw new Error('Invalid tool response');
          // Keep all continuation items, including encrypted reasoning, with store:false.
          // They remain in this run's closure and are not logged or persisted.
          for (const item of response.output) {
            if (
              item.type !== 'message' &&
              item.type !== 'reasoning' &&
              item.type !== 'function_call'
            )
              throw new Error('Unexpected model output item');
            input.push(item);
          }
          for (const call of calls) pending.add(call.call_id);
          return {
            text: response.output_text?.trim() ?? '',
            calls: calls.map((call) => ({
              id: call.call_id,
              name: call.name,
              arguments: call.arguments,
            })),
            inputTokens: response.usage?.input_tokens ?? 0,
            outputTokens: response.usage?.output_tokens ?? 0,
            ...usageDetails(response.usage),
            responseId: response.id,
          };
        } catch (error) {
          signal.throwIfAborted();
          const status = error instanceof OpenAI.APIError ? error.status : undefined;
          throw new Error(
            status ? `OpenAI request failed (HTTP ${status})` : 'OpenAI tool request failed',
          );
        }
      },
      accept(callId, output) {
        if (!pending.delete(callId)) throw new Error('Unexpected tool result');
        const serialized = JSON.stringify(output);
        if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > 100_000)
          throw new Error('Tool result exceeds context budget');
        input.push({ type: 'function_call_output', call_id: callId, output: serialized });
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
      const response = await withUsageStage(request.stage, () =>
        this.client.responses.create(
          {
            model: this.config.model,
            service_tier: 'default',
            instructions: request.instructions,
            input: request.messages.map(({ role, content }) => ({ role, content })),
            store: false,
            reasoning: {
              effort: effectiveReasoningEffort(
                this.config.model,
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
          },
          { signal },
        ),
      );
      signal?.throwIfAborted();
      if (response.status !== 'completed' || !response.output_text?.trim())
        throw new Error('OpenAI returned no complete text response');
      return {
        text: response.output_text.trim(),
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
        ...usageDetails(response.usage),
        responseId: response.id,
      };
    } catch (error) {
      signal?.throwIfAborted();
      // Never bubble provider bodies, request headers or user prompts into worker logs.
      const status = error instanceof OpenAI.APIError ? error.status : undefined;
      throw new Error(status ? `OpenAI request failed (HTTP ${status})` : 'OpenAI request failed');
    }
  }
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
