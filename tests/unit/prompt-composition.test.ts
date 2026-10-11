import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadPrompt } from '../../src/modules/assistant/prompt-files.js';
import {
  BUSINESS_FORMATTER_PROMPT,
  EVIDENCE_REPAIR_PROMPT,
  PLANNER_PROMPT,
  ROUTER_PROMPT,
  SALES_MANAGER_PROMPT,
  SALES_VERIFIER_PROMPT,
  SALES_VERIFIER_FULL_PROMPT,
  VERIFIER_SECTIONS,
  verifierInstructions,
  WORKER_PROMPT,
} from '../../src/modules/assistant/sales-prompts.js';

const roles = {
  planner: PLANNER_PROMPT,
  worker: WORKER_PROMPT,
  manager: SALES_MANAGER_PROMPT,
  formatter: BUSINESS_FORMATTER_PROMPT,
  evidenceRepair: EVIDENCE_REPAIR_PROMPT,
  verifier: SALES_VERIFIER_PROMPT,
  router: ROUTER_PROMPT,
};

test('every assembled role receives the same evidence contract exactly once', () => {
  const policy = loadPrompt('evidence-policy');
  for (const [role, prompt] of Object.entries(roles)) {
    assert.equal(prompt.split(policy).length - 1, 1, `${role}: missing or duplicated contract`);
    assert.equal(
      prompt.split('# Evidence and action contract').length - 1,
      1,
      `${role}: another policy version is still composed`,
    );
  }
  for (const prompt of [PLANNER_PROMPT, WORKER_PROMPT, SALES_MANAGER_PROMPT]) {
    assert.equal(prompt.split('## CRM brief to warehouse shortlist').length - 1, 1);
  }
  for (const prompt of [
    PLANNER_PROMPT,
    WORKER_PROMPT,
    SALES_MANAGER_PROMPT,
    SALES_VERIFIER_PROMPT,
    EVIDENCE_REPAIR_PROMPT,
  ]) {
    assert.equal(prompt.split(loadPrompt('requirement-interpretation')).length - 1, 1);
  }
  assert.ok(WORKER_PROMPT.includes(loadPrompt('chief-of-staff')));
  assert.ok(WORKER_PROMPT.includes(loadPrompt('planning-reference')));
});

test('live-role composition and synthetic source guidance do not restore traced conflicts', () => {
  const fixtureGuidance = readFileSync(
    new URL('../fixtures/context-guidance.md', import.meta.url),
    'utf8',
  );
  const retiredDirectives = [
    'For every warehouse with verification_required or uncertain field_evidence, explicitly say its data needs verification and name the approximate, ranged or unknown fields.',
    'An identical successful query returns its registered in-run evidence.',
    "Before finalizing each deal's shortlist, use an advertised assess_shortlist",
    'The formatter will shorten the wording',
    'Aim for 1000-1600 characters per five-option deal',
    'Return only the requested JSON: supported, feedback, repair',
  ];
  for (const [name, prompt] of Object.entries({ ...roles, fixtureGuidance })) {
    for (const directive of retiredDirectives) {
      assert.ok(
        !prompt.includes(directive),
        `${name} restores conflicting directive: ${directive}`,
      );
    }
  }
});

test('verifier domain sections compose onto the core only when requested', () => {
  const policy = loadPrompt('evidence-policy');
  assert.equal(verifierInstructions(new Set()), SALES_VERIFIER_PROMPT);
  for (const section of VERIFIER_SECTIONS) {
    const text = loadPrompt(`verifier-${section}`);
    const only = verifierInstructions(new Set([section]));
    // A section sits after the opening, ahead of the general rules and the shared policy.
    assert.equal(only.replace(`${text}\n\n`, ''), SALES_VERIFIER_PROMPT, section);
    assert.ok(only.indexOf(text) < only.indexOf('## Block material problems'), section);
    for (const other of VERIFIER_SECTIONS.filter((name) => name !== section))
      assert.ok(!only.includes(loadPrompt(`verifier-${other}`)), `${section} leaks ${other}`);
  }
  assert.equal(SALES_VERIFIER_FULL_PROMPT.split(policy).length - 1, 1);
  for (const section of VERIFIER_SECTIONS)
    assert.equal(SALES_VERIFIER_FULL_PROMPT.split(loadPrompt(`verifier-${section}`)).length - 1, 1);
});
