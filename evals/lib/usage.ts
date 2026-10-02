import type { ModelResult } from '../../src/modules/assistant/assistant.types.js';
export const emptyUsage = () => ({
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cachedInputTokens: 0,
});
export type Usage = ReturnType<typeof emptyUsage>;
export function addUsage(total: Usage, result: ModelResult) {
  total.requests++;
  total.inputTokens += result.inputTokens;
  total.outputTokens += result.outputTokens;
  total.reasoningTokens += result.reasoningTokens ?? 0;
  total.cachedInputTokens += result.cachedInputTokens ?? 0;
}
