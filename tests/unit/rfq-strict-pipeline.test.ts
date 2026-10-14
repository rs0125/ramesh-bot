/** Real SDK, graph and write service; fake HTTP/CRM, no credentials or paid calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { OpenAITextModel } from '../../src/infrastructure/openai/text-model.js';
import { loadAssistantConfig } from '../../src/config/assistant.js';
import { AssistantService } from '../../src/modules/assistant/assistant.service.js';
import { createTranscriptFixture } from '../../scripts/lib/transcript-fixture.js';
import { FIXTURE_EMPLOYEE, FIXTURE_JID } from '../../scripts/lib/sales-fixture.js';
import { assertStrictResponseSchema } from '../fixtures/strict-response-schema.js';
import type { ChatMessage } from '../../src/modules/assistant/assistant.types.js';
import { toolDelivery } from '../../src/modules/assistant/tool-evidence.js';
import { PRIVATE_HISTORY_REPLY } from '../../src/modules/assistant/conversation-memory.js';
import {
  PersonalToolService,
  type PersonalRepositoryPort,
} from '../../src/modules/scheduling/personal-tools.js';
import {
  authorizeDelivery,
  compositeDeliverySchema,
  getBusinessReply,
  writeDeliveryBundleSchema,
} from '../../src/modules/messaging/delivery-evidence.js';

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
    history?: 'personal' | 'business' | 'both';
    formatReceipt?: boolean;
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
  let requestText = brief;
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
        responseMode:
          options.mixed || options.repair || options.formatReceipt ? 'answer' : 'receipt_only',
        clarification: null,
        steps: [
          { id: 'save', goal: 'Capture the brief', dependsOn: [], toolNames: ['create_crm_rfq'] },
        ],
      });
    if (name === 'ramesh_sales_review') {
      reviews++;
      assert.equal(fixture.state.writes.length, 1, 'reply review observes the recorded action');
      const input = JSON.parse(body.input[0].content);
      assert.ok(
        input.business_write_evidence.some(
          (entry: any) => entry.exact_arguments?.raw_text === requestText,
        ),
      );
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
        options.mixed || options.repair || options.formatReceipt,
        'plain saves must not depend on formatter inference',
      );
      return message({
        additional_reply:
          options.formatReceipt || (options.repair && reviews === 0)
            ? ''
            : 'Parking and the deferred size/location are preserved in the original brief.',
      });
    }
    assert.equal(name, 'worker');
    if (body.input.some((item: any) => item.type === 'function_call_output'))
      return message('The action result is recorded; use the application receipt.');
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
    if (options.revoked) fixture.state.active = false;
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
  const actor = { ...FIXTURE_EMPLOYEE, chatId: FIXTURE_JID };
  const unexpectedPersonalCall = async (): Promise<never> => {
    assert.fail('Saving an RFQ must not operate on historical tasks or reminders.');
  };
  const personalRepository: PersonalRepositoryPort = {
    getReceipt: async () => null,
    saveContext: async () => {},
    applyBatch: unexpectedPersonalCall,
    list: unexpectedPersonalCall,
    recall: unexpectedPersonalCall,
    resolveSelection: unexpectedPersonalCall,
    finalizeSelections: unexpectedPersonalCall,
  };
  const personalTools = new PersonalToolService(
    personalRepository,
    async () => (fixture.state.active ? actor : null),
    () => now,
  );
  const history: ChatMessage[] = [];
  const at = now - 60000;
  const addHistory = (request: string, text: string, receipt: unknown) => {
    history.push(
      { role: 'user', content: request },
      {
        role: 'assistant',
        content: PRIVATE_HISTORY_REPLY,
        protectedReply: { text, receipt },
      },
    );
  };
  if (options.history === 'personal' || options.history === 'both')
    addHistory('Remind me to check the proposal.', 'Saved reminder: check the proposal.', {
      kind: 'personal',
      version: 1,
      employeeId: actor.employeeId,
      phoneE164: actor.phoneE164,
      runId: 'earlier-personal-turn',
      history: { at: new Date(at).toISOString(), activity: [] },
    });
  if (options.history === 'business' || options.history === 'both')
    addHistory(
      'Show my CRM deals.',
      'Your earlier CRM results.',
      toolDelivery(actor.employeeId, [], at, { historicalOnly: true }),
    );
  const assistant = new AssistantService(
    config,
    provider,
    undefined,
    undefined,
    async () => history,
    fixture.reads,
    { now: () => now, businessWrites: fixture.writes, personalTools },
  );
  const run = (text: string, batched = false) => {
    requestText = text;
    return assistant.prepare(
      {
        chatId: FIXTURE_JID,
        messageId: randomUUID(),
        text,
        sentAtMs: now,
        fromMe: false,
        isGroup: false,
        mentionsBot: false,
        ...(batched ? { batchMessageIds: [randomUUID(), randomUUID()] } : {}),
      },
      undefined,
      fixture.trusted(text),
    );
  };
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
  assert.ok(!h.stages.includes('ramesh_sales_review'));
  assert.ok(!h.stages.includes('ramesh_action_supplement'));
});

test('32K batched source survives empty-supplement formatting, review and delivery with mixed history', async () => {
  const h = harness({ history: 'both', formatReceipt: true });
  const source = '  Save this CRM requirement.\n'.padEnd(31_999, '界') + '\n';
  const result = await h.run(source, true);
  assert.equal(result.trace.outcome, 'completed', JSON.stringify(result.trace));
  assert.match(result.text, /^Saved RFQ:/);
  assert.ok(result.text.length < 4800);
  assert.equal(h.fixture.state.writes.length, 1);
  assert.equal(h.fixture.state.rfqs[0]!.args.raw_text, source);
  assert.ok(h.stages.includes('ramesh_sales_review'));
  assert.ok(h.stages.includes('ramesh_action_supplement'));
  assert.equal(
    await authorizeDelivery(result.businessEvidence, {
      write: (receipt) =>
        h.fixture.writes.canDeliver(
          { remoteJid: FIXTURE_JID },
          receipt,
          new AbortController().signal,
        ),
      personal: async () => true,
      business: (receipt) =>
        h.fixture.reads.canDeliver(
          { remoteJid: FIXTURE_JID },
          receipt,
          new AbortController().signal,
        ),
    }),
    true,
  );
});

test('reply rejection preserves receipts while revoked authorization still prevents dispatch', async () => {
  for (const options of [
    { reject: true, formatReceipt: true },
    { revoked: true },
    { reject: true, formatReceipt: true, history: 'both' as const },
    { revoked: true, history: 'both' as const },
  ]) {
    const h = harness(options);
    const result = await h.run(brief);
    assert.equal(h.fixture.state.writes.length, options.revoked ? 0 : 1);
    assert.equal(h.fixture.state.rfqs.length, options.revoked ? 0 : 1);
    if (options.revoked) assert.doesNotMatch(result.text, /Saved RFQ/);
    else {
      assert.match(result.text, /Saved RFQ/);
      assert.ok(result.trace.events?.some((event) => event.code === 'WRITE_RECEIPT_PRESERVED'));
    }
  }
});

test('an RFQ saves once with personal and business history and an empty explanation', async () => {
  for (const formatReceipt of [false, true]) {
    const h = harness({ history: 'both', formatReceipt });
    const source =
      '  Save this CRM requirement. Client: Fixture Wind Tools. Lead source: broker.\n' +
      '40,000–50,000 sqft covered plus 40,000 sqft open near Hoskote, Bangalore.\n' +
      'Fully fire compliant. Truck parking and bulky equipment storage. 3–4 trucks/week.\n' +
      '10 m clear height, 5 t/m² floor load; future provision for a 20 ton crane.\n#twenty\n';
    const result = await h.run(source);
    assert.equal(result.trace.outcome, 'completed');
    assert.match(result.text, /^Saved RFQ:/);
    assert.equal(h.fixture.state.writes.length, 1);
    assert.equal(h.fixture.state.rfqs.length, 1);
    assert.equal(h.fixture.state.rfqs[0]!.args.raw_text, source);
    assert.equal(h.stages.includes('ramesh_action_supplement'), formatReceipt);

    const receipt = writeDeliveryBundleSchema.parse(result.businessEvidence);
    const other = compositeDeliverySchema.parse(receipt.other);
    assert.equal(other.businessText, '');
    assert.equal(other.businessRecallAllowed, false);
    assert.equal(other.personal.history?.activity.length, 0);
    assert.equal(other.business.historicalOnly, true);
    assert.equal(getBusinessReply({ text: result.text, receipt }), undefined);
    assert.equal(getBusinessReply({ text: result.text, receipt: other }), undefined);
    for (const invalid of [
      { ...other, businessRecallAllowed: undefined },
      { ...other, businessRecallAllowed: true },
      { ...other, personal: { ...other.personal, employeeId: other.personal.employeeId + 1 } },
    ])
      assert.equal(compositeDeliverySchema.safeParse(invalid).success, false);

    for (const denied of ['none', 'write', 'personal', 'business']) {
      const checked: string[] = [];
      const check = async (name: string) => {
        checked.push(name);
        return name !== denied;
      };
      assert.equal(
        await authorizeDelivery(receipt, {
          write: () => check('write'),
          personal: () => check('personal'),
          business: () => check('business'),
        }),
        denied === 'none',
      );
      const order = ['write', 'personal', 'business'];
      assert.deepEqual(
        checked,
        denied === 'none' ? order : order.slice(0, order.indexOf(denied) + 1),
      );
    }
  }
});

test('receipt-only saves also work with just personal or just business history', async () => {
  for (const history of ['personal', 'business'] as const) {
    const h = harness({ history });
    const result = await h.run(brief);
    assert.equal(result.trace.outcome, 'completed');
    assert.match(result.text, /^Saved RFQ:/);
    assert.equal(h.fixture.state.writes.length, 1);
    const receipt = writeDeliveryBundleSchema.parse(result.businessEvidence);
    assert.equal(receipt.other?.kind, history === 'personal' ? 'personal' : 'context_tools');
  }
});

test('mixed answers and independent review repairs keep composition alongside the code-owned receipt', async () => {
  for (const options of [
    { mixed: true },
    { repair: true },
    { mixed: true, history: 'both' as const },
    { repair: true, history: 'both' as const },
  ]) {
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
