import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIToolCatalog } from '../../src/infrastructure/openai/tool-catalog.js';
import { OpenAITextModel } from '../../src/infrastructure/openai/text-model.js';
import { loadAssistantConfig } from '../../src/config/assistant.js';

const supported = {
  name: 'search_things',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', maxLength: 5 },
      tags: { type: 'array', items: { type: 'string' }, uniqueItems: true },
    },
    required: ['query'],
    additionalProperties: false,
  },
};
// A free-form map (z.record) cannot be expressed in the provider's strict subset.
const unsupported = {
  name: 'tag_things',
  inputSchema: {
    type: 'object',
    properties: { labels: { type: 'object', additionalProperties: { type: 'string' } } },
    required: ['labels'],
    additionalProperties: false,
  },
};

test('one tool the strict subset cannot express is dropped; the rest still work', () => {
  const catalog = new OpenAIToolCatalog([unsupported, supported], 'eager');
  assert.deepEqual(catalog.dropped, ['tag_things']);
  assert.deepEqual(
    catalog.bindings.map((b) => b.name),
    ['search_things'],
  );
  assert.equal(catalog.bindings[0]!.definition.strict, true);
});

test('arguments violating constraints outside the provider subset come back as field errors', () => {
  const catalog = new OpenAIToolCatalog([supported], 'eager');
  const allowed = ['search_things'];
  assert.deepEqual(
    catalog.arguments('search_things', undefined, allowed, '{"query":"ok","tags":null}'),
    { ok: true, json: '{"query":"ok"}' },
  );
  const tooLong = catalog.arguments(
    'search_things',
    undefined,
    allowed,
    '{"query":"too long","tags":null}',
  );
  assert.equal(tooLong.ok, false);
  assert.ok(!tooLong.ok && tooLong.invalid.errors.some((e) => e.path === '/query'));
  const duplicate = catalog.arguments(
    'search_things',
    undefined,
    allowed,
    '{"query":"ok","tags":["a","a"]}',
  );
  assert.ok(!duplicate.ok && duplicate.invalid.errors.some((e) => e.path === '/tags'));
  // Errors name paths and rules only, never the submitted values.
  assert.ok(!JSON.stringify(tooLong).includes('too long'));
  const notJson = catalog.arguments('search_things', undefined, allowed, '{');
  assert.ok(!notJson.ok && notJson.invalid.code === 'INVALID_ARGUMENTS');
  // Calling a tool outside the allowed list is a protocol violation, not a correctable error.
  assert.throws(
    () => catalog.arguments('search_things', undefined, [], '{}'),
    /UNAVAILABLE_MODEL_TOOL/,
  );
});

test('field errors use the paths the model wrote, without spurious encoding errors', () => {
  const catalog = new OpenAIToolCatalog(
    [
      {
        name: 'edit_thing',
        inputSchema: {
          type: 'object',
          properties: {
            // Required and nullable: null is a real value, not an omission.
            owner: { type: ['string', 'null'] },
            // Optional and nullable: the provider encoding wraps it as {"value": ...}.
            note: { type: ['string', 'null'], maxLength: 4 },
            limit: { type: 'integer', exclusiveMaximum: 10 },
          },
          required: ['owner'],
          additionalProperties: false,
        },
      },
    ],
    'eager',
  );
  const decode = (raw: string) => catalog.arguments('edit_thing', undefined, ['edit_thing'], raw);
  assert.deepEqual(decode('{"owner":null,"note":{"value":null},"limit":null}'), {
    ok: true,
    json: '{"owner":null,"note":null}',
  });
  const longNote = decode('{"owner":null,"note":{"value":"too long"},"limit":null}');
  assert.ok(!longNote.ok);
  assert.ok(longNote.invalid.errors.every((e) => e.path.startsWith('/note')));
  // exclusiveMaximum is outside the provider subset, so it is reported after decoding.
  const overLimit = decode('{"owner":"a","note":null,"limit":10}');
  assert.ok(!overLimit.ok);
  assert.deepEqual(
    overLimit.invalid.errors.map((e) => e.path),
    ['/limit'],
  );
});

test('the model adapter returns an invalid call to the graph instead of failing the step', async () => {
  const config = loadAssistantConfig({ OPENAI_API_KEY: 'fake' })!;
  const model = new OpenAITextModel(config, async () =>
    Response.json({
      id: 'r',
      object: 'response',
      status: 'completed',
      output: [
        {
          type: 'function_call',
          call_id: 'c1',
          name: 'search_things',
          arguments: '{"query":"far too long","tags":null}',
        },
      ],
    }),
  );
  const session = model.startToolSession({
    instructions: 'Search.',
    messages: [],
    tools: [supported, unsupported],
  });
  assert.deepEqual(session.droppedTools, ['tag_things']);
  const result = await session.next(5, AbortSignal.timeout(2000));
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0]!.invalid?.code, 'INVALID_ARGUMENTS');
  assert.ok(result.calls[0]!.invalid?.errors.some((e) => e.path === '/query'));
});
