import test from 'node:test';
import assert from 'node:assert/strict';
import {
  presentSource,
  presentOrientation,
  runEvidenceId,
} from '../../src/modules/assistant/evidence-presentation.js';
import type { ContextEvidence } from '../../src/modules/context-engine/context.types.js';

test('replay projection removes only named retrieval clocks, retaining business and access facts', () => {
  const raw: ContextEvidence = {
    status: 200,
    source_path: '/api/v1/crm/opportunities',
    meta: {
      requestId: 'request-one',
      generatedAt: '2026-10-03T10:00:00Z',
      permission: 'restricted',
    },
    data: {
      access_scope: 'assigned',
      query_context: { as_of: 'retrieval-clock', local_date: '2026-10-03' },
      read_consistency: { transaction_started_at: 'transaction-clock', lead_fields: 'same_row' },
      source_status: { opportunities: { status: 'ok', last_run_at: 'source-sync-clock' } },
      items: [
        {
          id: 'fictional',
          source_created_at: 'created',
          source_updated_at: 'updated',
          as_of: 'business-field',
          requestId: 'business-reference',
          last_polled_at: 'poll',
        },
      ],
    },
  };
  const shown = presentSource(raw, 'search_crm_leads');
  assert.deepEqual(shown.data.items, raw.data.items);
  assert.deepEqual(shown.data.source_status, raw.data.source_status);
  assert.equal(shown.data.access_scope, 'assigned');
  assert.deepEqual(shown.meta, { permission: 'restricted' });
  assert.deepEqual(shown.data.query_context, { local_date: '2026-10-03' });
  assert.deepEqual(shown.data.read_consistency, { lead_fields: 'same_row' });
  assert.equal(raw.meta.requestId, 'request-one');
  assert.deepEqual(
    presentSource(raw, 'future_read_tool').data,
    raw.data,
    'unknown tools retain all source-specific fields even if this reduces replay reuse',
  );
  assert.deepEqual(
    presentOrientation({
      server_clock: { as_of: 'retrieved', local_date: 'day' },
      scopes: ['knowledge:read'],
    }),
    { server_clock: { local_date: 'day' }, scopes: ['knowledge:read'] },
  );
  assert.equal(runEvidenceId('job-one', 1), runEvidenceId('job-one', 1));
  assert.notEqual(runEvidenceId('job-one', 1), runEvidenceId('job-two', 1));
  assert.notEqual(runEvidenceId('job-one', 1), runEvidenceId('job-one', 2));
});

test('a returned list says whether it is complete, so a single item is not hedged as partial', () => {
  const list = (nextCursor: string | null, items: unknown[]): ContextEvidence => ({
    status: 200,
    source_path: '/api/v1/crm/opportunities/fictional/context',
    meta: { requestId: 'request', generatedAt: '2026-10-03T10:00:00Z' },
    data: { section: 'notes', items, nextCursor },
  });
  const done = presentSource(list(null, [{ id: 'note-1' }]), 'read_crm_lead_context');
  assert.deepEqual((done.data as Record<string, unknown>).list_status, {
    all_results_for_this_query: true,
    item_count: 1,
  });
  const more = presentSource(list('cursor-2', [{ id: 'a' }, { id: 'b' }]), 'search_crm_leads');
  assert.deepEqual((more.data as Record<string, unknown>).list_status, {
    all_results_for_this_query: false,
    item_count: 2,
  });
  // An empty result is not labelled complete: it may come from a wrong filter.
  const empty = presentSource(list(null, []), 'search_warehouses');
  assert.equal((empty.data as Record<string, unknown>).list_status, undefined);
});
