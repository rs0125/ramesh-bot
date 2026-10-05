/** End-to-end graph regressions from genericized failed conversations. No model/network calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSalesGraph } from '../../src/modules/assistant/sales.graph.js';
import type { ModelRequest, TextModel } from '../../src/modules/assistant/assistant.types.js';
import { createSalesFixture, FIXTURE_JID } from '../../scripts/lib/sales-fixture.js';
import { planningResult } from '../fixtures/planning-model.js';

const output = (text: string) => ({ text, inputTokens: 1, outputTokens: 1 });
async function run(
  draft: string,
  review: (request: ModelRequest, pass: number) => unknown,
  options: {
    search?: boolean;
    revisedDraft?: string;
    onRevise?: () => void;
    formatter?: (request: ModelRequest) => string;
    researchDeadlineMs?: number;
  } = {},
) {
  const fixture = createSalesFixture();
  fixture.state.messyWarehouseFacts = options.search === true;
  fixture.state.mutate = (source, tool) => {
    if (tool === 'read_warehouse') {
      source.data.fire_noc_available = true;
      source.data.total_space_sqft = [26000];
    }
  };
  const requests: ModelRequest[] = [];
  const revisions: string[] = [];
  let count = 0;
  let workerCalls = 0;
  let accepted: any;
  const model: TextModel = {
    startToolSession() {
      let read = false;
      let revised = false;
      return {
        async next() {
          workerCalls++;
          if (!read) {
            read = true;
            return {
              ...output(''),
              calls: [
                options.search
                  ? { id: 'read-1', name: 'search_warehouses', arguments: '{"city":"Bengaluru"}' }
                  : { id: 'read-1', name: 'read_warehouse', arguments: '{"id":101}' },
              ],
            };
          }
          return { ...output(revised ? (options.revisedDraft ?? draft) : draft), calls: [] };
        },
        accept(_id, value) {
          accepted = value;
        },
        revise(feedback) {
          revisions.push(feedback);
          revised = true;
          options.onRevise?.();
        },
      };
    },
    async complete(request) {
      requests.push(request);
      const plan = planningResult(request);
      if (plan) return plan;
      if (request.stage === 'verifier') return output(JSON.stringify(review(request, ++count)));
      if (request.stage === 'formatter' && options.formatter)
        return output(options.formatter(request));
      // A formatter rewrite would reproduce the original failure: reverse ranking/change units.
      throw new Error('A completed worker answer must not be freely rewritten');
    },
  };
  const graph = buildSalesGraph(
    model,
    (signal) =>
      fixture.service.openTools(
        {
          runId: 'finalization-test',
          key: { remoteJid: FIXTURE_JID },
        },
        signal,
      ),
    { researchDeadlineMs: options.researchDeadlineMs },
  );
  const result = await graph.invoke({
    input: 'Compare the selected warehouses and recommend a visit.',
    history: [],
    audience: 'dm',
  });
  return { result, requests, accepted, revisions, workerCalls };
}

test('completed worker recommendation and units survive formatting without another model call', async () => {
  const draft =
    'Start with ID 101.\nID 101: 26,000 sq ft, recorded Fire NOC available. Verify documents.';
  const { result, requests, accepted } = await run(draft, (request) => {
    const payload = JSON.parse(request.messages[0]!.content);
    assert.equal(payload.answer, draft);
    assert.equal(payload.execution_status.tools.read_warehouse.status, 'completed');
    assert.equal(payload.execution_status.tools.assess_shortlist.status, 'not_attempted');
    return { supported: true, feedback: '', repair: 'none' };
  });
  assert.equal(result.reply, draft);
  assert.equal(result.unavailable, false);
  assert.equal(requests.filter((r) => r.stage === 'formatter').length, 0);
  assert.ok(accepted.runtime_budget.evidence_remaining_bytes > 0);
});

test('exact factual repair is re-reviewed without rewriting any other sentence', async () => {
  const draft =
    'Start with ID 101.\nID 101: Fire NOC is recorded as unavailable.\nVerify documents.';
  const patched = draft.replace('as unavailable', 'as available');
  const { result, requests } = await run(draft, (request, pass) => {
    const payload = JSON.parse(request.messages[0]!.content);
    if (pass === 2) {
      assert.equal(payload.answer, patched);
      return { supported: true, feedback: '', repair: 'none' };
    }
    const source = payload.evidence.find((e: any) => e.tool === 'read_warehouse');
    return {
      supported: false,
      feedback: '',
      repair: 'format',
      reason: 'unsupported_claim',
      remainder_supported: true,
      findings: [
        {
          severity: 'blocking',
          kind: 'factual',
          message: 'Correct the recorded flag.',
          quote: 'ID 101: Fire NOC is recorded as unavailable.',
          replacement: 'ID 101: Fire NOC is recorded as available.',
          references: [
            {
              evidence_id: source.id,
              pointer: '/data/fire_noc_available',
              value_json: 'true',
              record_id: '101',
            },
          ],
        },
      ],
    };
  });
  assert.equal(result.reply, patched);
  assert.equal(result.unavailable, false);
  assert.equal(requests.filter((r) => r.stage === 'verifier').length, 2);
  assert.equal(requests.filter((r) => r.stage === 'formatter').length, 0);
});

test('a cited but incorrect replacement is withheld when the second verifier rejects it', async () => {
  const { result, requests } = await run('ID 101: Fire NOC is unavailable.', (request, pass) => {
    const payload = JSON.parse(request.messages[0]!.content);
    if (pass === 2)
      return {
        supported: false,
        feedback: 'The replacement is still incorrect.',
        repair: 'format',
        reason: 'unsupported_claim',
      };
    return {
      supported: false,
      feedback: '',
      repair: 'format',
      reason: 'unsupported_claim',
      remainder_supported: true,
      findings: [
        {
          severity: 'blocking',
          kind: 'factual',
          message: 'Source-bound edits still need a semantic review.',
          quote: 'ID 101: Fire NOC is unavailable.',
          replacement: 'ID 101: Fire NOC is live verified.',
          references: [
            {
              evidence_id: payload.evidence[0].id,
              pointer: '/data/fire_noc_available',
              value_json: 'true',
              record_id: '101',
            },
          ],
        },
      ],
    };
  });
  assert.equal(result.unavailable, true);
  assert.doesNotMatch(result.reply, /live verified/);
  assert.equal(requests.filter((r) => r.stage === 'verifier').length, 2);
});

test('optional gate-width detail does not suppress an otherwise supported provisional answer', async () => {
  const draft =
    'ID 101 is a provisional option. Confirm access and fire documents before visiting.';
  const { result, requests } = await run(draft, () => ({
    supported: false,
    feedback: 'Mention gate width.',
    repair: 'format',
    reason: 'incomplete_answer',
    remainder_supported: true,
    findings: [
      {
        severity: 'suggestion',
        kind: 'scope',
        message: 'Could add gate width to owner questions.',
        quote: '',
        replacement: null,
        references: [],
      },
    ],
  }));
  assert.equal(result.unavailable, false);
  assert.equal(result.reply, draft);
  assert.equal(requests.filter((r) => r.stage === 'verifier').length, 1);
});

const closestClaim = 'Here are the three closest candidates in the Bengaluru records reviewed:';
const provisionalClaim =
  'Here are three provisional candidates from the Bengaluru records reviewed:';
const shortlist = `${closestClaim}\nID 104: 18,000 or 28,000 sq ft.\nID 101: 26,000 sq ft.\nID 103: 28,000 sq ft.\nVerify availability and documents.`;
const revisedShortlist = shortlist.replace(closestClaim, provisionalClaim);

function unpatchableAggregateReview(request: ModelRequest) {
  const payload = JSON.parse(request.messages[0]!.content);
  const source = payload.evidence.find((e: any) => e.tool === 'search_warehouses');
  assert.equal(source.result.data.items[1].id, 102);
  assert.deepEqual(source.result.data.items[1].total_space_sqft, [27000]);
  assert.deepEqual(source.result.data.items[3].total_space_sqft, [18000, 28000]);
  return {
    supported: false,
    feedback: 'Use provisional wording; the listed areas do not establish this ranking.',
    repair: 'format',
    reason: 'unsupported_claim',
    remainder_supported: true,
    findings: [
      {
        severity: 'blocking',
        kind: 'factual',
        message: 'The inventory includes a closer recorded area.',
        quote: closestClaim,
        replacement: provisionalClaim,
        references: [
          {
            evidence_id: source.id,
            pointer: '/data/items/1/total_space_sqft',
            value_json: '[27000]',
            record_id: '102',
          },
        ],
      },
    ],
  };
}

test('an unpatchable aggregate correction preserves the independently repaired worker answer', async () => {
  const { result, requests, revisions } = await run(
    shortlist,
    (request, pass) => {
      if (pass === 1) return unpatchableAggregateReview(request);
      assert.equal(JSON.parse(request.messages[0]!.content).answer, revisedShortlist);
      return { supported: true, feedback: '', repair: 'none' };
    },
    {
      search: true,
      revisedDraft: revisedShortlist,
      // The saved failure added dates, causing the guard to restore the obsolete claim.
      formatter: () => `${revisedShortlist}\nCreated: 29 Sept 2026`,
    },
  );
  assert.equal(result.reply, revisedShortlist);
  assert.equal(result.unavailable, false);
  assert.equal(result.draftReady, false);
  assert.equal(revisions.length, 1);
  assert.match(revisions[0]!, /could not be bound/);
  assert.equal(requests.filter((r) => r.stage === 'formatter').length, 0);
  assert.equal(requests.filter((r) => r.stage === 'verifier').length, 2);
});

test('an independently revised factual answer still needs the second verifier approval', async () => {
  const unsupported = `${revisedShortlist}\nID 104 is fully compliant.`;
  const { result, requests } = await run(
    shortlist,
    (request, pass) => {
      if (pass === 1) return unpatchableAggregateReview(request);
      assert.equal(JSON.parse(request.messages[0]!.content).answer, unsupported);
      return {
        supported: false,
        feedback: 'Recorded specifications do not establish full compliance.',
        repair: 'tools',
        reason: 'unsupported_claim',
      };
    },
    { search: true, revisedDraft: unsupported },
  );
  assert.equal(result.unavailable, true);
  assert.doesNotMatch(result.reply, /fully compliant/);
  assert.equal(requests.filter((r) => r.stage === 'formatter').length, 0);
  assert.equal(requests.filter((r) => r.stage === 'verifier').length, 2);
});

test('formatter-only repair cannot treat an already consumed worker draft as fresh', async () => {
  const draft = 'ID 101 has 26,000 sq ft. Best choice.';
  const revised = 'ID 101 has 26,000 sq ft. A provisional option.';
  const { result, requests, revisions } = await run(
    draft,
    (request, pass) => {
      if (pass === 1)
        return {
          supported: false,
          feedback: 'Qualify the unsupported recommendation.',
          repair: 'format',
          reason: 'unsupported_claim',
        };
      assert.equal(JSON.parse(request.messages[0]!.content).answer, revised);
      return { supported: true, feedback: '', repair: 'none' };
    },
    { formatter: () => revised },
  );
  assert.equal(result.reply, revised);
  assert.equal(result.unavailable, false);
  assert.equal(result.draftReady, false);
  assert.equal(revisions.length, 0);
  assert.equal(requests.filter((r) => r.stage === 'formatter').length, 1);
});

test('a research-limited revision synthesizes evidence without reviving the previous worker draft', async (t) => {
  let now = Date.now();
  const deadline = now + 60000;
  t.mock.method(Date, 'now', () => now);
  const { result, requests, revisions, workerCalls } = await run(
    shortlist,
    (request, pass) => {
      if (pass === 1) return unpatchableAggregateReview(request);
      const payload = JSON.parse(request.messages[0]!.content);
      assert.equal(payload.answer, revisedShortlist);
      assert.equal(payload.research_limited, true);
      return { supported: true, feedback: '', repair: 'none' };
    },
    {
      search: true,
      researchDeadlineMs: deadline,
      onRevise: () => {
        now = deadline;
      },
      formatter: (request) => {
        assert.equal(JSON.parse(request.messages[0]!.content).research_limited, true);
        return revisedShortlist;
      },
    },
  );
  assert.equal(result.reply, revisedShortlist);
  assert.equal(result.unavailable, false);
  assert.equal(result.draftReady, false);
  assert.equal(revisions.length, 1);
  assert.equal(workerCalls, 2);
  assert.equal(requests.filter((r) => r.stage === 'formatter').length, 1);
  assert.equal(requests.filter((r) => r.stage === 'verifier').length, 2);
});
