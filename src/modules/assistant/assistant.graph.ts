/** Two explicit LangGraph nodes. Generation has no database or messaging side effects. */
import { END, START, StateGraph, StateSchema } from '@langchain/langgraph';
import { z } from 'zod';
import type { TextModel, StageMetric } from './assistant.types.js';
import { CONVERSER_PROMPT, FORMATTER_PROMPT } from './prompts.js';
import { finishReply } from './style.js';

export const AssistantState = new StateSchema({
  input: z.string().min(1).max(40000),
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() })),
  audience: z.enum(['dm', 'group']),
  draft: z.string().default(''),
  reply: z.string().default(''),
  stages: z
    .array(
      z.object({
        stage: z.enum(['converser', 'formatter', 'judge']),
        durationMs: z.number(),
        inputTokens: z.number(),
        outputTokens: z.number(),
      }),
    )
    .default([]),
});

export function buildAssistantGraph(model: TextModel) {
  const converser: typeof AssistantState.Node = async (state, config) => {
    const started = Date.now();
    const result = await model.complete(
      {
        stage: 'converser',
        instructions: `${CONVERSER_PROMPT}\nThe current audience is ${state.audience === 'group' ? 'a group chat. Keep replies appropriate for everyone present. Do not infer private context about other participants or encourage posting private lead, HR, or contact records in the group. Suggest a direct message for private discussions; you cannot initiate one yourself' : 'a direct message'}.`,
        messages: [...state.history, { role: 'user', content: state.input }],
      },
      config.signal,
    );
    return {
      draft: result.text,
      stages: [
        {
          stage: 'converser',
          durationMs: Date.now() - started,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        } satisfies StageMetric,
      ],
    };
  };
  const formatter: typeof AssistantState.Node = async (state, config) => {
    const started = Date.now();
    const result = await model.complete(
      {
        stage: 'formatter',
        instructions: FORMATTER_PROMPT,
        messages: [
          { role: 'user', content: JSON.stringify({ request: state.input, draft: state.draft }) },
        ],
      },
      config.signal,
    );
    const reply = finishReply(result.text);
    if (!reply || reply.length > 4000) throw new Error('Invalid formatted reply');
    return {
      reply,
      stages: [
        ...state.stages,
        {
          stage: 'formatter',
          durationMs: Date.now() - started,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        } satisfies StageMetric,
      ],
    };
  };
  return new StateGraph(AssistantState)
    .addNode('converser', converser)
    .addNode('formatter', formatter)
    .addEdge(START, 'converser')
    .addEdge('converser', 'formatter')
    .addEdge('formatter', END)
    .compile();
}
