import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { assertEvalRun, evalModel, DEFAULT_EVAL_MODEL } from '../../evals/lib/run-policy.js';

test('routine evals select Luna independently of the production model', () => {
  assert.equal(evalModel(undefined, { OPENAI_MODEL: 'gpt-6.1-sol' }), 'gpt-6-luna');
  assert.equal(evalModel('gpt-6.1-sol', {}), 'gpt-6.1-sol');
  assert.equal(evalModel(undefined, { EVAL_MODEL: 'gpt-6-luna' }), DEFAULT_EVAL_MODEL);
});

test('Sol requires an explicit run approval for either agent or grader, including snapshots', () => {
  for (const models of [
    ['gpt-6.1-sol', DEFAULT_EVAL_MODEL],
    [DEFAULT_EVAL_MODEL, 'gpt-6.1-sol'],
    ['gpt-6-sol-2026-01-01'],
  ]) {
    assert.throws(() => assertEvalRun(models, 1, {}), /SOL_EVAL_APPROVAL_REQUIRED/);
    assert.throws(
      () => assertEvalRun(models, 1, { 'sol-approval': '  ' }),
      /SOL_EVAL_APPROVAL_REQUIRED/,
    );
    assert.equal(
      assertEvalRun(models, 1, { 'sol-approval': 'fixture-approval' }).solApproval,
      'fixture-approval',
    );
  }
});

test('a trial allowance prevents accidental broad runs even on Luna or an approved Sol model', () => {
  assert.equal(assertEvalRun([DEFAULT_EVAL_MODEL], 3, {}).maxTrials, 3);
  assert.throws(() => assertEvalRun([DEFAULT_EVAL_MODEL], 85, {}), /ALLOWANCE_EXCEEDED/);
  assert.throws(
    () => assertEvalRun(['gpt-6.1-sol'], 32, { 'sol-approval': 'fixture-approval' }),
    /ALLOWANCE_EXCEEDED/,
  );
  assert.equal(assertEvalRun([DEFAULT_EVAL_MODEL], 4, { 'max-trials': '4' }).plannedTrials, 4);
  for (const value of ['0', '-1', 'NaN', '1.5'])
    assert.throws(() => assertEvalRun([DEFAULT_EVAL_MODEL], 1, { 'max-trials': value }), /INVALID/);
});

test('actual conversation CLI rejects unapproved agents, graders and unbounded suites before loading a key', () => {
  for (const [args, reason] of [
    [['--case', 'deal-cards', '--model', 'gpt-6.1-sol'], 'SOL_EVAL_APPROVAL_REQUIRED'],
    [['--case', 'deal-cards', '--judge-model', 'gpt-6.1-sol'], 'SOL_EVAL_APPROVAL_REQUIRED'],
    [[], 'EVAL_TRIAL_ALLOWANCE_EXCEEDED'],
  ] as const) {
    const env = { ...process.env, OPENAI_API_KEY: '', EVAL_MODEL: DEFAULT_EVAL_MODEL };
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'evals/conversation-run.ts', ...args],
      {
        cwd: new URL('../../', import.meta.url),
        env,
        encoding: 'utf8',
        timeout: 15000,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(reason), result.stderr);
    assert.ok(!result.stderr.includes('OPENAI_API_KEY is required'));
  }
});
