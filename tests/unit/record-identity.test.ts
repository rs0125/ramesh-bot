import test from 'node:test';
import assert from 'node:assert/strict';
import { salesEvidence } from '../../scripts/lib/sales-fixture.js';
import { recordIdentity } from '../../src/modules/assistant/record-identity.js';

test('record membership ignores field updates, distinguishes order and stores no record IDs', () => {
  const evidence = salesEvidence('search_crm_leads', { limit: 2 });
  const first = recordIdentity('search_crm_leads', evidence)!;
  const items = evidence.data.items as any[];
  assert.ok(!JSON.stringify(first).includes(items[0].id));
  items[0].source_updated_at = '2026-10-01T08:30:00Z';
  items[0].name = 'A renamed permitted company';
  assert.deepEqual(recordIdentity('search_crm_leads', evidence), first);
  items.reverse();
  const reordered = recordIdentity('search_crm_leads', evidence)!;
  assert.equal(reordered.membership, first.membership);
  assert.notEqual(reordered.order, first.order);
  items[0].id = 'replacement-record';
  assert.notEqual(recordIdentity('search_crm_leads', evidence)!.membership, first.membership);
});

test('entity reads preserve typed IDs; aggregates and malformed identities stay unknown', () => {
  const warehouse = salesEvidence('read_warehouse', { id: 101 });
  const numeric = recordIdentity('read_warehouse', warehouse)!;
  warehouse.data.id = '101';
  assert.notEqual(recordIdentity('read_warehouse', warehouse)!.membership, numeric.membership);
  warehouse.data.id = null;
  assert.equal(recordIdentity('read_warehouse', warehouse), undefined);
  const summary = salesEvidence('warehouse_summary', {});
  assert.equal(recordIdentity('warehouse_summary', summary), undefined);
  const empty = salesEvidence('search_crm_leads', { city: 'NoSuchCity' });
  assert.equal(recordIdentity('search_crm_leads', empty)!.count, 0);
  empty.data.items = [{ name: 'Missing ID' }];
  assert.equal(recordIdentity('search_crm_leads', empty), undefined);
});
