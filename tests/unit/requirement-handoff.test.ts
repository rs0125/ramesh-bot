/** Real graph, scripted models and synthetic records. These check handoff, not model accuracy. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSalesGraph } from '../../src/modules/assistant/sales.graph.js';
import type {
  ChatMessage,
  ModelRequest,
  TextModel,
  ToolSessionRequest,
} from '../../src/modules/assistant/assistant.types.js';
import {
  createSalesFixture,
  FIXTURE_JID,
  FIXTURE_LEAD_ID,
} from '../../scripts/lib/sales-fixture.js';
import type { TaskPlan } from '../../src/modules/assistant/task-plan.js';

const generated = (value: unknown) => ({
  text: typeof value === 'string' ? value : JSON.stringify(value),
  inputTokens: 1,
  outputTokens: 1,
});
const approved = { supported: true, feedback: '', repair: 'none', reason: 'none' };
const ready: TaskPlan = {
  responseMode: 'answer',
  objective: 'Read the intended CRM brief from the original request.',
  successCriteria: ['Keep the user requirement distinct from recorded facts.'],
  clarification: null,
  steps: [{ id: 'read', goal: 'Read the brief.', toolNames: ['read_crm_lead'], dependsOn: [] }],
};
const question: TaskPlan = {
  responseMode: 'answer',
  objective: 'Resolve the area bound before finding warehouses.',
  successCriteria: ['Establish the intended area bound.'],
  steps: [],
  clarification: {
    question: 'For this search, is 30,000 sqft the minimum or the maximum?',
    missingDecision: 'The latest request names both a minimum and a maximum for one area.',
  },
};

async function run(
  input: string,
  options: {
    workflow?: 'general' | 'lookup';
    history?: ChatMessage[];
    plans?: TaskPlan[];
    rejectFirst?: boolean;
  } = {},
) {
  const fixture = createSalesFixture();
  const requests: ModelRequest[] = [],
    sessions: ToolSessionRequest[] = [];
  let planning = 0,
    reviews = 0;
  const draft = 'The requested CRM brief is available. Its recorded details need verification.';
  const model: TextModel = {
    async complete(request) {
      requests.push(request);
      if (request.stage === 'converser')
        return generated({
          route: 'work',
          workflow: options.workflow ?? 'general',
          // Captured failure shape: this paraphrase must not drive any downstream stage.
          objective: 'The user requires a maximum area of 10000 sqft.',
          lookupTools: options.workflow === 'lookup' ? ['read_crm_lead'] : [],
          reply: '',
        });
      if (request.stage === 'planner') return generated(options.plans?.[planning++] ?? ready);
      if (request.stage === 'verifier')
        return generated(
          options.rejectFirst && reviews++ === 0
            ? {
                supported: false,
                feedback: 'The original request already specifies a minimum; read the brief.',
                repair: 'tools',
                reason: 'incomplete_answer',
              }
            : approved,
        );
      throw new Error(`Unexpected model pass: ${request.stage}`);
    },
    startToolSession(request) {
      sessions.push(request);
      let next = 0;
      return {
        async next() {
          return next++ === 0
            ? {
                ...generated(''),
                calls: [
                  {
                    id: 'read',
                    name: 'read_crm_lead',
                    arguments: JSON.stringify({ id: FIXTURE_LEAD_ID }),
                  },
                ],
              }
            : { ...generated(draft), calls: [] };
        },
        accept() {},
      };
    },
  };
  const result = await buildSalesGraph(
    model,
    (signal) =>
      fixture.service.openTools({ key: { remoteJid: FIXTURE_JID }, runId: 'requirements' }, signal),
    { optimizeLatency: true },
  ).invoke(
    { input, history: options.history ?? [], audience: 'dm' },
    { signal: AbortSignal.timeout(10000) },
  );
  return { result, fixture, requests, sessions };
}

test('wrong router quantities never become planner inputs or worker instructions, including lookup fast path', async () => {
  const input =
    'Find candidates for the CRM inquiry. Need 10000 sqft max budget 25 rupees. No changes or contacts.';
  for (const workflow of ['general', 'lookup'] as const) {
    const observed = await run(input, { workflow });
    assert.equal(observed.result.approved, true);
    const planner = observed.requests.find((r) => r.stage === 'planner');
    if (workflow === 'general') {
      const payload = JSON.parse(planner!.messages[0]!.content);
      assert.equal(payload.request, input);
      assert.equal(Object.hasOwn(payload, 'objective'), false);
    } else assert.equal(planner, undefined);
    const session = observed.sessions[0]!;
    assert.doesNotMatch(
      session.instructions,
      /Validated task_plan|The user requires a maximum area/,
    );
    assert.doesNotMatch(JSON.stringify(session.messages), /The user requires a maximum area/);
    assert.equal(session.messages.at(-2)!.role, 'assistant');
    assert.ok(JSON.parse(session.messages.at(-2)!.content).provisional_task_plan);
    assert.deepEqual(session.messages.at(-1), { role: 'user', content: input });
    assert.equal(observed.fixture.state.calls.length, 1);
  }
});

test('a material clarification is reviewed and delivered without worker, formatting model or source calls', async () => {
  const observed = await run(
    'Find an option with 30000 sqft minimum max, keep the budget unchanged.',
    { plans: [question] },
  );
  assert.equal(observed.result.reply, question.clarification!.question);
  assert.equal(observed.result.approved, true);
  assert.equal(observed.sessions.length, 0);
  assert.equal(observed.fixture.state.calls.length, 0);
  assert.deepEqual(
    observed.requests.map((r) => r.stage),
    ['converser', 'planner', 'verifier'],
  );
  const review = JSON.parse(observed.requests.at(-1)!.messages[0]!.content);
  assert.equal(review.awaiting_clarification, true);
});

test('a terse clarification answer retains the original request and the actual asked question', async () => {
  const history: ChatMessage[] = [
    { role: 'user', content: 'For Dabaspet, 30000 sqft minimum max, budget 25. Read only.' },
    { role: 'assistant', content: question.clarification!.question },
  ];
  const observed = await run('minimum. keep the rest.', { history });
  const payload = JSON.parse(
    observed.requests.find((r) => r.stage === 'planner')!.messages[0]!.content,
  );
  assert.equal(payload.request, 'minimum. keep the rest.');
  assert.deepEqual(payload.history, history);
  assert.deepEqual(observed.sessions[0]!.messages.slice(0, 2), history);
  assert.equal(observed.result.approved, true);
  assert.equal(observed.fixture.state.calls.length, 1);
});

test('review can reject needless clarification and proceed without asking the user again', async () => {
  const observed = await run('At least 30000 sqft in Dabaspet. Read the brief.', {
    plans: [question, ready],
    rejectFirst: true,
  });
  assert.equal(observed.result.approved, true);
  assert.doesNotMatch(observed.result.reply, /minimum or the maximum/);
  assert.equal(observed.sessions.length, 1);
  assert.equal(observed.fixture.state.calls.length, 1);
  assert.equal(observed.requests.filter((r) => r.stage === 'planner').length, 2);
});
