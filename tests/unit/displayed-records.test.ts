import test from 'node:test';
import assert from 'node:assert/strict';
import {
  displayedWarehouseRecords,
  displayedWarehousePositions,
} from '../../src/modules/assistant/displayed-records.js';
import type { ToolEvidence } from '../../src/modules/assistant/tool-evidence.js';
import { salesEvidence } from '../../scripts/lib/sales-fixture.js';
import { finishReply } from '../../src/modules/assistant/style.js';

const search: ToolEvidence = {
  id: 'search',
  tool: 'search_warehouses',
  arguments: { limit: 5 },
  result: salesEvidence('search_warehouses', { limit: 5 }),
};
const crm: ToolEvidence = {
  id: 'crm',
  tool: 'search_crm_leads',
  arguments: {},
  result: {
    ...search.result,
    data: {
      items: [
        { id: '00000000-0000-4000-8000-000000000101', name: 'First client' },
        { id: '00000000-0000-4000-8000-000000000102', name: 'Second client' },
      ],
    },
  },
};

test('separate ranked groups retain local positions and stable structural group identities', () => {
  assert.deepEqual(
    displayedWarehouseRecords(
      'First brief\n1. ID 101\n2. ID 102\nSecond brief\n1. ID 103\n2. ID 104',
      [search],
    ),
    [
      { kind: 'warehouse', id: 101, position: 1, group: 'group-1' },
      { kind: 'warehouse', id: 102, position: 2, group: 'group-1' },
      { kind: 'warehouse', id: 103, position: 1, group: 'group-2' },
      { kind: 'warehouse', id: 104, position: 2, group: 'group-2' },
    ],
  );
});

test('source-backed CRM headings bind separate lists without trusting heading text as facts', () => {
  const records = displayedWarehouseRecords(
    '**First client**\n- ID 101\n- ID 103\n**Second client**\n- ID 103\n- ID 104',
    [search, crm],
  );
  assert.deepEqual(
    records.map(({ id, position, group, subject }) => [id, position, group, subject?.id]),
    [
      [101, 1, 'group-1', '00000000-0000-4000-8000-000000000101'],
      [103, 2, 'group-1', '00000000-0000-4000-8000-000000000101'],
      [103, 1, 'group-2', '00000000-0000-4000-8000-000000000102'],
      [104, 2, 'group-2', '00000000-0000-4000-8000-000000000102'],
    ],
  );
  assert.ok(
    displayedWarehouseRecords('**Unverified client**\n1. ID 101', [search, crm]).every(
      (record) => !record.subject,
    ),
  );
  for (const reply of [
    '1. ID 104\n**First client**\n1. ID 101\n2. ID 103',
    '**First client**\n1. ID 101\n2. ID 103\nUnknown client\n1. ID 104',
    '**First client**\n- ID 101\n**Unknown client**\n- ID 104',
  ]) {
    const ambiguous = displayedWarehouseRecords(reply, [search, crm]);
    assert.ok(ambiguous.some((record) => record.id === 104));
    assert.ok(ambiguous.some((record) => record.id === 101));
    assert.ok(ambiguous.every((record) => !record.subject));
  }
});

test('unknown client headings cannot inherit the preceding CRM subject after WhatsApp formatting', () => {
  for (const heading of [
    '*Unknown client*',
    '**Unknown client**',
    '_Unknown client_',
    '__Unknown client__',
    '## Unknown client',
    'Unknown client:',
    'Unknown client',
    'Unknown client\nLocation: Hyderabad',
    '- *Unknown client*',
    '2. *Unknown client*',
    '*Second client - revised requirement*',
  ]) {
    const draft = `**First client**\n- ID 101\n${heading}\n\n- ID 104`;
    for (const reply of [draft, finishReply(draft)]) {
      const records = displayedWarehouseRecords(reply, [search, crm]);
      assert.deepEqual(
        records.map(({ id }) => id),
        [101, 104],
        heading,
      );
      assert.ok(
        records.every((record) => !record.subject),
        heading,
      );
    }
  }
});

