import test from 'node:test';
import assert from 'node:assert/strict';
import { workingContext } from '../../src/modules/assistant/working-context.js';
import type { ToolEvidence } from '../../src/modules/assistant/tool-evidence.js';

function lead(id: string, description: string): ToolEvidence {
  return {
    id: `source-${id}`,
    tool: 'read_crm_lead',
    arguments: { id },
    result: {
      data: {
        id,
        name: `Client ${id}`,
        requirement_sqft: 50000,
        description: { state: 'present', text: description, truncated: false },
      },
    },
  } as unknown as ToolEvidence;
}

test('fresh brief, explicit user corrections and grouped selections remain distinct', () => {
  const first = lead('a', 'Distribution use; requirement needs verification.');
  const second = lead('b', 'Recreation use; fire documents required.');
  const context = workingContext(
    [first, second],
    [{ role: 'user', content: 'Client a: budget is open.' }],
    'For client a accept 45000 to 60000 sq ft; do not update the CRM.',
    [
      {
        turn: 1,
        displayed_selection: [{ kind: 'warehouse', id: 101, position: 2, group: 'group-1' }],
      },
    ],
  );
  assert.equal(context.recorded_subjects.length, 2);
  assert.equal((context.recorded_subjects[0]!.recorded as any).requirement_sqft, 50000);
  assert.match(JSON.stringify(context.user_directions), /45000 to 60000/);
  assert.match(JSON.stringify(context.selected_groups), /group-1/);
  assert.equal(first.result.data.requirement_sqft, 50000);
  assert.deepEqual(context.recorded_subjects[0]!.sources, [
    { evidence_id: 'source-a', pointer: '/data' },
  ]);
});

test('search hits alone do not select a brief; missing fresh evidence does not restore old facts', () => {
  const search = { ...lead('a', 'Historical brief'), tool: 'search_crm_leads' } as ToolEvidence;
  const context = workingContext(
    [search],
    [{ role: 'assistant', content: 'Private reply withheld.' }],
    'Compare the earlier options.',
    [],
  );
  assert.deepEqual(context.recorded_subjects, []);
  assert.deepEqual(context.user_directions.prior_requests, []);
});

test('large multilingual briefs retain source references and explicit partial markers within budget', () => {
  const evidence = Array.from({ length: 4 }, (_, i) => lead(String(i), 'अ'.repeat(80000)));
  const before = structuredClone(evidence);
  const context = workingContext(
    evidence,
    [{ role: 'user', content: 'अ'.repeat(80000) }],
    'अ'.repeat(80000),
    [{ turn: 1, displayed_selection: Array(100).fill({ id: 101, group: 'group-1', position: 1 }) }],
  );
  assert.ok(Buffer.byteLength(JSON.stringify(context)) <= 14000);
  assert.ok(context.recorded_subjects.length > 0);
  assert.ok(context.recorded_subjects.every((subject) => Array.isArray(subject.sources)));
  assert.match(JSON.stringify(context), /truncated/);
  assert.deepEqual(evidence, before);
});
