/** No model/network calls: exercise the presentation boundary with hostile metadata and payloads. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRESENTATION_META_KEY,
  ToolPresentationRegistry,
  type PresentationAdapter,
} from '../../src/modules/presentation/tool-presentation.js';
import { personalListAdapter } from '../../src/modules/scheduling/personal-list-presentation.js';
import { renderList } from '../../src/modules/scheduling/personal-presentation.js';

const task = {
  id: 'task-b',
  kind: 'task' as const,
  version: 3,
  text: 'Call the client',
  state: 'open',
  createdAt: '2026-10-09T04:00:00.000Z',
  updatedAt: '2026-10-09T04:00:00.000Z',
};
const result = {
  ok: true,
  kind: 'task',
  records: [task],
  selectionId: 'selection',
  nextCursor: 'cursor',
};
const input = {
  owner: 'personal',
  tool: {
    name: 'personal_list',
    _meta: { [PRESENTATION_META_KEY]: { adapter: 'personal-list-v1', renderer: 'list-v1' } },
  },
  argumentsValue: { kind: 'task' },
  result,
  maxCharacters: 5000,
};
const registry = new ToolPresentationRegistry([personalListAdapter]);

test('registered presentation preserves exact normal wording, record identity, order and paging', () => {
  const page = {
    ...result,
    records: [task, { ...task, id: 'task-a', version: 9, text: 'Review offer' }],
  };
  const rendered = registry.present({ ...input, result: page })!;
  assert.equal(rendered.text, renderList('task', page));
  assert.match(
    rendered.text,
    /1\. Call the client \[open\]\n2\. Review offer \[open\]\nMore entries are available\.$/,
  );
  assert.deepEqual(
    rendered.document.items.map(({ id, version }) => ({ id, version })),
    [
      { id: 'task-b', version: 3 },
      { id: 'task-a', version: 9 },
    ],
  );
  assert.deepEqual(rendered.document.page, { selectionId: 'selection', nextCursor: 'cursor' });
  for (const nextCursor of [null, 'cursor']) {
    const empty = { ...result, records: [], nextCursor };
    assert.equal(registry.present({ ...input, result: empty })?.text, renderList('task', empty));
  }
});

test('unregistered metadata, borrowed adapters and oversized output cannot opt a tool in', () => {
  for (const change of [
    { owner: 'remote-crm' },
    { tool: { ...input.tool, name: 'read_crm_lead' } },
    { tool: { name: 'personal_list' } },
    ...[
      null,
      {},
      { adapter: 'unknown', renderer: 'list-v1' },
      { adapter: 'personal-list-v1', renderer: 'unknown' },
      { adapter: 'personal-list-v1', renderer: 'list-v1', skipReview: true },
      { adapter: 'personal-list-v1', renderer: 'list-v1', template: '${secret}' },
    ].map((meta) => ({ tool: { ...input.tool, _meta: { [PRESENTATION_META_KEY]: meta } } })),
    { maxCharacters: 4 },
    { maxCharacters: NaN },
  ])
    assert.equal(registry.present({ ...input, ...change }), undefined);
});

test('failures, partial data, mixed record kinds and invalid schedules never become successful lists', () => {
  const badResults = [
    { ok: false, records: [] },
    { ...result, partial: true },
    { ...result, nextCursor: undefined },
    { ...result, selectionId: '' },
    { ...result, records: [task, task] },
    { ...result, records: [{ ...task, kind: 'reminder' }] },
    { ...result, records: [{ ...task, version: 0 }] },
    { ...result, records: [{ ...task, state: 'done' }] },
    { ...result, records: [{ ...task, createdAt: 'yesterday' }] },
    {
      ...result,
      records: [
        {
          ...task,
          deadline: { precision: 'date', localDate: '2026-02-30', timezone: 'Asia/Kolkata' },
        },
      ],
    },
    {
      ...result,
      records: [{ ...task, schedule: { dueAt: task.createdAt, timezone: 'Asia/Kolkata' } }],
    },
  ];
  for (const result of badResults) assert.equal(registry.present({ ...input, result }), undefined);
  for (const argumentsValue of [
    { kind: 'reminder' },
    { kind: 'task', state: 'scheduled' },
    { kind: 'task', employeeId: 8 },
  ])
    assert.equal(registry.present({ ...input, argumentsValue }), undefined);
  const reminder = {
    ...task,
    kind: 'reminder',
    state: 'scheduled',
    schedule: {
      dueAt: task.createdAt,
      timezone: 'Asia/Kolkata',
      recurrence: { frequency: 'weekly' },
    },
  };
  assert.equal(
    registry.present({
      ...input,
      argumentsValue: { kind: 'reminder' },
      result: { ...result, kind: 'reminder', records: [reminder] },
    }),
    undefined,
  );
});

test('a second domain reuses list layout through an explicit adapter without granting completion', () => {
  const adapter: PresentationAdapter = {
    id: 'fixture-counts-v1',
    owner: 'fixture',
    tool: 'read_counts',
    renderer: 'list-v1',
    adapt(_args, output) {
      if (output !== 3) return undefined;
      return {
        kind: 'list',
        heading: 'Counts:',
        items: [{ id: 'north', text: 'North: 3' }],
        emptyText: 'No counts.',
        page: { nextCursor: null },
      };
    },
  };
  const extended = new ToolPresentationRegistry([personalListAdapter, adapter]);
  const rendered = extended.present({
    ...input,
    owner: 'fixture',
    result: 3,
    tool: {
      name: 'read_counts',
      _meta: { [PRESENTATION_META_KEY]: { adapter: adapter.id, renderer: adapter.renderer } },
    },
  })!;
  assert.equal(rendered.text, 'Counts:\n1. North: 3');
  assert.equal('approved' in rendered, false);
  assert.equal('delivery' in rendered, false);
  assert.throws(() => new ToolPresentationRegistry([adapter, adapter]), /Duplicate/);
  assert.throws(
    () => new ToolPresentationRegistry([{ ...adapter, renderer: 'missing' }]),
    /Unregistered/,
  );
});
