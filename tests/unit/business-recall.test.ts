import { planningResult } from '../fixtures/planning-model.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSalesFixture, FIXTURE_JID } from '../../scripts/lib/sales-fixture.js';
import { businessRecall, RECALL_TOOL } from '../../src/modules/assistant/business-recall.js';
import { PRIVATE_HISTORY_REPLY } from '../../src/modules/assistant/conversation-memory.js';
import { dealDisplayFacts, dealDisplayIssues } from '../../src/modules/assistant/deal-display.js';
import { AssistantService } from '../../src/modules/assistant/assistant.service.js';
import { ContextEngineError } from '../../src/modules/context-engine/context.types.js';
import type {
  ChatMessage,
  TextModel,
  ToolSessionRequest,
} from '../../src/modules/assistant/assistant.types.js';
import { displayedWarehouseRecords } from '../../src/modules/assistant/displayed-records.js';
import { contextFixture } from '../fixtures/chat-context.js';
const trusted = { key: { remoteJid: FIXTURE_JID }, runId: 'test' };
const signal = () => AbortSignal.timeout(5000);

test('compacted user requirements survive the complete planning, worker, formatter and review handoff', async () => {
  const fixture = createSalesFixture();
  const memory: ChatMessage = {
    role: 'user',
    content:
      '[Conversation memory source data]\n' +
      JSON.stringify({
        pinned_context: [],
        summary: {
          notes: [
            {
              kind: 'correction',
              text: 'The user corrected their required minimum to 50000 sq ft.',
              sources: ['earlier-user-turn'],
            },
          ],
        },
      }),
  };
  const history: ChatMessage[] = [
    memory,
    ...Array.from({ length: 20 }, (_, i) => ({
      role: 'user' as const,
      content: `Unrelated chat ${i}`,
    })),
  ];
  const stages = new Set<string>();
  const model: TextModel = {
    startToolSession(request) {
      stages.add('worker');
      assert.ok(request.messages.some((message) => message.content === memory.content));
      assert.match(request.instructions, /do not demand a CRM field/);
      return {
        async next() {
          return {
            text: 'You corrected your minimum to 50000 sq ft.',
            calls: [],
            inputTokens: 1,
            outputTokens: 1,
          };
        },
        accept() {},
      };
    },
    async complete(request) {
      stages.add(request.stage);
      assert.match(request.instructions, /what the user requested or preferred/);
      assert.ok(request.messages.some((message) => message.content.includes('50000')));
      if (request.stage === 'formatter' || request.stage === 'verifier') {
        const payload = JSON.parse(request.messages[0]!.content);
        assert.equal(payload.history.length, 9);
        assert.equal(payload.history[0].content, memory.content);
      }
      return (
        planningResult(request) ?? {
          text:
            request.stage === 'verifier'
              ? '{"supported":true,"feedback":""}'
              : 'You corrected your minimum to 50000 sq ft.',
          inputTokens: 1,
          outputTokens: 1,
        }
      );
    },
  };
  const assistant = new AssistantService(
    { model: 'fixture', timeoutMs: 5000 },
    model,
    undefined,
    undefined,
    async () => history,
    fixture.service,
  );
  const result = await assistant.prepare(
    {
      chatId: FIXTURE_JID,
      messageId: 'context',
      sentAtMs: Date.now(),
      text: 'What minimum did I correct my requirement to?',
      isGroup: false,
      fromMe: false,
      mentionsBot: false,
    },
    signal(),
    trusted,
  );
  assert.equal(result.trace.outcome, 'completed');
  assert.match(result.text, /50000/);
  assert.deepEqual([...stages].sort(), ['converser', 'formatter', 'planner', 'verifier', 'worker']);
  assert.equal(
    fixture.state.calls.length,
    0,
    'a user requirement is not a current business fact needing a business read',
  );
});

