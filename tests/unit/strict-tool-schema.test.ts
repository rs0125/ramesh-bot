import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { strictToolSchema } from '../../src/infrastructure/openai/strict-tool-schema.js';
import { assertStrictResponseSchema } from '../fixtures/strict-response-schema.js';
import { schemaAccepts } from '../../src/modules/context-engine/read-contract.js';
import {
  PersonalToolRun,
  type PersonalRepositoryPort,
} from '../../src/modules/scheduling/personal-tools.js';
import { UtilityToolRun } from '../../src/modules/assistant/utility-tools.js';
import { recallDefinition } from '../../src/modules/assistant/business-recall.js';

test('strict transport preserves omission, explicit clears and literal falsy values', () => {
  const source = z.toJSONSchema(
    z
      .object({
        id: z.string(),
        changes: z
          .object({
            label: z.string().nullable().optional(),
            count: z.number().optional(),
            enabled: z.boolean().optional(),
            items: z.array(z.string().nullable()).optional(),
          })
          .strict(),
      })
      .strict(),
  );
  const before = structuredClone(source);
  const codec = strictToolSchema(source);
  assertStrictResponseSchema(codec.schema);
  const base = { id: 'record', changes: { label: null, count: null, enabled: null, items: null } };
  assert.deepEqual(codec.decode(base), { id: 'record', changes: {} });
  assert.deepEqual(
    codec.decode({
      ...base,
      changes: { label: { value: null }, count: 0, enabled: false, items: [null, ''] },
    }),
    {
      id: 'record',
      changes: { label: null, count: 0, enabled: false, items: [null, ''] },
    },
  );
  assert.deepEqual(codec.decode({ ...base, changes: { ...base.changes, label: { value: '' } } }), {
    id: 'record',
    changes: { label: '' },
  });
  for (const changes of [
    {},
    { ...base.changes, label: 'unwrapped' },
    { ...base.changes, label: { value: null, extra: true } },
    { ...base.changes, extra: 'unauthorized' },
  ])
    assert.throws(() => codec.decode({ id: 'record', changes }));
  assert.throws(() => codec.decode({ ...base, id: null }));
  assert.deepEqual(source, before, 'provider adaptation must not mutate the business contract');
});

test('nested discriminated changes preserve task deadlines and nullable array items', () => {
  const source = z.toJSONSchema(
    z
      .object({
        operations: z.array(
          z.discriminatedUnion('kind', [
            z
              .object({
                kind: z.literal('create'),
                text: z.string(),
                deadline: z.string().optional(),
              })
              .strict(),
            z
              .object({
                kind: z.literal('update'),
                id: z.string(),
                deadline: z.string().nullable().optional(),
              })
              .strict(),
          ]),
        ),
      })
      .strict(),
  );
  const codec = strictToolSchema(source);
  assertStrictResponseSchema(codec.schema);
  assert.deepEqual(
    codec.decode({
      operations: [
        { kind: 'create', text: 'Call supplier', deadline: null },
        { kind: 'update', id: 'a', deadline: null },
        { kind: 'update', id: 'b', deadline: { value: null } },
        { kind: 'update', id: 'c', deadline: { value: '2026-10-12' } },
      ],
    }),
    {
      operations: [
        { kind: 'create', text: 'Call supplier' },
        { kind: 'update', id: 'a' },
        { kind: 'update', id: 'b', deadline: null },
        { kind: 'update', id: 'c', deadline: '2026-10-12' },
      ],
    },
  );
});

test('constraints outside the provider subset are still checked before execution', () => {
  const source = {
    type: 'object',
    properties: {
      ids: { type: 'array', items: { type: 'string' }, uniqueItems: true },
      amount: { type: 'number', exclusiveMinimum: 0 },
    },
    required: ['ids', 'amount'],
    additionalProperties: false,
  };
  const codec = strictToolSchema(source);
  assert.throws(() => codec.decode({ ids: ['a', 'a'], amount: 1 }));
  assert.throws(() => codec.decode({ ids: ['a'], amount: 0 }));
  assert.deepEqual(codec.decode({ ids: ['a'], amount: 0.01 }), { ids: ['a'], amount: 0.01 });
  // Losing oneOf exclusivity would allow this value through two branches.
  const exclusive = strictToolSchema({
    type: 'object',
    properties: {
      choice: { oneOf: [{ type: 'integer' }, { type: 'number' }] },
    },
    required: ['choice'],
    additionalProperties: false,
  });
  assert.throws(() => exclusive.decode({ choice: 1 }));
  assert.deepEqual(exclusive.decode({ choice: 1.5 }), { choice: 1.5 });
  const patterns = strictToolSchema({
    type: 'object',
    properties: {
      label: {
        type: 'string',
        allOf: [{ pattern: '^A' }, { pattern: 'Z$' }],
      },
    },
    required: ['label'],
    additionalProperties: false,
  });
  assertStrictResponseSchema(patterns.schema);
  assert.deepEqual(patterns.decode({ label: 'ABZ' }), { label: 'ABZ' });
  assert.throws(() => patterns.decode({ label: 'ABC' }));
  assert.throws(() => patterns.decode({ label: 'BCZ' }));
});

