import type { ModelRequest, ModelResult } from '../../src/modules/assistant/assistant.types.js';
/** Deterministic role responses for tests concerned with downstream execution contracts. */
export function planningResult(request: ModelRequest): ModelResult | undefined {
  const text =
    request.jsonSchema?.name === 'ramesh_route'
      ? JSON.stringify({ route: 'work', objective: 'Answer the user request.', reply: '' })
      : request.stage === 'planner'
        ? JSON.stringify({
            objective: 'Answer the user request.',
            successCriteria: ['Give a supported useful answer.'],
            steps: [
              { id: 'read', goal: 'Resolve missing information.', dependsOn: [], toolNames: [] },
            ],
          })
        : undefined;
  return text ? { text, inputTokens: 1, outputTokens: 1 } : undefined;
}
