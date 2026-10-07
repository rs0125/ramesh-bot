import test from 'node:test';
import assert from 'node:assert/strict';
import {
  answerReviewSchema,
  resolveAnswerReview,
  preservesAnswerFacts,
  type ExecutionReport,
} from '../../src/modules/assistant/answer-review.js';
import type { ToolEvidence } from '../../src/modules/assistant/tool-evidence.js';

const evidence = [
  {
    id: 'source-1',
    tool: 'search_warehouses',
    arguments: {},
    result: {
      data: {
        items: [
          { id: 101, fire_noc_available: true, total_space_sqft: [67500] },
          { id: 202, fire_noc_available: false },
        ],
      },
    },
  },
] as unknown as ToolEvidence[];
const execution: ExecutionReport = {
  research_limited: true,
  tools: { read_warehouse: { status: 'not_attempted', attempts: 0, successes: 0 } },
};
const answer = 'Start with ID 101.\nID 101: Fire NOC is unavailable.\nConfirm the documents.';
const finding = () => ({
  severity: 'blocking',
  kind: 'factual',
  message: 'Wrong recorded status.',
  quote: 'ID 101: Fire NOC is unavailable.',
  replacement: 'ID 101: Fire NOC is recorded as available.',
  references: [
    {
      evidence_id: 'source-1',
      pointer: '/data/items/0/fire_noc_available',
      value_json: 'true',
      record_id: '101',
    },
  ],
});
const review = (findings: unknown[] = [finding()]) =>
  answerReviewSchema.parse({
    supported: false,
    feedback: 'Correct the recorded status.',
    repair: 'format',
    reason: 'unsupported_claim',
    remainder_supported: true,
    findings,
  });

test('source-bound repair changes only the reviewed span and preserves ranking and caveats', () => {
  const result = resolveAnswerReview(review(), answer, evidence, execution, true);
  assert.equal(result.supported, false);
  assert.equal(
    result.patchedAnswer,
    'Start with ID 101.\nID 101: Fire NOC is recorded as available.\nConfirm the documents.',
  );
});

test('review cannot transfer a field between records or use retired evidence', () => {
  const cases = [
    { pointer: '/data/items/1/fire_noc_available', value_json: 'false', record_id: '101' },
    { pointer: '/data/items/1/fire_noc_available', value_json: 'false', record_id: '202' },
    { value_json: 'false' },
    { evidence_id: 'retired-source' },
    { pointer: '/data/__proto__/fire_noc_available' },
    {
      pointer: '/data/items/0',
      value_json: JSON.stringify(evidence[0]!.result.data.items),
      record_id: null,
    },
  ];
  for (const change of cases) {
    const item = finding();
    Object.assign(item.references[0]!, change);
    const result = resolveAnswerReview(review([item]), answer, evidence, execution, true);
    assert.equal(result.supported, false);
    assert.equal(result.patchedAnswer, undefined);
    assert.doesNotMatch(result.feedback, /Fire NOC is recorded as available/);
  }
});

test('area references need scalar leaves and cannot patch an unlabelled aggregate claim', () => {
  const quote = 'ID 101: 67000 sq ft.';
  const correction = {
    ...finding(),
    quote,
    replacement: 'ID 101: 67500 sq ft.',
    references: [
      {
        evidence_id: 'source-1',
        pointer: '/data/items/0/total_space_sqft',
        value_json: '[67500]',
        record_id: '101',
      },
    ],
  };
  assert.equal(
    resolveAnswerReview(review([correction]), quote, evidence, execution, true).patchedAnswer,
    undefined,
  );
  Object.assign(correction.references[0]!, {
    pointer: '/data/items/0/total_space_sqft/0',
    value_json: '67500',
  });
  const scalar = resolveAnswerReview(review([correction]), quote, evidence, execution, true);
  assert.equal(scalar.patchedAnswer, correction.replacement);
  assert.equal(scalar.supported, false);

  correction.quote = 'These are the closest candidates.';
  correction.replacement = 'These are provisional candidates.';
  const aggregate = resolveAnswerReview(
    review([correction]),
    correction.quote,
    evidence,
    execution,
    true,
  );
  assert.equal(aggregate.patchedAnswer, undefined);
  assert.equal(aggregate.repair, 'tools');
  const independent = review([{ ...correction, replacement: null }]);
  independent.repair = 'tools';
  const revision = resolveAnswerReview(independent, correction.quote, evidence, execution, true);
  assert.equal(revision.patchedAnswer, undefined);
  assert.equal(revision.supported, false);
  assert.equal(revision.repair, 'tools');
});

