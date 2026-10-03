/** Mixed tool-family budgets use real graph/executor code with synthetic data and no model API. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSalesGraph } from '../../src/modules/assistant/sales.graph.js';
import {
  ContextToolRun,
  type BoundContextReader,
} from '../../src/modules/assistant/tool-executor.js';
import {
  PersonalToolRun,
  type PersonalRepositoryPort,
} from '../../src/modules/scheduling/personal-tools.js';
import type { TextModel } from '../../src/modules/assistant/assistant.types.js';

const now = Date.parse('2026-10-04T04:00:00Z');
const actor = { employeeId: 7, phoneE164: '+919000000007', chatId: '919000000007@s.whatsapp.net' };
const result = (text: string) => ({ text, inputTokens: 0, outputTokens: 0 });

async function scenario(withPersonal: boolean, repeatExhausted = false) {
  let dispatched = 0;
  const reader: BoundContextReader = {
    employeeId: actor.employeeId,
    async discover() {
      return [
        {
          name: 'read_warehouse',
          description: 'Read a synthetic warehouse.',
          inputSchema: {
            type: 'object',
            properties: { id: { type: 'integer' } },
            required: ['id'],
            additionalProperties: false,
          },
        },
      ];
    },
    async call(_name, args) {
      dispatched++;
      return {
        source_path: `/api/v1/warehouses/${args.id}`,
        status: 200,
        data: { id: args.id, city: 'Synthetic City' },
        meta: { requestId: `synthetic-${args.id}`, generatedAt: new Date(now).toISOString() },
      };
    },
  };
  const run = await ContextToolRun.open(
    async () => reader,
    undefined,
    AbortSignal.timeout(5000),
    () => now,
  );
  assert.ok(run);
  const unused = async (): Promise<never> => assert.fail('No personal persistence was requested');
  const repository: PersonalRepositoryPort = {
    getReceipt: unused,
    applyBatch: unused,
    list: unused,
    recall: unused,
    resolveSelection: unused,
    finalizeSelections: unused,
    saveContext: async () => {},
  };
  const personal = withPersonal
    ? new PersonalToolRun(
        repository,
        async () => actor,
        actor,
        {
          runId: 'synthetic-budget-run',
          key: { remoteJid: actor.chatId },
          checkpointLease: { leaseToken: 'synthetic-lease' },
          commandMessages: [
            {
              id: 'source',
              text: 'Review warehouse records.',
              receivedAtMs: now,
              forwarded: false,
            },
          ],
        },
        () => now,
      )
    : undefined;
  const outputs: Array<Record<string, unknown>> = [];
  const continuations: Array<{ remaining: number; allowed: readonly string[] }> = [];
  const answer = 'I reviewed 24 warehouse records. Additional records remain unchecked.';
  const model: TextModel = {
    async complete(request) {
      if (request.stage === 'converser')
        return result(
          JSON.stringify({
            route: 'work',
            objective: 'Review warehouse records',
            reply: '',
            workflow: 'general',
          }),
        );
      if (request.stage === 'planner')
        return result(
          JSON.stringify({
            objective: 'Review warehouse records',
            successCriteria: ['Report supported records and limits'],
            steps: [
              { id: 'read', goal: 'Review records', dependsOn: [], toolNames: ['read_warehouse'] },
            ],
          }),
        );
      const context = JSON.parse(request.messages[0]!.content);
      assert.equal(
        context.evidence.length,
        24,
        'Formatting and verification retain all successful reads',
      );
      assert.equal(context.tool_budget.families.business, 0);
      if (request.stage === 'verifier')
        return result(JSON.stringify({ supported: true, feedback: '', repair: 'none' }));
      assert.equal(request.stage, 'formatter');
      return result(answer);
    },
    startToolSession() {
      let proposed = 0;
      return {
        async next(remaining, _signal, allowed = []) {
          continuations.push({ remaining, allowed });
          // Deliberately simulate a stale model proposal after the family was exhausted.
          const call = remaining > 0 && (proposed < 25 || repeatExhausted);
          return {
            ...result(call ? '' : answer),
            calls: call
              ? [
                  {
                    id: `call-${++proposed}`,
                    name: 'read_warehouse',
                    arguments: JSON.stringify({ id: proposed }),
                  },
                ]
              : [],
          };
        },
        accept(_id, output) {
          outputs.push(output as Record<string, unknown>);
        },
      };
    },
  };
  const response = await buildSalesGraph(model, async () => ({ status: 'available', run }), {
    personal,
    now: () => now,
  }).invoke(
    { input: 'Review warehouse records.', history: [], audience: 'dm' },
    { recursionLimit: 76 },
  );
  assert.equal(response.reply, answer);
  assert.equal(response.unavailable, false);
  assert.equal(response.business?.delivery.checks.length, 24);
  assert.equal(dispatched, 24);
  return { outputs, continuations };
}

test('exhausted reads are no longer callable and a stale call preserves the researched answer', async () => {
  const { outputs, continuations } = await scenario(true);
  assert.ok(continuations[0]!.allowed.includes('read_warehouse'));
  assert.equal(continuations[24]!.remaining, 4);
  assert.ok(!continuations[24]!.allowed.includes('read_warehouse'));
  assert.ok(continuations[24]!.allowed.includes('personal_apply'));
  assert.equal(outputs[24]!.code, 'TOOL_BUDGET_EXHAUSTED');
  assert.equal(outputs[24]!.family, 'business');
});

test('a model repeating exhausted calls cannot exceed the global 28-step limit', async () => {
  const { outputs, continuations } = await scenario(true, true);
  assert.equal(continuations.length, 28);
  assert.equal(outputs.filter((output) => output.code === 'TOOL_BUDGET_EXHAUSTED').length, 4);
});

test('a read-only run finishes from retained evidence when its own allowance is exhausted', async () => {
  const { outputs, continuations } = await scenario(false);
  assert.equal(continuations.length, 24);
  assert.equal(outputs.length, 24);
});
