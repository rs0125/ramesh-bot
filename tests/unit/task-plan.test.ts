import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTaskPlan } from '../../src/modules/assistant/task-plan.js';
import { AssistantService } from '../../src/modules/assistant/assistant.service.js';
import { createSalesFixture, FIXTURE_JID } from '../../scripts/lib/sales-fixture.js';
import type { TextModel, ModelRequest } from '../../src/modules/assistant/assistant.types.js';
const plan = {
  objective: 'Prepare a follow-up brief',
  successCriteria: ['Identify priorities with supported next steps'],
  steps: [
    { id: 'find', goal: 'Read assigned work', dependsOn: [], toolNames: ['search_crm_leads'] },
  ],
};
test('plans reject unknown tools, duplicate IDs and forward/circular dependencies', () => {
  assert.deepEqual(validateTaskPlan(plan, [{ name: 'search_crm_leads' }]), plan);
  assert.throws(() => validateTaskPlan(plan, []));
  assert.throws(() =>
    validateTaskPlan({ ...plan, steps: [...plan.steps, ...plan.steps] }, [
      { name: 'search_crm_leads' },
    ]),
  );
  assert.throws(() =>
    validateTaskPlan({ ...plan, steps: [{ ...plan.steps[0], dependsOn: ['later'] }] }, [
      { name: 'search_crm_leads' },
    ]),
  );
});
test('ordinary conversation takes direct route without planner or native tool session', async () => {
  const requests: ModelRequest[] = [];
  const model: TextModel = {
    startToolSession() {
      throw new Error('Ordinary chat must not research');
    },
    async complete(request) {
      requests.push(request);
      return {
        text:
          request.stage === 'converser'
            ? JSON.stringify({
                route: 'direct',
                objective: 'Acknowledge greeting',
                reply: 'Hey! How is your day going?',
              })
            : request.stage === 'verifier'
              ? '{"supported":true,"feedback":"","repair":"none"}'
              : 'Hey! How is your day going?',
        inputTokens: 1,
        outputTokens: 1,
      };
    },
  };
  const fixture = createSalesFixture();
  const reply = await new AssistantService(
    { model: 'fixture', timeoutMs: 5000 },
    model,
    undefined,
    undefined,
    undefined,
    fixture.service,
  ).prepare(
    {
      chatId: FIXTURE_JID,
      messageId: 'hello',
      text: 'hey',
      sentAtMs: Date.now(),
      fromMe: false,
      isGroup: false,
      mentionsBot: false,
    },
    undefined,
    { runId: 'hello', key: { remoteJid: FIXTURE_JID } },
  );
  assert.equal(reply.trace.outcome, 'completed');
  assert.deepEqual(
    requests.map((r) => r.stage),
    ['converser', 'formatter', 'verifier'],
  );
  assert.equal(fixture.state.calls.length, 0);
});

test('plan validation accepts newly registered capabilities without CRM-specific step names', () => {
  const documentPlan = {
    objective: 'Compare the renewal clauses in the supplied documents',
    successCriteria: ['Cite conflicting clauses and identify unread sections'],
    steps: [
      {
        id: 'sections',
        goal: 'Read the relevant authorized sections',
        dependsOn: [],
        toolNames: ['inspect_private_document'],
      },
      {
        id: 'compare',
        goal: 'Compare the cited clauses with uncertainty',
        dependsOn: ['sections'],
        toolNames: [],
      },
    ],
  };
  assert.deepEqual(
    validateTaskPlan(documentPlan, [{ name: 'inspect_private_document' }]),
    documentPlan,
  );
  assert.throws(() => validateTaskPlan(documentPlan, [{ name: 'search_crm_leads' }]));
  assert.throws(() =>
    validateTaskPlan(
      { ...documentPlan, steps: [{ ...documentPlan.steps[0], toolNames: ['send_contract'] }] },
      [{ name: 'inspect_private_document' }],
    ),
  );
});
