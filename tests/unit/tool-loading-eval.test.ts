import test from 'node:test';
import assert from 'node:assert/strict';
import { toolLoadingChecks } from '../../evals/lib/tool-loading-checks.js';
import { createSalesFixture, salesEvidence } from '../../scripts/lib/sales-fixture.js';

test('loading evaluation accepts equivalent CRM sources and rejects unsupported answers', () => {
  const now = Date.parse('2026-10-05T09:00:00Z');
  const fixture = createSalesFixture(() => now);
  for (const tool of ['crm_summary', 'crm_briefing']) {
    const args =
      tool === 'crm_summary' ? { group_by: 'stage', active_only: 'true', view: 'accessible' } : {};
    const record = {
      case: 'deferred-crm-summary',
      mode: 'deferred' as const,
      trace: { outcome: 'completed' },
      reply: '17 deals\nRFQ Received: 12\nFollow-up: 5',
      calls: [{ tool, args }],
      nativeSearchCalls: 1,
      evidence: [{ tool, result: salesEvidence(tool, args, now, fixture.state) }],
    };
    assert.ok(Object.values(toolLoadingChecks(record)).every(Boolean));
    assert.equal(toolLoadingChecks({ ...record, evidence: [] }).supportedAnswer, false);
    assert.equal(toolLoadingChecks({ ...record, nativeSearchCalls: 0 }).loadingMode, false);
    assert.equal(toolLoadingChecks({ ...record, reply: '42 deals' }).correctAnswer, false);
    assert.equal(
      toolLoadingChecks({
        ...record,
        evidence: [{ tool, result: { status: 200, data: { total: 17 } } }],
      }).supportedAnswer,
      false,
    );
  }
});
