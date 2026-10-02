/** Dynamic read admission and generic receipts, using only synthetic contracts and evidence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  READ_CONTRACT_KEY,
  admittedReadTool,
  argumentsSha256,
  canonicalJson,
  modelContext,
  readContract,
  sameToolContract,
  schemaAccepts,
} from '../../src/modules/context-engine/read-contract.js';
import type {
  ContextEvidence,
  ContextToolDefinition,
} from '../../src/modules/context-engine/context.types.js';
import {
  toolDelivery,
  toolDeliverySchema,
  toolEvidenceFingerprint,
  verifyToolEvidence,
} from '../../src/modules/assistant/tool-evidence.js';
import { salesEvidence } from '../../scripts/lib/sales-fixture.js';

const now = Date.parse('2026-10-03T06:00:00Z');
const name = 'document_overview';
const args = { filters: { region: 'Fixture Region', tags: ['a', 'b'] }, limit: 2 };
const definition = (): ContextToolDefinition => ({
  name,
  description: 'Read permitted document metadata.',
  inputSchema: { type: 'object' },
  outputSchema: {
    type: 'object',
    required: ['data'],
    properties: {
      data: {
        type: 'object',
        required: ['count'],
        properties: { count: { type: 'integer', minimum: 0 } },
      },
    },
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
  _meta: {
    [READ_CONTRACT_KEY]: { requiredScopes: ['documents:read'], sourceFamily: 'documents' },
  },
});
const evidence = (): ContextEvidence => ({
  source_path: '/api/v1/documents/summary',
  status: 200,
  data: { count: 2, labels: ['Fixture One', 'Fixture Two'] },
  meta: {
    requestId: 'fixture-request',
    generatedAt: new Date(now).toISOString(),
    toolName: name,
    argumentsSha256: argumentsSha256(args),
  },
});

test('new tool names are admitted by explicit authenticated read contracts and current scopes', () => {
  assert.equal(admittedReadTool(definition(), ['documents:read']), true);
  assert.equal(admittedReadTool(definition(), ['crm:read']), false);
  const contextOnly = definition();
  contextOnly._meta = { [READ_CONTRACT_KEY]: { requiredScopes: [] } };
  assert.equal(admittedReadTool(contextOnly, []), true);
  assert.deepEqual(readContract(definition()), {
    requiredScopes: ['documents:read'],
    sourceFamily: 'documents',
  });
});

test('missing, contradictory and malformed dynamic metadata cannot grant a tool', () => {
  const variants: Array<(tool: ContextToolDefinition) => void> = [
    (tool) => {
      delete tool._meta;
    },
    (tool) => {
      delete tool.outputSchema;
    },
    (tool) => {
      delete tool.annotations;
    },
    (tool) => {
      tool.annotations = { readOnlyHint: false };
    },
    (tool) => {
      tool.annotations = { readOnlyHint: true, destructiveHint: true };
    },
    (tool) => {
      tool._meta = { [READ_CONTRACT_KEY]: { requiredScopes: 'documents:read' } };
    },
    (tool) => {
      tool._meta = { [READ_CONTRACT_KEY]: { requiredScopes: ['*'] } };
    },
    (tool) => {
      tool._meta = { [READ_CONTRACT_KEY]: { requiredScopes: [], employeeId: 99 } };
    },
    (tool) => {
      tool.name = 'bad tool\nname';
    },
    (tool) => {
      tool.name = 'x'.repeat(65);
    },
  ];
  for (const mutate of variants) {
    const tool = definition();
    mutate(tool);
    assert.equal(admittedReadTool(tool, ['documents:read']), false);
  }
});

test('remote tool names cannot shadow local recall and utility dispatch', () => {
  for (const reserved of ['recall_business_context', 'calculate', 'web_search', 'read_webpage'])
    assert.equal(admittedReadTool({ ...definition(), name: reserved }, ['documents:read']), false);
});

test('legacy known-tool fallback retains scopes and cannot rescue malformed explicit metadata', () => {
  const legacy: ContextToolDefinition = {
    name: 'search_crm_leads',
    inputSchema: { type: 'object' },
    annotations: { readOnlyHint: true },
  };
  assert.equal(admittedReadTool(legacy, ['crm:read']), true);
  assert.equal(admittedReadTool(legacy, []), false);
  legacy._meta = { [READ_CONTRACT_KEY]: { requiredScopes: 'crm:read' } };
  assert.equal(admittedReadTool(legacy, ['crm:read']), false);
});

test('argument binding is recursive, order-independent for objects, and order-sensitive for arrays', () => {
  const reordered = { limit: 2, filters: { tags: ['a', 'b'], region: 'Fixture Region' } };
  assert.equal(argumentsSha256(args), argumentsSha256(reordered));
  assert.notEqual(
    argumentsSha256(args),
    argumentsSha256({
      ...args,
      filters: { ...args.filters, tags: ['b', 'a'] },
    }),
  );
  assert.notEqual(
    argumentsSha256({ filter: { city: 'Fixture A' } }),
    argumentsSha256({ filter: { city: 'Fixture B' } }),
  );
  assert.equal(
    canonicalJson(JSON.parse('{"z":1,"__proto__":{"safe":true},"a":2}')),
    '{"__proto__":{"safe":true},"a":2,"z":1}',
  );
  const tooDeep: Record<string, unknown> = {};
  let cursor = tooDeep;
  for (let i = 0; i < 50; i++) {
    const child = {};
    cursor.child = child;
    cursor = child;
  }
  assert.throws(() => argumentsSha256(tooDeep));
});

test('changed schema, permission metadata and annotations are different execution contracts', () => {
  const before = definition();
  assert.equal(sameToolContract(before, structuredClone(before)), true);
  for (const mutate of [
    (tool: ContextToolDefinition) => {
      tool.inputSchema = { type: 'object', required: ['q'] };
    },
    (tool: ContextToolDefinition) => {
      tool.outputSchema = { type: 'object', required: ['safe'] };
    },
    (tool: ContextToolDefinition) => {
      tool.annotations = { readOnlyHint: false };
    },
    (tool: ContextToolDefinition) => {
      tool._meta = { [READ_CONTRACT_KEY]: { requiredScopes: ['documents:read', 'finance:read'] } };
    },
  ]) {
    const after = definition();
    mutate(after);
    assert.equal(sameToolContract(before, after), false);
  }
});

test('schema IDs cannot reuse another tool or input/output validator', () => {
  const input = {
    $id: 'https://schemas.example/fixture',
    type: 'object',
    required: ['query'],
    properties: { query: { type: 'string' } },
  };
  const output = {
    $id: input.$id,
    type: 'object',
    required: ['count'],
    properties: { count: { type: 'integer' } },
  };
  assert.equal(schemaAccepts(input, { query: 'fixture' }), true);
  assert.equal(schemaAccepts(output, { query: 'fixture' }), false);
  assert.equal(schemaAccepts(output, { count: 2 }), true);
  assert.equal(schemaAccepts(input, { count: 2 }), false);
});

test('asynchronous and unresolved external schemas fail synchronously before accepting evidence', () => {
  for (const schema of [
    { $async: true, type: 'object' },
    {
      type: 'object',
      properties: { count: { $ref: '#/$defs/count' } },
      $defs: { count: { $async: true, type: 'integer' } },
    },
    { type: 'object', $ref: 'https://schemas.example/unregistered' },
  ])
    assert.throws(() => schemaAccepts(schema, { count: 'invalid' }));
  const asyncOutput = definition();
  asyncOutput.outputSchema = { $async: true, type: 'object' };
  assert.throws(() => verifyToolEvidence(name, args, evidence(), now, asyncOutput));
  assert.equal(schemaAccepts({ type: 'object', $async: false }, {}), true);
});

test('generic evidence validates its live output schema without imposing CRM query semantics', () => {
  const good = evidence();
  good.data.query_context = { as_of: 'Fiscal period label', division: 'Fixture Division' };
  assert.doesNotThrow(() => verifyToolEvidence(name, args, good, now, definition()));
  const bad = evidence();
  bad.data.count = 'two';
  assert.throws(() => verifyToolEvidence(name, args, bad, now, definition()));
  const missing = evidence();
  delete missing.data.count;
  assert.throws(() => verifyToolEvidence(name, args, missing, now, definition()));
});

test('generic evidence must bind the exact called tool and nested arguments', () => {
  for (const mutate of [
    (item: ContextEvidence) => {
      delete item.meta.toolName;
    },
    (item: ContextEvidence) => {
      item.meta.toolName = 'another_document_tool';
    },
    (item: ContextEvidence) => {
      delete item.meta.argumentsSha256;
    },
    (item: ContextEvidence) => {
      item.meta.argumentsSha256 = argumentsSha256({ ...args, limit: 3 });
    },
    (item: ContextEvidence) => {
      item.meta.generatedAt = new Date(now - 120_001).toISOString();
    },
    (item: ContextEvidence) => {
      item.meta.requestId = '';
    },
  ]) {
    const value = evidence();
    mutate(value);
    assert.throws(() => verifyToolEvidence(name, args, value, now, definition()));
  }
});

test('generic source paths reject external, ambiguous, fragmented and traversal citations', () => {
  for (const source_path of [
    'https://attacker.example/api/v1/documents/summary',
    '//attacker.example/api/v1/documents/summary',
    '/api/v1/../../private',
    '/api/v1/%2e%2e/%2e%2e/private',
    '/api/v1/documents/summary#misleading',
    '/api/v1/documents/summary\n',
    '/api/v1/documents\\summary',
  ])
    assert.throws(() =>
      verifyToolEvidence(name, args, { ...evidence(), source_path }, now, definition()),
    );
});

test('generic fingerprints retain every business field even names ignored by known-source normalization', () => {
  const original = evidence();
  original.data = {
    ...original.data,
    source_status: { document: 'approved' },
    source_fetched_at: 'Relevant business value',
    as_of: 'Q1',
    query_context: { as_of: 'Q1' },
    server_clock: { as_of: 'Q1' },
    read_consistency: { transaction_started_at: 'Q1' },
    items: [{ last_polled_at: 'Relevant business value' }],
  };
  original.policy = 'visible fixture policy';
  original.meta.redaction_status = 'unredacted fixture';
  for (const mutate of [
    (value: ContextEvidence) => {
      value.source_path = '/api/v1/documents/another';
    },
    (value: ContextEvidence) => {
      value.meta.toolName = 'another_document_tool';
    },
    (value: ContextEvidence) => {
      value.meta.argumentsSha256 = argumentsSha256({ limit: 99 });
    },
    (value: ContextEvidence) => {
      value.policy = 'CHANGED';
    },
    (value: ContextEvidence) => {
      value.meta.redaction_status = 'CHANGED';
    },
    ...Object.keys(original.data).map((key) => (value: ContextEvidence) => {
      value.data[key] = 'CHANGED';
    }),
  ]) {
    const changed = structuredClone(original);
    mutate(changed);
    assert.notEqual(
      toolEvidenceFingerprint(original, name),
      toolEvidenceFingerprint(changed, name),
    );
    assert.notEqual(toolEvidenceFingerprint(original), toolEvidenceFingerprint(changed));
  }
  const refreshed = structuredClone(original);
  refreshed.meta.requestId = 'new-request';
  refreshed.meta.generatedAt = new Date(now + 1_000).toISOString();
  assert.equal(toolEvidenceFingerprint(original, name), toolEvidenceFingerprint(refreshed, name));
});

test('dynamic receipt schemas preserve new tool bindings while keeping malformed names out', () => {
  const receipt = toolDelivery(
    23,
    [{ id: 'fixture-evidence', tool: name, arguments: args, result: evidence() }],
    now,
  );
  assert.equal(receipt.checks[0]?.tool, name);
  assert.equal(receipt.checks[0]?.fingerprint, toolEvidenceFingerprint(evidence(), name));
  assert.equal(
    toolDeliverySchema.safeParse({
      ...receipt,
      checks: [{ ...receipt.checks[0], tool: 'bad\nname' }],
    }).success,
    false,
  );
});

test('known CRM specialized checks still reject widened sources and misleading pagination', () => {
  const query = { view: 'accessible', limit: 1 };
  const source = salesEvidence('search_crm_leads', query, now);
  assert.doesNotThrow(() => verifyToolEvidence('search_crm_leads', query, source, now));
  const wrong = structuredClone(source);
  wrong.source_path = '/api/v1/documents/summary';
  assert.throws(() => verifyToolEvidence('search_crm_leads', query, wrong, now));
  const bad = structuredClone(source);
  (bad.data.query_context as Record<string, unknown>).returned_count = 100;
  assert.throws(() => verifyToolEvidence('search_crm_leads', query, bad, now));
});

test('planning context removes private identity and unrelated source fields, clones and bounds the projection', () => {
  const raw = {
    employee_id: 23,
    phone: 'PRIVATE_PHONE',
    access_token: 'PRIVATE_TOKEN',
    unrelated_private_rows: ['PRIVATE_DATA'],
    scopes: ['documents:read'],
    read_only: true,
    query_guidance: { document_search: 'Use exact returned IDs.' },
  };
  const projected = modelContext(raw);
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE_|employee_id/);
  assert.deepEqual(projected.scopes, ['documents:read']);
  (projected.query_guidance as Record<string, unknown>).document_search = 'changed';
  assert.equal(raw.query_guidance.document_search, 'Use exact returned IDs.');
  assert.throws(() => modelContext({ context_markdown: 'x'.repeat(32_001) }));
});
