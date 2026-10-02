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
