/** Select one structured answer; never parse the SDK's concatenation of output messages. */
import type OpenAI from 'openai';
import type { ModelRequest } from '../../modules/assistant/assistant.types.js';
import { ModelFailureError, type ModelFailure } from '../../modules/assistant/model-failure.js';
import { schemaAccepts } from '../../modules/context-engine/read-contract.js';

export function structuredResponseText(response: OpenAI.Responses.Response, request: ModelRequest) {
  const messages = response.output.filter((item) => item.type === 'message');
  const shape = {
    messages: messages.length,
    commentaryMessages: messages.filter((item) => item.phase === 'commentary').length,
    finalMessages: messages.filter((item) => item.phase === 'final_answer').length,
    textParts: messages.reduce(
      (sum, item) => sum + item.content.filter((c) => c.type === 'output_text').length,
      0,
    ),
    refusals: messages.reduce(
      (sum, item) => sum + item.content.filter((c) => c.type === 'refusal').length,
      0,
    ),
  };
  const fail = (code: ModelFailure['code']): never => {
    throw new ModelFailureError(
      { stage: request.stage, code, outputShape: shape },
      'OpenAI structured response was invalid',
    );
  };
  if (response.status !== 'completed') fail('INCOMPLETE_RESPONSE');
  if (shape.refusals) fail('REFUSAL');
  if (response.output.some((item) => item.type !== 'message' && item.type !== 'reasoning'))
    fail('INVALID_RESPONSE');
  const answers = messages.filter((item) => item.phase !== 'commentary');
  if (answers.length !== 1) fail('AMBIGUOUS_OUTPUT');
  const answer = answers[0]!;
  if (answer.status && answer.status !== 'completed') fail('INCOMPLETE_RESPONSE');
  const content = answer.content[0];
  if (answer.content.length !== 1 || !content || content.type !== 'output_text')
    return fail('AMBIGUOUS_OUTPUT');
  const text = content.text.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('INVALID_JSON');
  }
  if (!schemaAccepts(request.jsonSchema!.schema, parsed)) fail('SCHEMA_MISMATCH');
  return text;
}
