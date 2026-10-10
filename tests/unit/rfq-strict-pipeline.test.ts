/** Real SDK, graph and write service; fake HTTP/CRM, no credentials or paid calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { OpenAITextModel } from '../../src/infrastructure/openai/text-model.js';
import { loadAssistantConfig } from '../../src/config/assistant.js';
import { AssistantService } from '../../src/modules/assistant/assistant.service.js';
import { createTranscriptFixture } from '../../scripts/lib/transcript-fixture.js';
import { FIXTURE_JID } from '../../scripts/lib/sales-fixture.js';
import { assertStrictResponseSchema } from '../fixtures/strict-response-schema.js';

const now = Date.parse('2026-10-10T04:00:00Z');
const brief =
  '  Save this requirement: Fixture Cedar needs office + warehouse.\nSize/location later. Parking 2 trucks.\n#twenty\n';

function harness(
  options: {
    mixed?: boolean;
    reject?: boolean;
    repair?: boolean;
    unknown?: boolean;
    revoked?: boolean;
  } = {},
) {
  const fixture = createTranscriptFixture('rfq', () => now);
  fixture.state.uncertainNextCreate = options.unknown === true;
  const config = loadAssistantConfig({
    OPENAI_API_KEY: 'synthetic',
    OPENAI_MODEL: 'gpt-6.1-sol',
    AGENT_MODEL_ROUTING: 'split',
    AGENT_TOOL_LOADING: 'deferred',
    AGENT_TIMEOUT_MS: '30000',
  })!;
  const stages: string[] = [];
  let reviews = 0;
  const provider = new OpenAITextModel(config, async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const name = body.text?.format?.name ?? 'worker';
    stages.push(name);
    if (body.text) {
      assert.equal(body.text.format.strict, true);
      assertStrictResponseSchema(body.text.format.schema);
    }
    const message = (value: unknown) =>
      Response.json({
        id: randomUUID(),
        object: 'response',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            phase: 'final_answer',
            content: [
              {
                type: 'output_text',
                text: typeof value === 'string' ? value : JSON.stringify(value),
              },
            ],
          },
        ],
      });
    if (name === 'ramesh_route')
      return message({
        route: 'work',
        workflow: 'general',
        objective: 'Capture the original RFQ',
        reply: '',
        lookupTools: [],
      });
    if (name === 'ramesh_task_plan')
      return message({
        objective: 'Save the requested RFQ',
        successCriteria: ['Preserve the complete source and report the real result.'],
        responseMode: options.mixed ? 'answer' : 'receipt_only',
        clarification: null,
        steps: [
          { id: 'save', goal: 'Capture the brief', dependsOn: [], toolNames: ['create_crm_rfq'] },
        ],
      });
    if (name === 'ramesh_sales_review') {
      reviews++;
      assert.equal(fixture.state.writes.length, 0, 'review precedes every dispatch');
      const input = JSON.parse(body.input[0].content);
      assert.ok(
        input.business_write_evidence.some(
          (entry: any) =>
            entry.exact_arguments?.raw_text ===
            (options.mixed || options.repair ? brief + ' Also explain what was preserved.' : brief),
        ),
      );
      if (options.revoked) fixture.state.active = false;
      const needsRepair = options.repair && reviews === 1;
      return message({
        supported: !options.reject && !needsRepair,
        feedback: needsRepair
          ? 'The user also requested an explanation; preserve that answer.'
          : '',
        repair: needsRepair ? 'format' : 'none',
        reason: options.reject || needsRepair ? 'unsupported_claim' : 'none',
        remainder_supported: !options.reject,
        findings: [],
      });
    }
    if (name === 'ramesh_action_supplement') {
      assert.ok(
        options.mixed || options.repair,
        'plain saves must not depend on formatter inference',
      );
      return message({
        additional_reply:
          'Parking and the deferred size/location are preserved in the original brief.',
      });
    }
    assert.equal(name, 'worker');
    if (body.input.some((item: any) => item.type === 'function_call_output'))
      return message('Prepared for independent review; no success claim yet.');
    const definitions = body.tools.flatMap((tool: any) =>
      tool.type === 'namespace'
        ? tool.tools.map((child: any) => ({ ...child, namespace: tool.name }))
        : [tool],
    );
    for (const tool of definitions.filter((tool: any) => tool.type === 'function')) {
      assert.equal(tool.strict, true);
      assertStrictResponseSchema(tool.parameters);
    }
    const create = definitions.find((tool: any) => tool.name === 'create_crm_rfq');
    assert.ok(create);
    const args = Object.fromEntries(
      Object.keys(create.parameters.properties).map((key) => [key, null]),
    );
    return Response.json({
      id: randomUUID(),
      object: 'response',
      status: 'completed',
      output: [
        {
          type: 'function_call',
          name: create.name,
          namespace: create.namespace,
          call_id: 'save',
          arguments: JSON.stringify(args),
        },
      ],
    });
  });
  const assistant = new AssistantService(
    config,
    provider,
    undefined,
    undefined,
    undefined,
    fixture.reads,
    { now: () => now, businessWrites: fixture.writes },
  );
  const run = (text: string) =>
    assistant.prepare(
      {
        chatId: FIXTURE_JID,
        messageId: randomUUID(),
        text,
        sentAtMs: now,
        fromMe: false,
        isGroup: false,
        mentionsBot: false,
      },
      undefined,
      fixture.trusted(text),
    );
  return { fixture, stages, run };
}

test('strict receipt-only intake saves the untouched source once without a formatting model call', async () => {
  const h = harness();
  const result = await h.run(brief);
  assert.match(result.text, /^Saved RFQ:/);
  assert.match(result.text, /Full brief saved in the description/);
  assert.equal(h.fixture.state.writes.length, 1);
  assert.equal(h.fixture.state.rfqs[0]!.args.raw_text, brief);
  assert.deepEqual(Object.keys(h.fixture.state.rfqs[0]!.args).sort(), ['operation_id', 'raw_text']);
  assert.ok(h.stages.includes('ramesh_sales_review'));
  assert.ok(!h.stages.includes('ramesh_action_supplement'));
});

test('receipt-only routing never bypasses rejection or authorization rechecking', async () => {
  for (const options of [{ reject: true }, { revoked: true }]) {
    const h = harness(options);
    const result = await h.run(brief);
    assert.equal(h.fixture.state.writes.length, 0);
    assert.equal(h.fixture.state.rfqs.length, 0);
    assert.doesNotMatch(result.text, /Saved RFQ/);
  }
});

test('mixed answers and independent review repairs keep composition alongside the code-owned receipt', async () => {
  for (const options of [{ mixed: true }, { repair: true }]) {
    const h = harness(options);
    const result = await h.run(brief + ' Also explain what was preserved.');
    assert.match(result.text, /Parking and the deferred size\/location/);
    assert.match(result.text, /Saved RFQ:/);
    assert.equal(h.fixture.state.writes.length, 1);
    assert.ok(h.stages.includes('ramesh_action_supplement'));
    if (options.repair)
      assert.equal(h.stages.filter((stage) => stage === 'ramesh_sales_review').length, 2);
  }
});

test('an uncertain receipt is checked with the same arguments and stops inviting repeated retry', async () => {
  const h = harness({ unknown: true });
  const first = await h.run(brief);
  assert.match(first.text, /can’t confirm/);
  const callsBefore = h.stages.length;
  const second = await h.run('retry');
  assert.equal(
    h.stages.length,
    callsBefore,
    'application recovery needs no formatting or tool inference',
  );
  assert.match(second.text, /still can’t confirm/);
  assert.match(second.text, /administrator to look for it in CRM first/);
  assert.doesNotMatch(
    second.text,
    /Say “retry”|Saved RFQ|submitting again|resubmit|new submission/,
  );
  assert.equal(h.fixture.state.rfqs.length, 1);
  assert.equal(h.fixture.state.writes.length, 2);
  assert.deepEqual(h.fixture.state.writes[0]!.args, h.fixture.state.writes[1]!.args);
});
