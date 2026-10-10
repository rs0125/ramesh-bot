/** Deterministic WhatsApp layout checks that trigger one formatting pass. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chatLayoutIssues } from '../../src/modules/assistant/style.js';

test('internal API source paths are flagged; public URLs and plain text are not', () => {
  const flagged = (text: string) => chatLayoutIssues(text).some((issue) => issue.includes('/api/'));
  assert.ok(flagged('Source: *Warehouse visit checklist*, `/api/v1/wiki/pages/warehouse-visits`.'));
  assert.ok(flagged('See /api/v1/crm/opportunities for details.'));
  assert.ok(!flagged('Docs: https://example.com/api/v1/reference'));
  assert.ok(!flagged('Source: *Warehouse visit checklist*, updated 2 Oct 2026.'));
});
