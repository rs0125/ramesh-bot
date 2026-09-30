/** The real OpenAI SDK runs against a fake fetch; no paid requests occur in CI. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAITextModel } from '../../src/infrastructure/openai/text-model.js';
const config = {
  apiKey: 'synthetic-secret',
  model: 'gpt-5.6-terra',
  timeoutMs: 1000,
  maxOutputTokens: 800,
};
const request = {
  stage: 'converser' as const,
  instructions: 'reply briefly',
  messages: [{ role: 'user' as const, content: 'hello' }],
};

test('Responses request uses Terra, no tools, no response storage, and bounded tokens', async () => {
  const model = new OpenAITextModel(config, async (input, init) => {
    assert.equal(String(input), 'https://api.openai.com/v1/responses');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic-secret');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'gpt-5.6-terra');
    assert.equal(body.store, false);
    assert.equal(body.max_output_tokens, 800);
    assert.deepEqual(body.reasoning, { effort: 'none' });
    assert.equal(body.tools, undefined);
    assert.deepEqual(body.input, request.messages);
    return Response.json({
      id: 'test-response',
      object: 'response',
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'Hey!', annotations: [] }],
        },
      ],
      usage: { input_tokens: 12, output_tokens: 3 },
    });
  });
  assert.deepEqual(await model.complete(request), {
    text: 'Hey!',
    inputTokens: 12,
    outputTokens: 3,
    responseId: 'test-response',
  });
});

test('provider error bodies are redacted and incomplete answers are rejected', async () => {
  const failed = new OpenAITextModel(config, async () =>
    Response.json({ error: { message: 'sensitive body synthetic-secret' } }, { status: 401 }),
  );
  await assert.rejects(failed.complete(request), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'OpenAI request failed (HTTP 401)');
    return true;
  });
  const incomplete = new OpenAITextModel(config, async () =>
    Response.json({ id: 'r', status: 'incomplete', output: [] }),
  );
  await assert.rejects(incomplete.complete(request), /OpenAI request failed/);
});

test('an already cancelled model request performs no fetch', async () => {
  const model = new OpenAITextModel(config, async () => assert.fail('No HTTP request expected'));
  await assert.rejects(model.complete(request, AbortSignal.abort()));
});