test('ambiguous, overlapping, missing and entity-free spans do not get patched', () => {
  assert.equal(
    resolveAnswerReview(review(), answer + '\n' + finding().quote, evidence, execution, true)
      .supported,
    false,
  );
  assert.equal(
    resolveAnswerReview(review([finding(), finding()]), answer, evidence, execution, true)
      .supported,
    false,
  );
  for (const quote of ['not in answer', 'Fire NOC is unavailable.']) {
    assert.equal(
      resolveAnswerReview(review([{ ...finding(), quote }]), answer, evidence, execution, true)
        .supported,
      false,
    );
  }
});

test('rejected factual presentation patches retain diagnostics without applying their replacement', () => {
  const diagnostic = 'Both CRM entries are missing their native Created and Last updated dates.';
  const value = review([
    {
      severity: 'blocking',
      kind: 'presentation',
      message: diagnostic,
      quote: 'Client A',
      replacement: 'Client A\nCreated: 7 Oct 2026. Last updated: 8 Oct 2026.',
      references: [],
    },
  ]);
  value.feedback = 'Use the native dates already present in the evidence.';
  const resolved = resolveAnswerReview(value, 'Client A', evidence, execution, true);
  assert.equal(resolved.supported, false);
  assert.equal(resolved.repair, 'tools');
  assert.equal(resolved.patchedAnswer, undefined);
  assert.ok(resolved.feedback.includes(diagnostic));
  assert.ok(resolved.feedback.includes(value.feedback));
  assert.match(resolved.feedback, /Unvalidated review diagnostics/);
  assert.doesNotMatch(resolved.feedback, /Created: 7 Oct|Last updated: 8 Oct/);
});

test('repair cannot introduce an unsupported number or replace a selected identity', () => {
  for (const replacement of ['ID 101: Fire NOC available; 9 docks.', 'ID 202: Fire NOC available.'])
    assert.equal(
      resolveAnswerReview(
        review([{ ...finding(), replacement }]),
        answer,
        evidence,
        execution,
        true,
      ).supported,
      false,
    );
});

test('optional missing details do not veto an otherwise supported shortlist', () => {
  const value = review([
    {
      severity: 'suggestion',
      kind: 'scope',
      message: 'Ask about gate width.',
      quote: '',
      replacement: null,
      references: [],
    },
  ]);
  value.reason = 'incomplete_answer';
  const result = resolveAnswerReview(value, answer, evidence, execution, true);
  assert.equal(result.supported, true);
  assert.equal(result.patchedAnswer, undefined);
  value.remainder_supported = false;
  assert.equal(resolveAnswerReview(value, answer, evidence, execution, true).supported, false);
  value.remainder_supported = true;
  value.reason = 'access';
  assert.equal(resolveAnswerReview(value, answer, evidence, execution, true).supported, false);
});

test('a typed execution status fixes an invented timeout without rewriting the shortlist', () => {
  const value = review([
    {
      severity: 'blocking',
      kind: 'execution_status',
      message: 'Not attempted.',
      quote: 'Detail reads timed out.',
      replacement: 'Detail reads were not completed.',
      references: [
        {
          evidence_id: 'execution',
          pointer: '/data/tools/read_warehouse/status',
          value_json: '"not_attempted"',
          record_id: null,
        },
      ],
    },
  ]);
  const result = resolveAnswerReview(
    value,
    'Detail reads timed out.\nID 101 is provisional.',
    evidence,
    execution,
    true,
  );
  assert.equal(result.supported, false);
  assert.equal(result.patchedAnswer, 'Detail reads were not completed.\nID 101 is provisional.');
  value.findings[0]!.references[0]!.value_json = '"timed_out"';
  assert.equal(
    resolveAnswerReview(value, 'Detail reads timed out.', evidence, execution, true).supported,
    false,
  );
});

