/** Replay the real graph against in-memory checkpoints and synthetic sources only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { createSalesFixture, FIXTURE_JID } from '../../scripts/lib/sales-fixture.js';
import { buildSalesGraph } from '../../src/modules/assistant/sales.graph.js';
import { replayModelResponse, withModelReplay } from '../../src/modules/assistant/model-replay.js';
import type { AgentCheckpointSession } from '../../src/modules/assistant/checkpoint.types.js';
import type {
  ModelRequest,
  ModelResult,
  TextModel,
} from '../../src/modules/assistant/assistant.types.js';

const START = Date.parse('2026-10-05T05:00:00Z');
const copy = <T>(value: T): T => structuredClone(value);
const result = (text: string): ModelResult => ({ text, inputTokens: 1, outputTokens: 1 });

class MemoryCheckpoint implements AgentCheckpointSession {
  readonly metadata = { requestTimeMs: START, startedAtMs: START, deadlineAtMs: START + 60_000 };
  readonly responses = new Map<number, { request: unknown; response: unknown }>();
  readonly policies = new Map<string, unknown>();
  async read<T>(sequence: number, request: unknown): Promise<T | undefined> {
    const row = this.responses.get(sequence);
    if (row && isDeepStrictEqual(row.request, request)) return copy(row.response) as T;
    for (const key of this.responses.keys()) if (key >= sequence) this.responses.delete(key);
    return undefined;
  }
  async save(sequence: number, request: unknown, response: unknown) {
    this.responses.set(sequence, { request: copy(request), response: copy(response) });
  }
  async consume() {
    return true;
  }
  async policy<T>(key: string, update?: (current: T | undefined) => T): Promise<T | undefined> {
    if (update) this.policies.set(key, copy(update(copy(this.policies.get(key)) as T | undefined)));
    return copy(this.policies.get(key)) as T | undefined;
  }
}

function setup() {
  const checkpoint = new MemoryCheckpoint();
  // Stable source facts isolate request-clock drift from actual record changes.
  const fixture = createSalesFixture(() => START);
  const generated: string[] = [];
  const requests: ModelRequest[] = [];
  const accepted: Array<Record<string, any>> = [];
  const model: TextModel = {
    async complete(request) {
      requests.push(copy(request));
      return (
        await replayModelResponse(request, async () => {
          generated.push(request.stage);
          if (request.stage === 'converser')
            return result(
              JSON.stringify({ route: 'work', objective: 'Read one warehouse.', reply: '' }),
            );
          if (request.stage === 'planner')
            return result(
              JSON.stringify({
                objective: 'Read one warehouse.',
                successCriteria: ['Return recorded evidence.'],
                steps: [
                  {
                    id: 'read',
                    goal: 'Find one candidate.',
                    dependsOn: [],
                    toolNames: ['search_warehouses'],
                  },
                ],
              }),
            );
          if (request.stage === 'verifier')
            return result(JSON.stringify({ supported: true, feedback: '', repair: 'none' }));
          assert.equal(request.stage, 'formatter');
          const input = JSON.parse(request.messages[0]!.content);
          return result(
            input.research_limited
              ? 'The research deadline arrived before I could check this request.'
              : 'ID 101: a recorded Bengaluru candidate. Confirm current availability.',
          );
        })
      ).response;
    },
    startToolSession(request) {
      const outputs: unknown[] = [];
      let step = 0;
      return {
        async next(remaining, _signal, allowed) {
          const current = step++;
          return (
            await replayModelResponse(
              { request, outputs, remaining, allowed, step: current },
              async () => {
                generated.push(`worker-${current}`);
                return {
                  ...result(''),
                  calls:
                    current === 0
                      ? [
                          {
                            id: 'one',
                            name: 'search_warehouses',
                            arguments: '{"city":"Bengaluru","limit":1}',
                          },
                        ]
                      : [],
                };
              },
            )
          ).response;
        },
        accept(callId, output) {
          outputs.push({ callId, output: copy(output) });
          accepted.push(copy(output) as Record<string, any>);
        },
      };
    },
  };
  const run = () =>
    withModelReplay(checkpoint, () =>
      buildSalesGraph(
        model,
        (signal) =>
          fixture.service.openTools(
            { key: { remoteJid: FIXTURE_JID }, runId: 'budget-replay' },
            signal,
          ),
        {
          now: () => checkpoint.metadata.requestTimeMs,
          researchDeadlineMs: checkpoint.metadata.deadlineAtMs,
        },
      ).invoke(
        { input: 'Show one warehouse.', audience: 'dm', history: [] },
        { recursionLimit: 25 },
      ),
    );
  return { checkpoint, fixture, generated, requests, accepted, run };
}

test('tool and finalizer budget observations retain exact model requests when a restart advances wall time', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  const fixture = setup();
  const first = await fixture.run();
  assert.equal(first.unavailable, false);
  const firstRequests = copy(fixture.requests);
  const firstOutput = copy(fixture.accepted[0]);
  const generatedCount = fixture.generated.length;
  const storedHints = [...fixture.checkpoint.policies].filter(([key]) =>
    key.startsWith('research-clock:'),
  );
  assert.deepEqual(
    storedHints.map(([key]) => key),
    ['research-clock:tool-1', 'research-clock:formatter-1-0', 'research-clock:verifier-1-0'],
  );
  assert.equal(firstOutput!.runtime_budget.research_remaining_ms_at_observation, 60_000);

  t.mock.timers.setTime(START + 10_000);
  fixture.requests.length = 0;
  const resumed = await fixture.run();
  assert.equal(resumed.reply, first.reply);
  assert.deepEqual(
    fixture.requests,
    firstRequests,
    'even clock hints in formatter/verifier fingerprints are identical',
  );
  assert.deepEqual(
    fixture.accepted[1],
    firstOutput,
    'worker sees identical refreshed evidence and clock observation',
  );
  assert.equal(
    fixture.generated.length,
    generatedCount,
    'every completed model response was replayed',
  );
  assert.equal(
    fixture.fixture.state.calls.length,
    2,
    'business sources were still freshly authorized and read',
  );
  assert.deepEqual(
    [...fixture.checkpoint.policies].filter(([key]) => key.startsWith('research-clock:')),
    storedHints,
  );
});

test('a stale positive checkpoint hint never extends the actual research deadline on restart', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  const fixture = setup();
  await fixture.run();
  const priorReads = fixture.fixture.state.calls.length;
  const priorResearchCalls = fixture.generated.filter(
    (stage) => stage === 'planner' || stage.startsWith('worker-'),
  ).length;
  // This observation could come from an earlier zero-tool finalization attempt.
  fixture.checkpoint.policies.set('research-clock:formatter-0-0', { remainingMs: 45_000 });
  fixture.checkpoint.policies.set('research-clock:verifier-0-0', { remainingMs: 45_000 });
  t.mock.timers.setTime(fixture.checkpoint.metadata.deadlineAtMs + 1);
  fixture.requests.length = 0;
  const resumed = await fixture.run();
  assert.equal(resumed.researchExhausted, true);
  assert.equal(
    fixture.fixture.state.calls.length,
    priorReads,
    'expired deadline prevents all additional source execution',
  );
  assert.equal(
    fixture.generated.filter((stage) => stage === 'planner' || stage.startsWith('worker-')).length,
    priorResearchCalls,
  );
  assert.equal(
    fixture.requests.some((request) => request.stage === 'planner'),
    false,
  );
  const formatter = fixture.requests.find((request) => request.stage === 'formatter')!;
  const input = JSON.parse(formatter.messages[0]!.content);
  assert.equal(input.research_limited, true);
  assert.equal(input.tool_budget.research_remaining_ms_at_observation, 45_000);
  assert.deepEqual(input.evidence, []);
  assert.match(resumed.reply, /deadline/);
});