test('local references are resolved without dropping constraints or accepting remote schemas', () => {
  const source = {
    type: 'object',
    properties: { name: { $ref: '#/$defs/name' } },
    $defs: { name: { type: 'string', minLength: 2 } },
    additionalProperties: false,
  };
  const codec = strictToolSchema(source);
  assertStrictResponseSchema(codec.schema);
  assert.deepEqual(codec.decode({ name: null }), {});
  assert.deepEqual(codec.decode({ name: 'AB' }), { name: 'AB' });
  assert.throws(() => codec.decode({ name: 'A' }));
  for (const schema of [
    { type: 'object', additionalProperties: { type: 'string' } },
    { type: 'object', properties: { value: { $ref: 'https://example.invalid/schema' } } },
    {
      type: 'object',
      properties: { value: { $ref: '#/$defs/value' } },
      $defs: { value: { $ref: '#/$defs/value' } },
    },
    { type: 'object', patternProperties: { '.*': { type: 'string' } } },
  ])
    assert.throws(() => strictToolSchema(schema), /UNSUPPORTED_STRICT_TOOL_SCHEMA/);
});

test('captured read and CRM write catalogues all produce strict provider schemas', async () => {
  for (const file of ['context-tool-catalogue.json', 'transcript-tool-catalogue.json']) {
    const tools = JSON.parse(
      await readFile(new URL(`../fixtures/${file}`, import.meta.url), 'utf8'),
    );
    for (const tool of tools) {
      const codec = strictToolSchema(tool.inputSchema);
      assertStrictResponseSchema(codec.schema);
      const empty = Object.fromEntries(
        Object.keys(codec.schema.properties as object).map((name) => [name, null]),
      );
      if (!tool.inputSchema.required?.length) {
        assert.deepEqual(codec.decode(empty), {}, tool.name);
        assert.equal(schemaAccepts(tool.inputSchema, codec.decode(empty)), true);
      }
    }
  }
});

test('local utilities and business recall retain their optional argument contracts', () => {
  const utilities = new UtilityToolRun('synthetic', async () => {
    throw new Error('No network expected');
  });
  for (const tool of [...utilities.tools, recallDefinition])
    assertStrictResponseSchema(strictToolSchema(tool.inputSchema).schema);
  const calculator = strictToolSchema(
    utilities.tools.find((tool) => tool.name === 'calculate')!.inputSchema,
  );
  assert.deepEqual(
    calculator.decode({ expression: '20 * 3000', conversion: null, decimal_places: 0 }),
    { expression: '20 * 3000', decimal_places: 0 },
  );
});

test('actual personal tools retain an unchanged deadline separately from an explicit removal', () => {
  const actor = {
    employeeId: 7,
    phoneE164: '+919999000111',
    chatId: '919999000111@s.whatsapp.net',
  };
  const run = new PersonalToolRun(
    {} as PersonalRepositoryPort,
    async () => actor,
    actor,
    {
      runId: 'schema-check',
      key: { remoteJid: actor.chatId },
      checkpointLease: { leaseToken: 'offline' },
      commandMessages: [{ id: 'm1', text: 'Change the task', receivedAtMs: 1, forwarded: false }],
    },
    () => 1,
  );
  for (const tool of run.tools)
    assertStrictResponseSchema(strictToolSchema(tool.inputSchema).schema);
  const codec = strictToolSchema(
    run.tools.find((tool) => tool.name === 'personal_apply')!.inputSchema,
  );
  const operation = {
    kind: 'task_update',
    source: { messageId: 'm1', quote: 'Change the task' },
    target: { id: 'task', expectedVersion: 4 },
    text: 'New task text',
    deadline: null,
  };
  const { deadline: _, ...unchanged } = operation;
  assert.deepEqual(codec.decode({ operations: [operation] }), { operations: [unchanged] });
  assert.deepEqual(codec.decode({ operations: [{ ...operation, deadline: { value: null } }] }), {
    operations: [{ ...unchanged, deadline: null }],
  });
});