test('mutation reviews and incomplete coverage retain explicit rejection', () => {
  assert.equal(resolveAnswerReview(review(), answer, evidence, execution, false).supported, false);
  const incomplete = review();
  incomplete.remainder_supported = false;
  assert.equal(resolveAnswerReview(incomplete, answer, evidence, execution, true).supported, false);
  const legacy = answerReviewSchema.parse({ supported: false, feedback: 'Get missing evidence.' });
  assert.equal(resolveAnswerReview(legacy, answer, evidence, execution, true).supported, false);
  const contradictory = review();
  contradictory.supported = true;
  assert.equal(
    resolveAnswerReview(contradictory, answer, evidence, execution, false).supported,
    false,
  );
});

test('recordless assessment pointers cannot correct another client brief', () => {
  const scoped = [
    {
      id: 'assessment',
      tool: 'assess_shortlist',
      arguments: { lead_id: 'client-a' },
      result: {
        data: {
          lead: { id: 'client-a', name: 'Client A' },
          requirement_context: { description: { text: 'Distribution use' } },
        },
      },
    },
  ] as unknown as ToolEvidence[];
  const value = review([
    {
      severity: 'blocking',
      kind: 'scope',
      message: 'Wrong use.',
      quote: 'Client B needs storage.',
      replacement: 'Client B needs distribution use.',
      references: [
        {
          evidence_id: 'assessment',
          pointer: '/data/requirement_context/description/text',
          value_json: '"Distribution use"',
          record_id: null,
        },
      ],
    },
  ]);
  assert.equal(
    resolveAnswerReview(value, 'Client B needs storage.', scoped, execution, true).patchedAnswer,
    undefined,
  );
  value.findings[0]!.references[0]!.record_id = 'client-a';
  assert.equal(
    resolveAnswerReview(value, 'Client B needs storage.', scoped, execution, true).patchedAnswer,
    undefined,
  );
});

test('a valid numeric citation cannot introduce acres or reverse candidates', () => {
  const area = {
    ...finding(),
    quote: 'ID 101: 67500 sq ft.',
    replacement: 'ID 101: 67500 acres.',
    references: [
      {
        evidence_id: 'source-1',
        pointer: '/data/items/0/total_space_sqft/0',
        value_json: '67500',
        record_id: '101',
      },
    ],
  };
  assert.equal(
    resolveAnswerReview(review([area]), area.quote, evidence, execution, true).patchedAnswer,
    undefined,
  );
  const reordered = {
    ...finding(),
    quote: 'ID 101 then ID 202.',
    replacement: 'ID 202 then ID 101.',
    references: [
      finding().references[0]!,
      {
        evidence_id: 'source-1',
        pointer: '/data/items/1/fire_noc_available',
        value_json: 'false',
        record_id: '202',
      },
    ],
  };
  assert.equal(
    resolveAnswerReview(review([reordered]), reordered.quote, evidence, execution, true)
      .patchedAnswer,
    undefined,
  );
});

test('presentation repair cannot change meaning; legacy rewrites cannot change IDs, units or quantities', () => {
  const edit = {
    severity: 'blocking',
    kind: 'presentation',
    message: 'Fix WhatsApp bold.',
    quote: '**Available**',
    replacement: '*Available*',
    references: [],
  };
  assert.equal(
    resolveAnswerReview(review([edit]), '**Available**', evidence, execution, true).supported,
    true,
  );
  edit.replacement = 'Unavailable';
  assert.equal(
    resolveAnswerReview(review([edit]), '**Available**', evidence, execution, true).supported,
    false,
  );
  const original = 'ID 101: 67,500 sq ft. ID 202: 40 ft height.';
  assert.equal(
    preservesAnswerFacts(original, '*ID 101*: 67500 sqft. *ID 202*: 40 feet height.'),
    true,
  );
  assert.equal(preservesAnswerFacts(original, 'ID 202 then ID 101.'), false);
  assert.equal(preservesAnswerFacts(original, 'ID 101: 6.75 acres.'), false);
  assert.equal(preservesAnswerFacts(original, 'ID 101: 40 acres.'), false);
});
