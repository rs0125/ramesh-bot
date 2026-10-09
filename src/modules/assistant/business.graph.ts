import { loadPrompt } from './prompt-files.js';
/** First tool-enabled LangGraph route: natural intent, fixed scoped read, verified facts and deterministic formatting. */
import { END, START, StateGraph, StateSchema } from '@langchain/langgraph';
import { z } from 'zod';
import { modelJsonSchema } from './model-schema.js';
import type { TextModel, StageMetric } from './assistant.types.js';
import type { BusinessReadResult } from './business-reads.js';
import { FORMATTER_PROMPT } from './prompts.js';
import { finishReply } from './style.js';
import { renderFollowups } from './followups.js';
import { notifyToolActivity } from './tool-activity.js';

export const READ_PROMPT_VERSION = 'ramesh-assigned-followups-v1';
export const readIntentSchema = z
  .object({
    intent: z.enum(['chat', 'assigned_followups_today', 'unsupported_business']),
    language: z.enum(['en', 'hi_latn', 'hi']),
    draft: z.string().max(4000),
  })
  .strict();
export const READ_CONVERSER_PROMPT = loadPrompt('legacy-read-converser');

const state = new StateSchema({
  input: z.string(),
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() })),
  audience: z.enum(['dm', 'group']),
  intent: z.enum(['chat', 'assigned_followups_today', 'unsupported_business']).default('chat'),
  language: z.enum(['en', 'hi_latn', 'hi']).default('en'),
  draft: z.string().default(''),
  reply: z.string().default(''),
  business: z.custom<BusinessReadResult>().optional(),
  stages: z.array(z.custom<StageMetric>()).default([]),
});

export function buildBusinessGraph(
  model: TextModel,
  read: (signal: AbortSignal) => Promise<BusinessReadResult>,
  onToolActivity?: () => void,
) {
  return new StateGraph(state)
    .addNode('converser', async (value, config) => {
      const started = Date.now();
      const generated = await model.complete(
        {
          stage: 'converser',
          instructions: `${READ_CONVERSER_PROMPT}\nAudience: ${value.audience}.`,
          messages: [...value.history, { role: 'user', content: value.input }],
          jsonSchema: modelJsonSchema('ramesh_read_intent', readIntentSchema),
        },
        config.signal,
      );
      const decision = readIntentSchema.parse(JSON.parse(generated.text));
      return {
        ...decision,
        stages: [
          {
            stage: 'converser' as const,
            durationMs: Date.now() - started,
            inputTokens: generated.inputTokens,
            outputTokens: generated.outputTokens,
            model: generated.model,
            responseCalls: generated.responseCalls,
          },
        ],
      };
    })
    .addNode('worker', async (value, config) => {
      const started = Date.now();
      const signal = config.signal ?? new AbortController().signal;
      signal.throwIfAborted();
      if (value.audience !== 'group') notifyToolActivity(onToolActivity);
      const business =
        value.audience === 'group' ? { outcome: 'denied' as const } : await read(signal);
      return {
        business,
        stages: [
          ...value.stages,
          {
            stage: 'worker' as const,
            durationMs: Date.now() - started,
            inputTokens: 0,
            outputTokens: 0,
          },
        ],
      };
    })
    .addNode('formatter', async (value, config) => {
      const started = Date.now();
      if (value.business) {
        const language = value.language;
        const reply =
          value.business.outcome === 'verified'
            ? renderFollowups(value.business.facts, language)
            : value.business.outcome === 'denied'
              ? value.audience === 'group'
                ? language === 'en'
                  ? 'Please ask me in a DM for your CRM follow-ups.'
                  : language === 'hi_latn'
                    ? 'Apne CRM follow-ups ke liye mujhe DM mein poochho.'
                    : 'अपने CRM फ़ॉलो-अप के लिए मुझे DM में पूछें।'
                : language === 'en'
                  ? "CRM access isn't available for your account here. You can still chat with me."
                  : language === 'hi_latn'
                    ? 'Aapke account ke liye yahan CRM access available nahi hai. Chat kar sakte hain.'
                    : 'आपके खाते के लिए यहाँ CRM ऐक्सेस उपलब्ध नहीं है। आप मुझसे चैट कर सकते हैं।'
              : language === 'en'
                ? "I couldn't check your follow-ups right now. Please try again shortly."
                : language === 'hi_latn'
                  ? 'Abhi aapke follow-ups check nahi ho paaye. Thodi der mein phir try karein.'
                  : 'अभी आपके फ़ॉलो-अप नहीं देख पाया। थोड़ी देर में फिर कोशिश करें।';
        if (!reply || reply.length > 4000) throw new Error('Invalid business reply');
        return {
          reply,
          stages: [
            ...value.stages,
            {
              stage: 'formatter' as const,
              durationMs: Date.now() - started,
              inputTokens: 0,
              outputTokens: 0,
            },
          ],
        };
      }
      const generated = await model.complete(
        {
          stage: 'formatter',
          instructions: FORMATTER_PROMPT,
          messages: [
            { role: 'user', content: JSON.stringify({ request: value.input, draft: value.draft }) },
          ],
        },
        config.signal,
      );
      const reply = finishReply(generated.text);
      if (!reply || reply.length > 4000) throw new Error('Invalid formatted reply');
      return {
        reply,
        stages: [
          ...value.stages,
          {
            stage: 'formatter' as const,
            durationMs: Date.now() - started,
            inputTokens: generated.inputTokens,
            outputTokens: generated.outputTokens,
            model: generated.model,
            responseCalls: generated.responseCalls,
          },
        ],
      };
    })
    .addEdge(START, 'converser')
    .addConditionalEdges('converser', (value) =>
      value.intent === 'assigned_followups_today' ? 'worker' : 'formatter',
    )
    .addEdge('worker', 'formatter')
    .addEdge('formatter', END)
    .compile();
}