test('remembered selections survive prose expiry but always require fresh permissions and reads', async () => {
  const { fixture, run } = await warehouseHistory();
  const now = Date.now();
  const history: ChatMessage[] = [
    {
      role: 'assistant',
      content: PRIVATE_HISTORY_REPLY,
      businessReferences: {
        employeeId: run.employeeId,
        expiresAt: now + 86400000,
        records: [{ kind: 'warehouse', id: 105, position: 2 }],
      },
    },
  ];
  const recall = businessRecall(history, run, now);
  assert.ok(recall.available);
  assert.ok(!JSON.stringify(recall.messages).includes('105'));
  const result = await recall.execute('{}', signal());
  assert.equal(result.selection_source, 'remembered_selection');
  assert.equal(result.previous_reply, undefined);
  assert.equal((result.displayed_selection as any[])[0].position, 2);
  assert.equal(fixture.state.calls.at(-1)?.tool, 'read_warehouse');
  assert.equal(businessRecall(history, undefined, now).available, false);
  assert.equal(businessRecall(history, run, now + 2 * 86400000).available, false);
  history[0]!.businessReferences!.employeeId++;
  assert.equal(businessRecall(history, run, now).available, false);
});

async function setup() {
  const fixture = createSalesFixture();
  const original = (await fixture.service.openTools(trusted, signal())).run!;
  await original.execute('search_crm_leads', '{"view":"accessible","limit":10}', signal());
  const history: ChatMessage[] = [
    { role: 'user', content: 'Show our current deals.' },
    {
      role: 'assistant',
      content: PRIVATE_HISTORY_REPLY,
      protectedReply: {
        text: '1. Fixture Acme Storage\n2. Fixture Beacon Retail',
        receipt: original.delivery(),
      },
    },
  ];
  const run = (await fixture.service.openTools(trusted, signal())).run!;
  return { fixture, history, run, original };
}

async function warehouseHistory(legacy = false) {
  const fixture = createSalesFixture();
  const original = (await fixture.service.openTools(trusted, signal())).run!;
  await original.execute('search_warehouses', '{"limit":5}', signal());
  await original.execute('get_context', '{}', signal());
  const text = '1. *ID 105* · OLD PRIVATE PRO\n2. ID:103 · OLD PRIVATE CON\n3. ID 101 · old size';
  const receipt = original.delivery()!;
  if (!legacy) receipt.displayedRecords = displayedWarehouseRecords(text, original.evidence);
  const history: ChatMessage[] = [
    { role: 'user', content: 'Give three suitable warehouses' },
    { role: 'assistant', content: PRIVATE_HISTORY_REPLY, protectedReply: { text, receipt } },
  ];
  fixture.state.calls.length = 0;
  const run = (await fixture.service.openTools(trusted, signal())).run!;
  return { fixture, history, run };
}

test('compaction and restart retain grouped selections for scoped, freshly authorized recall', async () => {
  const { fixture, history, run } = await warehouseHistory();
  const memory = contextFixture();
  memory.reassign(run.employeeId);
  await memory.context.prepare(...memory.turn(1, '/pins'));
  const receipt = history[1]!.protectedReply!.receipt as any;
  receipt.displayedRecords = [
    {
      kind: 'warehouse',
      id: 105,
      position: 1,
      group: 'group-1',
      subject: { kind: 'crm_lead', id: '00000000-0000-4000-8000-000000000101' },
    },
    {
      kind: 'warehouse',
      id: 103,
      position: 1,
      group: 'group-2',
      subject: { kind: 'crm_lead', id: '00000000-0000-4000-8000-000000000102' },
    },
    {
      kind: 'warehouse',
      id: 101,
      position: 2,
      group: 'group-2',
      subject: { kind: 'crm_lead', id: '00000000-0000-4000-8000-000000000102' },
    },
  ];
  memory.add(2, history[1]!);
  for (let i = 3; i <= 40; i++) memory.add(i, { role: 'user', content: `Unrelated chat ${i}` });
  await memory.context.prepare(...memory.turn(41, 'Continue'));
  assert.equal(memory.requests.length, 1, 'the old selection must pass through compaction');
  memory.advance(2);
  const restarted = await memory.create().prepare(...memory.turn(42, 'Compare the second option'));
  assert.ok(restarted);
  assert.ok(restarted.history.every((entry) => !entry.protectedReply));
  const references = restarted.history.find(
    (entry) => entry.businessReferences,
  )?.businessReferences;
  assert.deepEqual(references?.records, receipt.displayedRecords);
  const recall = businessRecall(restarted.history, run, memory.now());
  assert.doesNotMatch(JSON.stringify(recall.messages), /00000000-0000-4000|OLD PRIVATE/);
  assert.equal((await recall.execute('{"positions":[2]}', signal())).code, 'AMBIGUOUS_SELECTION');
  assert.equal(fixture.state.calls.length, 0);
  const output = await recall.execute('{"group":"group-2","positions":[2]}', signal());
  assert.equal(output.selection_source, 'remembered_selection');
  assert.equal(output.selection_status, 'complete');
  assert.equal(output.previous_reply, undefined);
  assert.deepEqual(
    fixture.state.calls.map(({ tool, args }) => [tool, args.id]),
    [
      ['read_crm_lead', '00000000-0000-4000-8000-000000000102'],
      ['read_warehouse', 101],
    ],
  );
  const selected = (output.displayed_selection as any[])[0];
  assert.deepEqual(
    [selected.id, selected.position, selected.group, selected.subject.id],
    [101, 2, 'group-2', '00000000-0000-4000-8000-000000000102'],
  );
});

