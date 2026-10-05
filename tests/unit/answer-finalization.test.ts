/** End-to-end graph regressions from genericized failed conversations. No model/network calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSalesGraph } from '../../src/modules/assistant/sales.graph.js';
import type { ModelRequest, TextModel } from '../../src/modules/assistant/assistant.types.js';
import { createSalesFixture, FIXTURE_JID } from '../../scripts/lib/sales-fixture.js';
import { planningResult } from '../fixtures/planning-model.js';

const output = (text: string) => ({ text, inputTokens: 1, outputTokens: 1 });
async function run(draft: string, review: (request: ModelRequest, pass: number) => unknown) {
  const fixture = createSalesFixture();
  fixture.state.mutate = (source, tool) => {
    if (tool === 'read_warehouse') {
      source.data.fire_noc_available = true;
      source.data.total_space_sqft = [26000];
    }
  };
  const requests: ModelRequest[] = [];
  let count = 0;
  let accepted: any;
  const model: TextModel = {
    startToolSession() {
      let read = false;
      return {
        async next() {
          if (!read) {
            read = true;
            return {
              ...output(''),
              calls: [{ id: 'read-1', name: 'read_warehouse', arguments: '{"id":101}' }],
            };
          }
          return { ...output(draft), calls: [] };
        },
        accept(_id, value) {
          accepted = value;
        },
      };
    },
    async complete(request) {
      requests.push(request);
      const plan = planningResult(request);
      if (plan) return plan;
      if (request.stage === 'verifier') return output(JSON.stringify(review(request, ++count)));
      // A formatter rewrite would reproduce the original failure: reverse ranking/change units.
      throw new Error('A completed worker answer must not be freely rewritten');
    },
  };
  const graph = buildSalesGraph(model, (signal) =>
    fixture.service.openTools(
      {
        runId: 'finalization-test',
        key: { remoteJid: FIXTURE_JID },
      },
      signal,
    ),
  );
  const result = await graph.invoke({
    input: 'Compare the selected warehouses and recommend a visit.',
    history: [],
    audience: 'dm',
  });
  return { result, requests, accepted };
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
