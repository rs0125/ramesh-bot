/** Follow-up execution contracts. Synthetic sources and scripted models, no API calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSalesFixture, FIXTURE_JID } from '../../scripts/lib/sales-fixture.js';
import { buildSalesGraph } from '../../src/modules/assistant/sales.graph.js';
import { RECALL_TOOL } from '../../src/modules/assistant/business-recall.js';
import { PRIVATE_HISTORY_REPLY } from '../../src/modules/assistant/conversation-memory.js';
import type {
  ChatMessage,
  TextModel,
  ModelRequest,
} from '../../src/modules/assistant/assistant.types.js';
import { planningResult } from '../fixtures/planning-model.js';
import { ContextEngineError } from '../../src/modules/context-engine/context.types.js';

const result = (text: string) => ({ text, inputTokens: 1, outputTokens: 1 });
const trusted = { key: { remoteJid: FIXTURE_JID }, runId: 'followup-fixture' };
const signal = () => new AbortController().signal;

for (const transient of [false, true])
  test(`approved shortlist preserves selection through scoped recall (transient recovery: ${transient})`, async () => {
    const fixture = createSalesFixture();
    const reply =
      '1. ID 103\nPro: A recorded option.\nCon: Availability needs confirmation.\n\n2. ID 101\nPro: Another recorded option.\nCon: Availability needs confirmation.';
    let step = 0;
    const firstModel: TextModel = {
      startToolSession() {
        return {
          async next() {
            return {
              ...result(reply),
              calls:
                step++ === 0
                  ? [
                      {
                        id: 'search',
                        name: 'search_warehouses',
                        arguments: '{"city":"Bengaluru","limit":10}',
                      },
                    ]
                  : [],
            };
          },
          accept() {},
        };
      },
      async complete(request) {
        return (
          planningResult(request) ??
          result(
            request.stage === 'verifier'
              ? '{"supported":true,"feedback":"","repair":"none","reason":"none"}'
              : reply,
          )
        );
      },
    };
    const first = await buildSalesGraph(firstModel, (s) =>
      fixture.service.openTools(trusted, s),
    ).invoke({ input: 'Pick two options.', history: [], audience: 'dm' }, { recursionLimit: 30 });
    assert.deepEqual(first.business?.delivery.displayedRecords, [
      { kind: 'warehouse', id: 103, position: 1 },
      { kind: 'warehouse', id: 101, position: 2 },
    ]);
    assert.equal(
      await fixture.service.canDeliver(trusted.key, first.business!.delivery, signal()),
      true,
    );
    const history: ChatMessage[] = [
      {
        role: 'assistant',
        content: PRIVATE_HISTORY_REPLY,
        protectedReply: { text: first.reply, receipt: first.business!.delivery },
      },
    ];
    fixture.state.calls.length = 0;
    let failed = false;
    fixture.state.mutate = (e, tool, args) => {
      if (transient && !failed && tool === 'read_warehouse' && args.id === 103) {
        failed = true;
        throw new ContextEngineError('UNAVAILABLE', true);
      }
      if (tool === 'read_warehouse') e.data.micro_market = 'Updated fixture locality';
    };
    let next = 0;
    const requests: ModelRequest[] = [];
    const followup: TextModel = {
      startToolSession() {
        return {
          async next() {
            return {
              ...result('Use the current source labels.'),
              calls:
                next++ < (transient ? 2 : 1)
                  ? [{ id: `recall-${next}`, name: RECALL_TOOL, arguments: '{}' }]
                  : [],
            };
          },
          accept() {},
        };
      },
      async complete(request) {
        const plan = planningResult(request);
        if (plan) return plan;
        requests.push(request);
        const input = JSON.parse(request.messages[0]!.content);
        assert.equal(input.recalled.length, 1);
        assert.equal(input.recalled[0].selection_status, 'complete');
        assert.deepEqual(input.recalled[0].unavailable_checks, []);
        assert.deepEqual(
          input.recalled[0].displayed_selection.map((r: { id: number; position: number }) => [
            r.id,
            r.position,
          ]),
          [
            [103, 1],
            [101, 2],
          ],
        );
        assert.equal(input.recalled[0].previous_reply, undefined);
        assert.match(JSON.stringify(input.recalled[0].fresh_evidence), /Updated fixture locality/);
        return result(
          request.stage === 'verifier'
            ? '{"supported":true,"feedback":"","repair":"none","reason":"none"}'
            : 'Both selected records currently use the same recorded locality label. That does not confirm their exact addresses.',
        );
      },
    };
    const second = await buildSalesGraph(followup, (s) =>
      fixture.service.openTools(trusted, s),
    ).invoke(
      { input: 'What do the location labels mean here?', history, audience: 'dm' },
      { recursionLimit: 30 },
    );
    assert.equal(second.approved, true);
    assert.deepEqual(
      fixture.state.calls.map(({ tool, args }) => [tool, args.id]),
      [
        ['read_warehouse', 103],
        ['read_warehouse', 101],
        ...(transient
          ? [
              ['read_warehouse', 103],
              ['read_warehouse', 101],
            ]
          : []),
      ],
    );
    assert.deepEqual(
      requests.map((r) => r.stage),
      ['verifier'],
    );
  });

test('successive targeted recalls retain both groups from the same historical turn for final review', async () => {
  const fixture = createSalesFixture();
  const original = (await fixture.service.openTools(trusted, signal())).run!;
  await original.execute('search_warehouses', '{"limit":5}', signal());
  const receipt = original.delivery()!;
  receipt.displayedRecords = [
    { kind: 'warehouse', id: 103, position: 2, group: 'group-1' },
    { kind: 'warehouse', id: 101, position: 2, group: 'group-2' },
  ];
  const history: ChatMessage[] = [
    {
      role: 'assistant',
      content: PRIVATE_HISTORY_REPLY,
      protectedReply: { text: 'First list\n2. ID 103\nSecond list\n2. ID 101', receipt },
    },
  ];
  fixture.state.calls.length = 0;
  let step = 0;
  let reviewed = false;
  const model: TextModel = {
    startToolSession() {
      return {
        async next() {
          const group = ['group-1', 'group-2'][step++];
          return {
            ...result('The second option in each list remains available for comparison.'),
            calls: group
              ? [
                  {
                    id: `recall-${group}`,
                    name: RECALL_TOOL,
                    arguments: JSON.stringify({ turn: 1, group, positions: [2] }),
                  },
                ]
              : [],
          };
        },
        accept() {},
      };
    },
    async complete(request) {
      const plan = planningResult(request);
      if (plan) return plan;
      assert.equal(request.stage, 'verifier');
      const input = JSON.parse(request.messages[0]!.content);
      assert.equal(input.recalled.length, 2);
      assert.deepEqual(
        input.recalled.map((recall: any) => [
          recall.turn,
          recall.selection_status,
          ...recall.displayed_selection.map((record: any) => [
            record.id,
            record.position,
            record.group,
          ]),
        ]),
        [
          [1, 'complete', [103, 2, 'group-1']],
          [1, 'complete', [101, 2, 'group-2']],
        ],
      );
      assert.ok(input.recalled.every((recall: any) => recall.previous_reply === undefined));
      reviewed = true;
      return result('{"supported":true,"feedback":"","repair":"none","reason":"none"}');
    },
  };
  const output = await buildSalesGraph(model, (s) => fixture.service.openTools(trusted, s)).invoke(
    { input: 'Compare the second option from each earlier list.', history, audience: 'dm' },
    { recursionLimit: 30 },
  );
  assert.equal(output.approved, true);
  assert.equal(reviewed, true);
  assert.deepEqual(
    fixture.state.calls.map(({ tool, args }) => [tool, args.id]),
    [
      ['read_warehouse', 103],
      ['read_warehouse', 101],
    ],
  );
});

test('review exhaustion reports sanitized reasons without sending rejected claims or blaming query scope', async () => {
  const fixture = createSalesFixture();
  const metrics: unknown[] = [];
  let step = 0;
  const model: TextModel = {
    startToolSession() {
      return {
        async next() {
          return {
            ...result('UNSUPPORTED_DRAFT'),
            calls:
              step++ === 0 ? [{ id: 'read', name: 'read_warehouse', arguments: '{"id":101}' }] : [],
          };
        },
        accept() {},
      };
    },
    async complete(request) {
      return (
        planningResult(request) ??
        result(
          request.stage === 'verifier'
            ? JSON.stringify({
                supported: false,
                repair: 'format',
                reason: 'unsupported_claim',
                feedback: 'PRIVATE_REVIEW_DETAIL',
              })
            : 'UNSUPPORTED_DRAFT',
        )
      );
    },
  };
  const reply = await buildSalesGraph(model, (s) => fixture.service.openTools(trusted, s), {
    onStage: (m) => metrics.push(m),
  }).invoke({ input: 'Explain this option.', history: [], audience: 'dm' }, { recursionLimit: 30 });
  assert.equal(reply.unavailable, true);
  assert.equal(reply.business, undefined);
  assert.match(reply.reply, /retrieved information.*couldn't verify/i);
  assert.doesNotMatch(reply.reply, /UNSUPPORTED_DRAFT|PRIVATE_REVIEW_DETAIL|narrow/i);
  const reviews = (metrics as Array<{ review?: unknown }>).flatMap((m) =>
    m.review ? [m.review] : [],
  );
  assert.deepEqual(
    reviews,
    [1, 2].map(() => ({
      approved: false,
      repair: 'format',
      reason: 'unsupported_claim',
      presentationIssueCount: 0,
    })),
  );
  assert.doesNotMatch(JSON.stringify(metrics), /PRIVATE_REVIEW_DETAIL|UNSUPPORTED_DRAFT/);
});