test('ranked displayed IDs refresh directly despite changed search ordering and unrelated source failure', async () => {
  const { fixture, history, run } = await warehouseHistory();
  fixture.state.failures.set('search_warehouses', new ContextEngineError('UNAVAILABLE'));
  fixture.state.failures.set('get_context', new ContextEngineError('UNAVAILABLE'));
  fixture.state.mutate = (result, tool, args) => {
    if (tool === 'read_warehouse') result.data.area_sqft = 50000 + Number(args.id);
  };
  const output = await businessRecall(history, run).execute('{}', signal());
  assert.equal(output.selection_status, 'complete');
  assert.equal(output.previous_reply_verified, false);
  assert.equal(output.previous_reply, undefined);
  assert.ok(!JSON.stringify(output).includes('OLD PRIVATE'));
  assert.deepEqual(
    (output.displayed_selection as any[]).map(({ id, position }) => ({ id, position })),
    [
      { id: 105, position: 1 },
      { id: 103, position: 2 },
      { id: 101, position: 3 },
    ],
  );
  assert.deepEqual(
    fixture.state.calls.map(({ tool, args }) => [tool, args.id]),
    [
      ['read_warehouse', 105],
      ['read_warehouse', 103],
      ['read_warehouse', 101],
    ],
  );
  assert.deepEqual(
    (output.fresh_evidence as any[]).map((entry) => entry.data.area_sqft),
    [50105, 50103, 50101],
  );
});

test('legacy explicit display labels avoid old pool replay and restore authorized IDs without old prose', async () => {
  const { fixture, history, run } = await warehouseHistory(true);
  fixture.state.failures.set('search_warehouses', new ContextEngineError('UNAVAILABLE'));
  fixture.state.mutate = (result, tool) => {
    if (tool === 'read_warehouse') result.data.source_updated_at = '2026-10-03T00:00:00Z';
  };
  const output = await businessRecall(history, run).execute('{}', signal());
  assert.equal(output.selection_source, 'legacy_explicit_labels');
  assert.equal(output.selection_status, 'complete');
  assert.equal(output.selection_count, 3);
  assert.deepEqual(
    (output.displayed_selection as any[]).map((entry) => entry.id),
    [105, 103, 101],
  );
  assert.equal(fixture.state.calls.length, 3);
  assert.ok(!JSON.stringify(output).includes('OLD PRIVATE'));
});

