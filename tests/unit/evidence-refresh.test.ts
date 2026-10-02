/** Fake-clock source refresh and provenance checks. No paid models, network or WhatsApp. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSalesFixture,
  FIXTURE_JID,
  FIXTURE_LEAD_ID,
} from '../../scripts/lib/sales-fixture.js';
import { ContextEngineError } from '../../src/modules/context-engine/context.types.js';
import { dealDisplayIssues } from '../../src/modules/assistant/deal-display.js';
import { toolEvidenceFingerprint } from '../../src/modules/assistant/tool-evidence.js';
import { businessRecall, RECALL_TOOL } from '../../src/modules/assistant/business-recall.js';
import { PRIVATE_HISTORY_REPLY } from '../../src/modules/assistant/conversation-memory.js';
import { buildSalesGraph } from '../../src/modules/assistant/sales.graph.js';
import type { TextModel, ChatMessage } from '../../src/modules/assistant/assistant.types.js';
import { planningResult } from '../fixtures/planning-model.js';

const trusted = { key: { remoteJid: FIXTURE_JID }, runId: 'refresh-fixture' };
const signal = () => new AbortController().signal;
const query = { view: 'accessible', limit: 1 };
async function setup() {
  let now = Date.parse('2026-10-02T06:00:00Z');
  const fixture = createSalesFixture(() => now);
  const run = (await fixture.service.openTools(trusted, signal())).run!;
  const first = await run.execute('search_crm_leads', JSON.stringify(query), signal());
  assert.equal(first.ok, true);
  return {
    fixture,
    run,
    first,
    advance(ms = 120001) {
      now += ms;
    },
    now: () => now,
  };
}

test('expired cached recall refreshes and replaces only the accepted snapshot and delivery fingerprint', async () => {
  const { fixture, run, first, advance } = await setup();
  const before = run.remaining;
  advance();
  fixture.state.mutate = (result, tool) => {
    if (tool === 'search_crm_leads')
      (result.data.items as Array<Record<string, unknown>>)[0]!.name = 'Refreshed fixture';
  };
  const refreshed = await run.executeCached('search_crm_leads', query, signal());
  assert.ok(refreshed);
  assert.notEqual(refreshed.id, first.evidence_id);
  assert.equal(run.remaining, before - 1);
  assert.equal(fixture.state.calls.length, 2);
  assert.equal(run.evidence.length, 1);
  assert.equal(run.evidence[0]?.id, refreshed.id);
  assert.deepEqual(run.retiredEvidenceIds, [first.evidence_id]);
  assert.equal(run.delivery()?.checks.length, 1);
  assert.equal(run.delivery()?.checks[0]?.fingerprint, toolEvidenceFingerprint(refreshed.result));
  assert.equal(await fixture.service.canDeliver(trusted.key, run.delivery(), signal()), true);
});

test('direct repeated execution also refreshes expired evidence without duplicating pagination pages', async () => {
  const { run, first, advance } = await setup();
  await run.execute(
    'search_crm_leads',
    JSON.stringify({ ...query, cursor: 'fixture:1' }),
    signal(),
  );
  assert.equal(run.pagination[0]?.pages, 2);
  advance();
  const refreshed = await run.execute('search_crm_leads', JSON.stringify(query), signal());
  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.reused_in_run, undefined);
  assert.equal(refreshed.replaces_evidence_id, first.evidence_id);
  assert.equal(run.evidence.length, 2);
  assert.equal(run.evidence[0]?.id, refreshed.evidence_id);
  assert.equal(run.pagination[0]?.pages, 2);
  assert.notEqual(run.pagination[0]?.status, 'unlinked');
});

test('failed refresh drops expired grounding and receipts instead of leaking the old cached result', async () => {
  const { fixture, run, first, advance } = await setup();
  advance();
  fixture.state.failures.set('search_crm_leads', new ContextEngineError('UNAVAILABLE'));
  const fresh = await run.executeCached('search_crm_leads', query, signal());
  assert.equal(fresh, undefined);
  assert.equal(run.evidence.length, 0);
  assert.equal(run.delivery(), undefined);
  assert.deepEqual(run.retiredEvidenceIds, [first.evidence_id]);
  assert.equal(run.failures.at(-1)?.code, 'UNAVAILABLE');
  assert.ok(
    dealDisplayIssues(`Lead ID: ${FIXTURE_LEAD_ID}`, run.evidence, run.internalCrmIds).length,
  );
});

test('replacing snapshots cannot reclaim the cumulative source-byte budget', async () => {
  const { fixture, run, advance } = await setup();
  fixture.state.mutate = (result) => {
    result.data.fixturePadding = 'x'.repeat(65000);
  };
  let failure: Record<string, unknown> | undefined;
  for (let i = 0; i < 5; i++) {
    advance();
    const result = await run.execute('search_crm_leads', JSON.stringify(query), signal());
    if (!result.ok) {
      failure = result;
      break;
    }
  }
  assert.equal(failure?.code, 'RESPONSE_TOO_LARGE');
  assert.equal(run.evidence.length, 0);
  assert.ok(run.remaining > 0);
});

test('transient failure on refresh retains the existing one-retry policy', async () => {
  const { fixture, run, advance } = await setup();
  advance();
  fixture.state.failures.set('search_crm_leads', new ContextEngineError('UNAVAILABLE', true));
  assert.equal(await run.executeCached('search_crm_leads', query, signal()), undefined);
  fixture.state.failures.clear();
  assert.ok(await run.executeCached('search_crm_leads', query, signal()));
  assert.equal(fixture.state.calls.length, 3);
});

test('expired cache does not bypass a depleted call budget', async () => {
  const { fixture, run, first, advance } = await setup();
  while (run.remaining) await run.execute('not-a-tool', '{}', signal());
  advance();
  assert.equal(await run.executeCached('search_crm_leads', query, signal()), undefined);
  assert.equal(fixture.state.calls.length, 1);
  assert.equal(run.evidence.length, 0);
  assert.deepEqual(run.retiredEvidenceIds, [first.evidence_id]);
});

test('refresh cancellation after the source call neither publishes replacement nor resurrects old evidence', async () => {
  const { fixture, run, first, advance } = await setup();
  const controller = new AbortController();
  advance();
  fixture.state.mutate = () => controller.abort();
  await assert.rejects(run.executeCached('search_crm_leads', query, controller.signal));
  assert.equal(run.evidence.length, 0);
  assert.deepEqual(run.retiredEvidenceIds, [first.evidence_id]);
  assert.equal(run.delivery(), undefined);
});

test('current identity remains required before an expired cache can refresh', async () => {
  const { fixture, run, advance } = await setup();
  advance();
  fixture.state.active = false;
  assert.equal(await run.executeCached('search_crm_leads', query, signal()), undefined);
  assert.equal(fixture.state.calls.length, 1);
  assert.equal(run.blocked, true);
  assert.throws(() => run.delivery(), /ACCESS_DENIED/);
});

test('recall handles an expired in-run snapshot as a fresh source read instead of aborting the task', async () => {
  const { fixture, run, advance, now } = await setup();
  const history: ChatMessage[] = [
    {
      role: 'assistant',
      content: PRIVATE_HISTORY_REPLY,
      protectedReply: { text: 'Fixture private answer.', receipt: run.delivery() },
    },
  ];
  advance();
  const result = await businessRecall(history, run, now()).execute('{}', signal());
  assert.equal(result.ok, true);
  assert.equal(result.previous_reply_verified, true);
  assert.equal(fixture.state.calls.length, 2);
  assert.equal(run.evidence.length, 1);
});

test('legitimate non-CRM UUID references pass, but accepted lead IDs stay hidden', async () => {
  const documentId = 'fbe7baea-8318-49de-a5e4-40d8a33f7412';
  assert.deepEqual(dealDisplayIssues(`The document reference is ${documentId}.`, []), []);
  const { run } = await setup();
  assert.deepEqual(dealDisplayIssues(`The document reference is ${documentId}.`, run.evidence), []);
  assert.ok(
    dealDisplayIssues(`Lead ID: ${FIXTURE_LEAD_ID.toUpperCase()}`, run.evidence).some((issue) =>
      issue.includes('internal deal'),
    ),
  );
  const context = await run.execute(
    'read_crm_lead_context',
    JSON.stringify({ id: FIXTURE_LEAD_ID, section: 'notes' }),
    signal(),
  );
  assert.equal(context.ok, true);
  assert.ok(
    dealDisplayIssues(
      `Lead ID: ${FIXTURE_LEAD_ID}`,
      run.evidence.filter((e) => e.tool === 'read_crm_lead_context'),
    ).length,
  );
});

test('general graph can present a supplied non-CRM UUID without a deterministic repair loop', async () => {
  const id = 'fbe7baea-8318-49de-a5e4-40d8a33f7412';
  const fixture = createSalesFixture();
  let reviews = 0;
  const model: TextModel = {
    startToolSession() {
      assert.fail('Direct request needs no worker');
    },
    async complete(request) {
      if (request.stage === 'verifier') reviews++;
      return {
        text:
          request.stage === 'converser'
            ? JSON.stringify({
                route: 'direct',
                objective: 'Draft supplied document reference',
                reply: `Document: ${id}`,
              })
            : request.stage === 'verifier'
              ? JSON.stringify({ supported: true, repair: 'none', feedback: '' })
              : `Document: ${id}`,
        inputTokens: 1,
        outputTokens: 1,
      };
    },
  };
  const graph = buildSalesGraph(model, (s) => fixture.service.openTools(trusted, s));
  const result = await graph.invoke(
    { input: `Quote this document reference: ${id}`, history: [], audience: 'dm' },
    { recursionLimit: 20 },
  );
  assert.equal(result.reply, `Document: ${id}`);
  assert.equal(reviews, 1);
});

test('retiring one source invalidates a whole multi-source recall, while unrelated supported recall survives', async () => {
  const { fixture, run, advance, now } = await setup();
  await run.execute('read_warehouse', JSON.stringify({ id: 101 }), signal());
  const receipt = run.delivery()!;
  assert.equal(receipt.checks.length, 2);
  const history: ChatMessage[] = [
    {
      role: 'assistant',
      content: PRIVATE_HISTORY_REPLY,
      protectedReply: { text: 'PRIVATE_OLD_RECALL_PROSE', receipt },
    },
    {
      role: 'assistant',
      content: PRIVATE_HISTORY_REPLY,
      protectedReply: {
        text: 'CURRENT_UNRELATED_PROSE',
        receipt: {
          ...receipt,
          checks: receipt.checks.filter((check) => check.tool === 'read_warehouse'),
        },
      },
    },
  ];
  const calls = [
    { name: RECALL_TOOL, args: { turn: 1 } },
    { name: RECALL_TOOL, args: { turn: 2 } },
    { name: 'search_crm_leads', args: query },
  ];
  let next = 0;
  const model: TextModel = {
    startToolSession() {
      return {
        async next() {
          if (next === 2) advance();
          const call = calls[next++];
          return {
            text: call ? '' : 'Current fixture result.',
            calls: call
              ? [{ id: String(next), name: call.name, arguments: JSON.stringify(call.args) }]
              : [],
            inputTokens: 1,
            outputTokens: 1,
          };
        },
        accept() {},
      };
    },
    async complete(request) {
      const plan = planningResult(request);
      if (plan) return plan;
      const data = JSON.parse(request.messages[0]!.content);
      assert.equal(data.recalled.length, 1);
      assert.equal(data.recalled[0].previous_reply, 'CURRENT_UNRELATED_PROSE');
      assert.equal(data.recalled[0].source_record_checks.length, 1);
      assert.equal(data.retired_evidence_ids.length, 1);
      assert.equal(data.evidence.length, 2);
      assert.ok(!JSON.stringify(data).includes('PRIVATE_OLD_RECALL_PROSE'));
      return {
        text:
          request.stage === 'verifier'
            ? JSON.stringify({ supported: true, repair: 'none', feedback: '' })
            : 'Current fixture result.',
        inputTokens: 1,
        outputTokens: 1,
      };
    },
  };
  const graph = buildSalesGraph(model, async () => ({ status: 'available', run }), { now });
  const result = await graph.invoke(
    { input: 'Refresh that earlier result.', history, audience: 'dm' },
    { recursionLimit: 30 },
  );
  assert.equal(result.reply, 'Current fixture result.');
  assert.equal(fixture.state.calls.length, 3);
});
