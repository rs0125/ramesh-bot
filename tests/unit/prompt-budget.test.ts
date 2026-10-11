/**
 * Prompt growth guard. Fixing an incident by adding another prompt sentence is how the
 * verifier grew from 1,272 to 4,023 words in nine days. New prompt text must replace
 * existing text or move into a schema or code. Lower these budgets when prompts shrink;
 * never raise them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import * as prompts from '../../src/modules/assistant/sales-prompts.js';

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

// Recorded 2026-10-10 at ramesh-chief-of-staff-v45 (after 3e22cbb); router lowered at v46;
// all roles lowered when the shared evidence policy became core principles (v48).
const COMPOSED: Record<string, number> = {
  ROUTER_PROMPT: 2085,
  PLANNER_PROMPT: 3379,
  WORKER_PROMPT: 5676,
  SALES_VERIFIER_PROMPT: 2833,
  // Core plus every domain section; the per-turn review loads a subset.
  SALES_VERIFIER_FULL_PROMPT: 4782,
  BUSINESS_FORMATTER_PROMPT: 2513,
  EVIDENCE_REPAIR_PROMPT: 1496,
};
const FILES: Record<string, number> = {
  'business-formatter.md': 1693,
  'chief-of-staff.md': 1730,
  'converser.md': 452,
  'evidence-policy.md': 643,
  'evidence-repair.md': 244,
  'formatter.md': 247,
  'legacy-read-converser.md': 247,
  'media-extractor.md': 107,
  'planner.md': 1080,
  'planning-reference.md': 1224,
  'requirement-interpretation.md': 432,
  'router.md': 1442,
  'verifier-analytics.md': 83,
  'verifier-crm.md': 353,
  'verifier-personal.md': 168,
  'verifier-recall.md': 238,
  'verifier-supply.md': 238,
  'verifier-writes.md': 869,
  'verifier.md': 1758,
  'worker.md': 1470,
};

test('composed role prompts do not grow', () => {
  for (const [name, budget] of Object.entries(COMPOSED)) {
    const text = (prompts as unknown as Record<string, string | undefined>)[name] ?? '';
    assert.ok(text, name);
    assert.ok(
      words(text) <= budget,
      `${name} has ${words(text)} words; budget ${budget}. Replace text instead of adding it.`,
    );
  }
});

test('prompt files do not grow, and a new prompt file needs an explicit budget', () => {
  const files = readdirSync('src/prompts').filter((file) => file.endsWith('.md'));
  assert.deepEqual(files.sort(), Object.keys(FILES).sort());
  for (const file of files) {
    const count = words(readFileSync(`src/prompts/${file}`, 'utf8'));
    assert.ok(
      count <= FILES[file]!,
      `${file} has ${count} words; budget ${FILES[file]}. Replace text instead of adding it.`,
    );
  }
});