test('unavailable displayed warehouse is hidden without replacing or renumbering the survivors', async () => {
  const { fixture, history, run } = await warehouseHistory();
  fixture.state.mutate = (_result, tool, args) => {
    if (tool === 'read_warehouse' && args.id === 103)
      throw new ContextEngineError('TOOL_UNAVAILABLE');
  };
  const output = await businessRecall(history, run).execute('{}', signal());
  assert.equal(output.selection_status, 'partial');
  assert.equal(output.retry_available, true);
  assert.deepEqual(
    (output.displayed_selection as any[]).map(({ id, position }) => ({ id, position })),
    [
      { id: 105, position: 1 },
      { id: 101, position: 3 },
    ],
  );
  assert.ok(!JSON.stringify(output).includes('"id":103'));
  assert.deepEqual(output.unavailable_checks, [
    { tool: 'read_warehouse', code: 'TOOL_UNAVAILABLE' },
  ]);
  assert.equal(output.previous_reply, undefined);
});

test('stored display positions survive omitted references rather than collapsing ordinals', async () => {
  const { history, run } = await warehouseHistory();
  const receipt = history[1]!.protectedReply!.receipt as any;
  receipt.displayedRecords = [
    { kind: 'warehouse', id: 103, position: 2 },
    { kind: 'warehouse', id: 101, position: 4 },
  ];
  const output = await businessRecall(history, run).execute('{}', signal());
  assert.equal(output.selection_count, 4);
  assert.equal(output.selection_status, 'partial');
  assert.deepEqual(
    (output.displayed_selection as any[]).map(({ id, position }) => ({ id, position })),
    [
      { id: 103, position: 2 },
      { id: 101, position: 4 },
    ],
  );
});

test('partial exact selection permits one bounded retry and reuses successful fresh reads', async () => {
  const { fixture, history, run } = await warehouseHistory();
  fixture.state.allowEvidenceReuse = true;
  let failed = false;
  fixture.state.mutate = (_result, tool, args) => {
    if (tool === 'read_warehouse' && args.id === 103 && !failed) {
      failed = true;
      throw new ContextEngineError('UNAVAILABLE', true);
    }
  };
  const recall = businessRecall(history, run);
  const first = await recall.execute('{}', signal());
  assert.equal(first.selection_status, 'partial');
  assert.equal(first.retry_available, true);
  const second = await recall.execute('{}', signal());
  assert.equal(second.selection_status, 'complete');
  assert.equal(second.retry_available, false);
  assert.deepEqual(
    (second.displayed_selection as any[]).map((entry) => entry.id),
    [105, 103, 101],
  );
  assert.deepEqual(
    fixture.state.calls.map(({ args }) => args.id),
    [105, 103, 101, 103],
  );
  assert.equal((await recall.execute('{}', signal())).code, 'ALREADY_RECALLED');
});

test('revoked identity cannot reveal displayed ID metadata or successful earlier reads', async () => {
  const { fixture, history, run } = await warehouseHistory();
  fixture.state.mutate = () => {
    fixture.state.active = false;
  };
  const output = await businessRecall(history, run).execute('{}', signal());
  assert.deepEqual(output, { ok: false, code: 'ACCESS_DENIED' });
});

test('recall restores selection/order only after fresh registered reads; metadata never enters messages', async () => {
  const { fixture, history, run } = await setup();
  const recall = businessRecall(history, run);
  assert.equal(recall.available, true);
  assert.ok(!JSON.stringify(recall.messages).includes('Fixture Acme'));
  assert.ok(!JSON.stringify(recall.messages).includes('protectedReply'));
  assert.match(recall.messages[1]!.content, /business turn 1/);
  const output = await recall.execute('{}', signal());
  assert.equal(output.previous_reply_verified, true);
  assert.equal(output.refresh_status, 'unchanged');
  assert.equal(output.refreshed_checks, 1);
  assert.deepEqual(output.unavailable_checks, []);
  assert.equal(output.previous_reply, history[1]!.protectedReply!.text);
  assert.equal(fixture.state.calls.length, 2);
  assert.equal(run.evidence.length, 1);
  assert.equal(await fixture.service.canDeliver(trusted.key, run.delivery(), signal()), true);
});

