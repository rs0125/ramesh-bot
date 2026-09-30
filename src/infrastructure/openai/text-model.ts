/** OpenAI Responses adapter: bounded tokens/retries, cancellation, and redacted errors. */
import OpenAI from 'openai';
import type { AssistantConfig } from '../../config/assistant.js';
import type {
  ModelRequest,
  ModelResult,
  TextModel,
} from '../../modules/assistant/assistant.types.js';

export class OpenAITextModel implements TextModel {
  private readonly client: OpenAI;
  constructor(
    private readonly config: AssistantConfig,
    fetcher?: typeof fetch,
  ) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: 'https://api.openai.com/v1',
      maxRetries: 1,
      timeout: Math.min(config.timeoutMs, 25_000),
      ...(fetcher ? { fetch: fetcher } : {}),
    });
  }

  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResult> {
    signal?.throwIfAborted();
    try {
      const response = await this.client.responses.create(
        {
          model: this.config.model,
          instructions: request.instructions,
          input: request.messages,
          store: false,
          reasoning: { effort: 'none' },
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
      );
      signal?.throwIfAborted();
      if (response.status !== 'completed' || !response.output_text?.trim())
        throw new Error('OpenAI returned no complete text response');
      return {
        text: response.output_text.trim(),
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
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