test('recognized client groups preserve subjects and repeated warehouses after WhatsApp formatting', () => {
  const reply = finishReply(
    '**First client**\n- ID 101\n- ID 103\n**Second client**\n- ID 103\n- ID 104',
  );
  assert.deepEqual(
    displayedWarehouseRecords(reply, [search, crm]).map(({ id, position, group, subject }) => [
      id,
      position,
      group,
      subject?.id,
    ]),
    [
      [101, 1, 'group-1', '00000000-0000-4000-8000-000000000101'],
      [103, 2, 'group-1', '00000000-0000-4000-8000-000000000101'],
      [103, 1, 'group-2', '00000000-0000-4000-8000-000000000102'],
      [104, 2, 'group-2', '00000000-0000-4000-8000-000000000102'],
    ],
  );
});

test('property fields and Pro/Con content do not become unrelated client headings', () => {
  for (const field of [
    '*Pro: Recorded loading area*',
    '**Con: Availability unconfirmed**',
    '*Pro:* Recorded loading area',
    '- *Con:* Availability unconfirmed',
    '*Pro:*\nRecorded loading area.',
    '*Pro:*\nRecorded loading area',
    'Location:\nHoskote',
    '_Con:_\nAvailability to confirm',
    '## Location: Hoskote',
    '*Location: Hoskote*',
    '**Area: 26,000 sq ft**',
    'Rent: Unit to confirm',
    '*Fire NOC: Recorded available*',
    'Size:\n26,000 sq ft',
  ]) {
    const reply = finishReply(`**First client**\n- ID 101\n${field}\n- ID 103`);
    const records = displayedWarehouseRecords(reply, [search, crm]);
    assert.deepEqual(
      records.map(({ id }) => id),
      [101, 103],
      field,
    );
    assert.ok(
      records.every((record) => record.subject?.id === '00000000-0000-4000-8000-000000000101'),
      field,
    );
  }
});

test('capture keeps displayed ranked subset order, deduplicates and requires entity corroboration', () => {
  const result = displayedWarehouseRecords(
    'IDs 101, 102\n1. *ID 105*\n2. ID:103\n3. ID 101.\nAgain ID105 and ID 105.\nID 999\nArea26000; ID 102.5; ID 102-fake; ID 102e5',
    [search],
  );
  assert.deepEqual(result, [
    { kind: 'warehouse', id: 105, position: 1 },
    { kind: 'warehouse', id: 103, position: 2 },
    { kind: 'warehouse', id: 101, position: 3 },
  ]);
});

test('arguments and arbitrary nested text do not authorize displayed IDs; real assessment candidates do', () => {
  const assessment: ToolEvidence = {
    id: 'assessment',
    tool: 'assess_shortlist',
    arguments: { warehouse_ids: [999] },
    result: { ...search.result, data: { candidates: [{ id: 401 }], notes: 'ID 777' } },
  };
  assert.deepEqual(
    displayedWarehouseRecords('ID999; ID 999; ID401; ID:401; ID 777', [assessment]),
    [{ kind: 'warehouse', id: 401, position: 2 }],
  );
  const fakeRead: ToolEvidence = {
    id: 'read',
    tool: 'read_warehouse',
    arguments: { id: 888 },
    result: { ...search.result, data: { id: 402, description: 'ID 888' } },
  };
  assert.deepEqual(displayedWarehouseRecords('ID 888; ID402; ID:402', [fakeRead]), [
    { kind: 'warehouse', id: 402, position: 2 },
  ]);
});

test('numbered warehouse headings take precedence over introductory or excluded mentions', () => {
  assert.deepEqual(
    displayedWarehouseRecords(
      'Exclude ID 101. Start with ID105.\n1. *ID 999*\n2. **ID: 105**\n4. ID 103\nFootnote ID 102',
      [search],
    ),
    [
      { kind: 'warehouse', id: 105, position: 2 },
      { kind: 'warehouse', id: 103, position: 4 },
    ],
  );
});

test('legacy positions retain gaps when current evidence no longer contains an earlier ID', () => {
  assert.deepEqual(displayedWarehousePositions('1. ID 999\n2. ID 103\n3. ID 105', [search]), [
    { kind: 'warehouse', id: 103, position: 2 },
    { kind: 'warehouse', id: 105, position: 3 },
  ]);
});