test('changed results and revoked access cannot reveal the old answer', async () => {
  const { fixture, history, run } = await setup();
  fixture.state.mutate = (result, tool) => {
    if (tool === 'search_crm_leads') (result.data.items as any[])[0].name = 'New permitted label';
  };
  const output = await businessRecall(history, run).execute('{}', signal());
  assert.equal(output.previous_reply_verified, false);
  assert.equal(output.refresh_status, 'changed');
  assert.deepEqual(output.source_record_checks, [
    { evidence_id: run.evidence[0]!.id, same_records: true, same_order: true },
  ]);
  assert.equal(output.previous_reply, undefined);
  assert.ok(!JSON.stringify(output).includes('Fixture Acme'));
  // Equal record IDs never authorize delivery of an answer whose facts changed.
  assert.equal(
    await fixture.service.canDeliver(trusted.key, history[1]!.protectedReply!.receipt, signal()),
    false,
  );
  fixture.state.active = false;
  const denied = await businessRecall(history, run).execute('{}', signal());
  assert.equal(denied.code, 'ACCESS_DENIED');
  assert.ok(!JSON.stringify(denied).includes('Fixture Acme'));
});

test('legacy receipts refresh without inventing membership or order verification', async () => {
  const { fixture, history, run } = await setup();
  const receipt = history[1]!.protectedReply!.receipt as any;
  for (const check of receipt.checks) delete check.records;
  fixture.state.mutate = (result, tool) => {
    if (tool === 'search_crm_leads')
      (result.data.items as any[])[0].source_updated_at = '2026-10-01T08:30:00Z';
  };
  const output = await businessRecall(history, run).execute('{}', signal());
  assert.equal(output.refresh_status, 'changed');
  assert.equal(output.previous_reply, undefined);
  assert.deepEqual(output.source_record_checks, [
    { evidence_id: run.evidence[0]!.id, same_records: null, same_order: null },
  ]);
});

test('reordered current results do not imply changed membership or permit historical text replay', async () => {
  const { fixture, history, run } = await setup();
  fixture.state.mutate = (result, tool) => {
    if (tool === 'search_crm_leads') (result.data.items as any[]).reverse();
  };
  const output = await businessRecall(history, run).execute('{}', signal());
  assert.equal(output.previous_reply, undefined);
  assert.deepEqual(output.source_record_checks, [
    { evidence_id: run.evidence[0]!.id, same_records: true, same_order: false },
  ]);
});

test('changed recall exposes genuine continuation without leaking stale prose or changing query scope', async () => {
  const { fixture, history, run } = await setup();
  const privateText = 'HISTORICAL_TEXT_ONLY';
  history[1]!.protectedReply!.text = privateText;
  fixture.state.mutate = (result, tool, args) => {
    if (tool === 'search_crm_leads' && args.cursor === undefined) {
      result.data.items = (result.data.items as unknown[]).slice(0, 1);
      result.data.nextCursor = 'fixture:1';
      Object.assign(result.data.query_context as object, { returned_count: 1, has_more: true });
    }
  };
  const output = await businessRecall(history, run).execute('{}', signal());
  assert.equal(output.refresh_status, 'changed');
  assert.equal(output.previous_reply_verified, false);
  assert.ok(!JSON.stringify(output).includes(privateText));
  assert.deepEqual(output.unavailable_checks, []);
  const next = (output.continuations as any[])[0];
  assert.deepEqual(next.arguments, { view: 'accessible', limit: 10, cursor: 'fixture:1' });
  assert.equal(next.coverage.status, 'more_available');
  assert.equal(next.coverage.unique_records, 1);
  const page = await run.execute(next.tool, JSON.stringify(next.arguments), signal());
  assert.equal(page.ok, true);
  assert.equal(run.pagination[0]!.unique_records, 11);
});

test('exhausted changed recall exposes the complete smaller result without a fabricated continuation', async () => {
  const { fixture, history, run } = await setup();
  fixture.state.visibleLeadIds = ['00000000-0000-4000-8000-000000000102'];
  const output = await businessRecall(history, run).execute('{}', signal());
  assert.equal(output.refresh_status, 'changed');
  assert.deepEqual(output.continuations, []);
  assert.equal((output.source_record_checks as any[])[0].same_records, false);
  assert.equal((output.pagination as any[])[0].status, 'exhausted');
  assert.equal((output.pagination as any[])[0].unique_records, 1);
  assert.ok(!JSON.stringify(output).includes('Fixture Acme'));
  assert.ok(JSON.stringify(output.fresh_evidence).includes('Fixture Beacon'));
});

