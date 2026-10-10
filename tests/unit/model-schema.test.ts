/** Every production structured response uses the real provider-compatible conversion. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { modelJsonSchema } from '../../src/modules/assistant/model-schema.js';
import { supplementSchema } from '../../src/modules/assistant/sales.graph.js';
import { routeSchema, taskPlanSchema } from '../../src/modules/assistant/task-plan.js';
import { answerReviewSchema } from '../../src/modules/assistant/answer-review.js';
import { summarySchema } from '../../src/modules/assistant/chat-context.js';
import { readIntentSchema } from '../../src/modules/assistant/business.graph.js';
import { schemaAccepts } from '../../src/modules/context-engine/read-contract.js';
import { assertStrictResponseSchema } from '../fixtures/strict-response-schema.js';

for (const [name, schema] of Object.entries({
  route: routeSchema,
  plan: taskPlanSchema,
  review: answerReviewSchema,
  summary: summarySchema,
  readIntent: readIntentSchema,
  actionSupplement: supplementSchema,
  personalSupplement: supplementSchema,
})) {
  test(`${name} has a supported strict response schema`, () => {
    assertStrictResponseSchema(modelJsonSchema(name, schema).schema);
  });
}

test('action composition accepts empty/text/card supplements and rejects malformed card fields', () => {
  const schema = modelJsonSchema('action', supplementSchema).schema;
  for (const additional_reply of [
    '',
    'Useful additional answer.',
    {
      answer_blocks: [
        { kind: 'text', text: 'Current records' },
        {
          kind: 'crm_record',
          record_id: 'record-1',
          body: 'Recorded requirement',
          include_time: false,
        },
      ],
    },
  ]) {
    assert.equal(schemaAccepts(schema, { additional_reply }), true);
    assert.equal(supplementSchema.safeParse({ additional_reply }).success, true);
  }
  for (const block of [
    { kind: 'invented', text: 'Not a valid block' },
    { kind: 'crm_record', record_id: '', body: 'Missing binding', include_time: false },
    { kind: 'text', text: 'Extra field', record_id: 'record-1' },
  ])
    assert.equal(schemaAccepts(schema, { additional_reply: { answer_blocks: [block] } }), false);
  // This incident would pass a generic JSON Schema validator but fail the API contract.
  assert.throws(() => assertStrictResponseSchema(z.toJSONSchema(supplementSchema)), /oneOf/);
});

test('the review schema defines each finding kind for the verifier', () => {
  const schema = JSON.stringify(modelJsonSchema('ramesh_sales_review', answerReviewSchema));
  // A missing step is scope; execution_status is reserved for claims that something happened.
  assert.match(schema, /scope: part of the request is missing or was not attempted/);
  assert.match(schema, /execution_status: the answer claims a tool ran/);
});
