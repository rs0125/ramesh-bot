import test from 'node:test';
import assert from 'node:assert/strict';
import {
  displayedWarehouseRecords,
  displayedWarehousePositions,
} from '../../src/modules/assistant/displayed-records.js';
import type { ToolEvidence } from '../../src/modules/assistant/tool-evidence.js';
import { salesEvidence } from '../../scripts/lib/sales-fixture.js';

const search: ToolEvidence = {
  id: 'search',
  tool: 'search_warehouses',
  arguments: { limit: 5 },
  result: salesEvidence('search_warehouses', { limit: 5 }),
};

test('separate ranked groups do not invent one global historical position', () => {
  assert.deepEqual(
    displayedWarehouseRecords(
      'First brief\n1. ID 101\n2. ID 102\nSecond brief\n1. ID 103\n2. ID 104',
      [search],
    ),
    [],
  );
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