test('partial recall retains successful current evidence and reports failed checks without old query arguments', async () => {
  const { fixture, history, run, original } = await setup();
  await original.execute('warehouse_summary', '{"city":"Bengaluru"}', signal());
  history[1]!.protectedReply!.receipt = original.delivery();
  fixture.state.failures.set('search_crm_leads', new ContextEngineError('TOOL_UNAVAILABLE'));
  const output = await businessRecall(history, run).execute('{}', signal());
  assert.equal(output.refresh_status, 'partial');
  assert.equal(output.refreshed_checks, 1);
  assert.equal(output.requested_checks, 2);
  assert.deepEqual(output.unavailable_checks, [
    { tool: 'search_crm_leads', code: 'TOOL_UNAVAILABLE' },
  ]);
  assert.equal((output.fresh_evidence as any[])[0].data.total, 5);
  assert.equal(output.previous_reply, undefined);
  assert.ok(!JSON.stringify(output).includes('Fixture Acme'));
  assert.ok(!JSON.stringify(output).includes('accessible'));
});

test('cross-employee, expired-window and legacy receipts never become recallable', async () => {
  const { history, run } = await setup();
  assert.equal(businessRecall(history, undefined).available, false);
  const changed = structuredClone(history);
  (changed[1]!.protectedReply!.receipt as any).employeeId++;
  assert.equal(businessRecall(changed, run).available, false);
  assert.equal(businessRecall(history, run, Date.now() + 86401000).available, false);
  changed[1]!.protectedReply!.receipt = { kind: 'legacy' };
  assert.equal(businessRecall(changed, run).available, false);
});

test('recall reuses current evidence and does not let tool arguments choose an identity', async () => {
  const { fixture, history, run } = await setup();
  fixture.state.allowEvidenceReuse = true;
  await run.execute('search_crm_leads', '{"view":"accessible","limit":10}', signal());
  const before = fixture.state.calls.length;
  const recall = businessRecall(history, run);
  assert.equal((await recall.execute('{"employeeId":1}', signal())).code, 'INVALID_ARGUMENTS');
  assert.equal((await recall.execute('{}', signal())).previous_reply_verified, true);
  assert.equal(fixture.state.calls.length, before);
  assert.equal((await recall.execute('{}', signal())).code, 'ALREADY_RECALLED');
});

test('targeted recall refreshes only requested positions and preserves their original ordinals', async () => {
  const { fixture, history, run } = await warehouseHistory();
  const recall = businessRecall(history, run);
  const output = await recall.execute('{"positions":[3,2]}', signal());
  assert.deepEqual(
    fixture.state.calls.map(({ args }) => args.id),
    [103, 101],
  );
  assert.deepEqual(
    (output.displayed_selection as any[]).map(({ id, position }) => [id, position]),
    [
      [103, 2],
      [101, 3],
    ],
  );
  assert.equal(output.selection_count, 2);
  assert.equal(output.selection_status, 'complete');
  assert.equal(output.selection_targeted, true);
  assert.equal(
    (await recall.execute('{"warehouse_ids":[999]}', signal())).code,
    'SELECTION_NOT_FOUND',
  );
  assert.equal(fixture.state.calls.length, 2);
});

