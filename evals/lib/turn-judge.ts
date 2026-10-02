/** Causal evaluation: a judge never sees user turns that had not happened yet. */
import { z } from 'zod';
import type { TextModel, ModelResult } from '../../src/modules/assistant/assistant.types.js';
import { evidenceClocks, parseVerdict, verdictSchema } from './judge.js';
export interface JudgedTurn {
  text: string;
  reply: string;
  evidence?: unknown;
  [key: string]: unknown;
}
export function turnJudgeInput(
  expectation: string | readonly string[],
  turns: JudgedTurn[],
  index: number,
  category?: string,
) {
  if (!turns[index]) throw new Error('INVALID_JUDGE_TURN_INDEX');
  if (Array.isArray(expectation) && expectation.length !== turns.length)
    throw new Error('INVALID_TURN_EXPECTATIONS');
  const current = turns[index]!;
  // Legacy descriptions mix future corrections and expected verdicts, including
  // one-turn calibration cases. Keep them out of model input. Only explicitly
  // turn-scoped, verdict-free rubrics may supplement the shared instructions.
  const currentExpectation = Array.isArray(expectation) ? expectation[index] : undefined;
  return {
    application_context: { name: 'Ramesh', organization: 'WareOnGo', role: 'personal assistant' },
    evaluation_mode: 'one delivered turn; future messages are deliberately unavailable',
    ...(currentExpectation ? { current_turn_expectation: currentExpectation } : {}),
    category,
    preceding_conversation: turns
      .slice(0, index)
      .map((t) => ({ user: t.text, assistant: t.reply })),
    turns: [{ ...current, turn: 1, evidence_clocks: evidenceClocks(current.evidence) }],
  };
}
export async function judgeTurns(
  model: TextModel,
  instructions: string,
  expectation: string | readonly string[],
  turns: JudgedTurn[],
  signal: AbortSignal,
  onUsage: (result: ModelResult) => void = () => {},
  category?: string,
) {
  if (!turns.length) throw new Error('INVALID_JUDGE_TURNS');
  const verdicts: ReturnType<typeof parseVerdict>['turns'] = [];
  for (let index = 0; index < turns.length; index++) {
    signal.throwIfAborted();
    const result = await model.complete(
      {
        stage: 'judge',
        reasoningEffort: 'medium',
        instructions,
        messages: [
          {
            role: 'user',
            content: JSON.stringify(turnJudgeInput(expectation, turns, index, category)),
          },
        ],
        jsonSchema: { name: 'causal_turn_verdict', schema: z.toJSONSchema(verdictSchema) },
      },
      AbortSignal.any([signal, AbortSignal.timeout(90000)]),
    );
    onUsage(result);
    const verdict = parseVerdict(result.text, 1).turns[0]!;
    verdicts.push({ ...verdict, turn: index + 1 });
  }
  return parseVerdict(JSON.stringify({ turns: verdicts }), turns.length);
}