test('grouped recall requires an ordinal scope and refreshes its source-backed subject', async () => {
  const { fixture, history, run } = await warehouseHistory();
  const receipt = history[1]!.protectedReply!.receipt as any;
  receipt.displayedRecords = [
    {
      kind: 'warehouse',
      id: 105,
      position: 1,
      group: 'group-1',
      subject: { kind: 'crm_lead', id: '00000000-0000-4000-8000-000000000101' },
    },
    { kind: 'warehouse', id: 103, position: 2, group: 'group-1' },
    {
      kind: 'warehouse',
      id: 103,
      position: 1,
      group: 'group-2',
      subject: { kind: 'crm_lead', id: '00000000-0000-4000-8000-000000000102' },
    },
    {
      kind: 'warehouse',
      id: 101,
      position: 2,
      group: 'group-2',
      subject: { kind: 'crm_lead', id: '00000000-0000-4000-8000-000000000102' },
    },
  ];
  const recall = businessRecall(history, run);
  const ambiguous = await recall.execute('{"positions":[2]}', signal());
  assert.equal(ambiguous.code, 'AMBIGUOUS_SELECTION');
  assert.match(String(ambiguous.guidance), /only turn.*latest turn/);
  assert.match(String(ambiguous.guidance), /Do not ask the user to resupply IDs/);
  assert.equal(fixture.state.calls.length, 0);
  const output = await recall.execute('{"group":"group-2","positions":[2]}', signal());
  assert.deepEqual(
    fixture.state.calls.map(({ tool, args }) => [tool, args.id]),
    [
      ['read_crm_lead', '00000000-0000-4000-8000-000000000102'],
      ['read_warehouse', 101],
    ],
  );
  const reference = (output.displayed_selection as any[])[0];
  assert.deepEqual(
    [reference.id, reference.position, reference.group, reference.subject.id],
    [101, 2, 'group-2', '00000000-0000-4000-8000-000000000102'],
  );
  assert.equal(output.previous_reply, undefined);
  assert.equal(output.selection_status, 'complete');
});

test('failed subject authorization withholds its identity but preserves independently authorized warehouse references', async () => {
  const { fixture, history, run } = await warehouseHistory();
  history[1]!.protectedReply!.text = 'STALE CLIENT NAME\n1. ID 105\nSTALE REQUIREMENT';
  (history[1]!.protectedReply!.receipt as any).displayedRecords = [
    {
      kind: 'warehouse',
      id: 105,
      position: 1,
      group: 'group-1',
      subject: { kind: 'crm_lead', id: '00000000-0000-4000-8000-000000000101' },
    },
  ];
  fixture.state.failures.set('read_crm_lead', new ContextEngineError('TOOL_UNAVAILABLE'));
  const output = await businessRecall(history, run).execute('{"positions":[1]}', signal());
  assert.equal((output.displayed_selection as any[])[0].id, 105);
  assert.equal((output.displayed_selection as any[])[0].group, 'group-1');
  assert.equal((output.displayed_selection as any[])[0].subject, undefined);
  assert.ok(!JSON.stringify(output).includes('00000000-0000-4000-8000-000000000101'));
  assert.doesNotMatch(JSON.stringify(output), /STALE CLIENT NAME|STALE REQUIREMENT/);
  fixture.state.failures.set('read_crm_lead', new ContextEngineError('ACCESS_DENIED'));
  const deniedRun = (await fixture.service.openTools(trusted, signal())).run!;
  assert.deepEqual(
    await businessRecall(history, deniedRun).execute('{"positions":[1]}', signal()),
    {
      ok: false,
      code: 'ACCESS_DENIED',
    },
  );
});

test('shared warehouses refresh once while preserving each displayed group position', async () => {
  const { fixture, history, run } = await warehouseHistory();
  (history[1]!.protectedReply!.receipt as any).displayedRecords = [
    { kind: 'warehouse', id: 105, position: 1, group: 'group-1' },
    { kind: 'warehouse', id: 103, position: 2, group: 'group-1' },
    { kind: 'warehouse', id: 103, position: 1, group: 'group-2' },
    { kind: 'warehouse', id: 101, position: 2, group: 'group-2' },
  ];
  const output = await businessRecall(history, run).execute('{}', signal());
  assert.deepEqual(
    fixture.state.calls.map(({ args }) => args.id),
    [105, 103, 101],
  );
  assert.equal(output.selection_status, 'complete');
  assert.equal(output.selection_count, 4);
  assert.equal(output.requested_checks, 3);
  assert.equal(output.refreshed_checks, 3);
  const displayed = output.displayed_selection as any[];
  assert.deepEqual(
    displayed.map(({ id, position, group }) => [id, position, group]),
    [
      [105, 1, 'group-1'],
      [103, 2, 'group-1'],
      [103, 1, 'group-2'],
      [101, 2, 'group-2'],
    ],
  );
  assert.equal(displayed[1].evidence_id, displayed[2].evidence_id);
});

test('large refreshed selections retain useful values for every record with explicit omissions', async () => {
  const { fixture, history, run } = await warehouseHistory();
  fixture.state.mutate = (result, tool) => {
    if (tool === 'read_warehouse') result.data.large_unused_field = 'x'.repeat(30000);
  };
  const output = await businessRecall(history, run).execute('{}', signal());
  assert.equal(output.selection_status, 'complete');
  assert.ok(Buffer.byteLength(JSON.stringify(output)) < 80000);
  const fresh = output.fresh_evidence as any[];
  assert.deepEqual(
    fresh.map((entry) => entry.data.id),
    [105, 103, 101],
  );
  assert.ok(
    fresh.every(
      (entry) => entry.data_truncated === true && Array.isArray(entry.data.total_space_sqft),
    ),
  );
  assert.ok(fresh.every((entry) => entry.omitted_paths.includes('data.large_unused_field')));
});

test('native dates use IST, missing dates stay missing and deal UUIDs fail presentation checks', async () => {
  const { original } = await setup();
  const facts = dealDisplayFacts(original.evidence);
  assert.equal(facts[1]?.created, '13 Sept 2026');
  (original.evidence[0]!.result.data.items as any[])[0].source_created_at = null;
  (original.evidence[0]!.result.data.items as any[])[0].last_polled_at = new Date().toISOString();
  assert.equal(dealDisplayFacts(original.evidence)[0]?.created, 'Not recorded');
  assert.ok(dealDisplayIssues(`ID: ${facts[0]!.internal_id}`, original.evidence).length);
  assert.ok(dealDisplayIssues('Fixture Acme Storage', original.evidence).length);
  assert.ok(
    dealDisplayIssues('1. **Fixture Acme Storage**\nBengaluru warehouse', original.evidence).length,
  );
  assert.deepEqual(
    dealDisplayIssues(
      'I can draft a visit confirmation for Fixture Acme Storage, but cannot send it.',
      original.evidence,
    ),
    [],
  );
  assert.deepEqual(
    dealDisplayIssues('Warehouse 101: good area; availability needs checking.', original.evidence),
    [],
  );
});

test('graph keeps protected metadata out of every model request and exposes recall only to the bound employee', async () => {
  const { fixture, history } = await setup();
  const sessions: ToolSessionRequest[] = [];
  const model: TextModel = {
    startToolSession(request) {
      sessions.push(request);
      return {
        next: async () => ({ text: 'Hey!', calls: [], inputTokens: 1, outputTokens: 1 }),
        accept() {},
      };
    },
    async complete(request) {
      const planning = planningResult(request);
      if (planning) return planning;
      assert.ok(!JSON.stringify(request).includes('Fixture Acme'));
      assert.ok(!JSON.stringify(request).includes('protectedReply'));
      return {
        text: request.stage === 'verifier' ? '{"supported":true,"feedback":""}' : 'Hey!',
        inputTokens: 1,
        outputTokens: 1,
      };
    },
  };
  const assistant = new AssistantService(
    { model: 'fixture', timeoutMs: 5000 },
    model,
    undefined,
    undefined,
    async () => history,
    fixture.service,
  );
  const message = {
    messageId: 'chat',
    chatId: FIXTURE_JID,
    text: 'hey',
    fromMe: false,
    isGroup: false,
    mentionsBot: false,
    sentAtMs: Date.now(),
  };
  const before = fixture.state.calls.length;
  await assistant.prepare(message, signal(), trusted);
  assert.equal(fixture.state.calls.length, before);
  assert.ok(sessions[0]?.tools.some((t) => t.name === RECALL_TOOL));
  assert.ok(!JSON.stringify(sessions[0]?.messages).includes('Fixture Acme'));
  fixture.state.active = false;
  await assistant.prepare(message, signal(), trusted);
  assert.deepEqual(sessions[1]?.tools, []);
});
