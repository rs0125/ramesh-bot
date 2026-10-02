import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  assertRemoteEvaluationBudget,
  createEvalUsageMeter,
  evalAllowanceMicros,
  settleEvalWorkers,
  splitEvalAllowance,
} from '../../evals/lib/usage-budget.js';

// Deliberately fictional rates and ceilings; these are accounting fixtures, not provider prices.
const prices = JSON.stringify({
  version: 'fixture-v1',
  models: {
    'fixture-agent': {
      inputMicrosPerMillion: 1_000_000,
      outputMicrosPerMillion: 1_000_000,
      maxInputTokens: 3,
      maxOutputTokens: 2,
    },
    'fixture-grader': {
      inputMicrosPerMillion: 1_000_000,
      outputMicrosPerMillion: 1_000_000,
      maxInputTokens: 3,
      maxOutputTokens: 2,
    },
    'fixture-audio': {
      inputMicrosPerMillion: 1_000_000,
      outputMicrosPerMillion: 1_000_000,
      audioInputMicrosPerMillion: 1_000_000,
      maxInputTokens: 3,
      maxOutputTokens: 2,
    },
  },
});
const request = (model: string) => ({
  method: 'POST',
  body: JSON.stringify({
    model,
    input: 'PRIVATE_FIXTURE_TEXT',
    max_output_tokens: 2,
    service_tier: 'default',
  }),
});

test('evaluation USD allowances are explicit, precise and independent of production budgets', () => {
  assert.equal(evalAllowanceMicros({ 'max-usd': '1.000001' }, {}), 1_000_001);
  assert.equal(evalAllowanceMicros({}, { EVAL_MAX_USD: '0.000001' }), 1);
  assert.equal(evalAllowanceMicros({ 'max-usd': '2' }, { EVAL_MAX_USD: '9' }), 2_000_000);
  assert.throws(() => evalAllowanceMicros({}, { USAGE_ACCOUNT_DAY_MAX_USD: '100' }), /REQUIRED/);
  for (const value of ['0', '-1', '1e3', 'Infinity', 'NaN', '1.0000001', '.5', ' 1', '9007199255'])
    assert.throws(() => evalAllowanceMicros({ 'max-usd': value }, {}), /INVALID/);
});

test('comparison children cannot each receive a fresh copy of the experiment allowance', () => {
  const total = 1_000_000;
  const each = splitEvalAllowance(total, 3);
  assert.equal(each, '0.333333');
  assert.ok(evalAllowanceMicros({ 'max-usd': each }, {}) * 3 <= total);
  assert.throws(() => splitEvalAllowance(1, 3), /TOO_SMALL/);
  assert.throws(() => splitEvalAllowance(10, 0), /INVALID/);
});

test('missing model rates fail before a request and production observe mode cannot disable enforcement', async () => {
  await assert.rejects(
    createEvalUsageMeter({ 'max-usd': '1' }, {}, ['fixture-agent']),
    /PRICES_REQUIRED/,
  );
  await assert.rejects(
    createEvalUsageMeter({ 'max-usd': '1' }, { EVAL_USAGE_PRICES_JSON: prices }, ['missing-model']),
    /MODEL_PRICE_REQUIRED/,
  );
});

test('agent, grader and audio share a campaign while preserving run attribution and private metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ramesh-eval-budget-'));
  try {
    const meter = await createEvalUsageMeter(
      { 'max-usd': '0.000015', campaignId: 'fixture-campaign', directory },
      {
        EVAL_USAGE_PRICES_JSON: prices,
        USAGE_MODE: 'off',
        USAGE_ACCOUNT_DAY_MAX_USD: '100',
      },
      ['fixture-agent', 'fixture-grader', 'fixture-audio'],
    );
    let calls = 0;
    const fetcher: typeof fetch = async (url) => {
      calls++;
      return Response.json({
        id: `fixture_${calls}`,
        usage: {
          input_tokens: 3,
          output_tokens: 2,
          ...(String(url).includes('/audio/') ? { input_token_details: { audio_tokens: 3 } } : {}),
        },
      });
    };
    const agent = meter.wrapFetch(fetcher),
      grader = meter.wrapFetch(fetcher),
      audio = meter.wrapFetch(fetcher);
    await meter.run({ runId: 'turn-one' }, () =>
      agent('https://api.openai.com/v1/responses', request('fixture-agent')),
    );
    await meter.run({ runId: 'turn-two' }, () =>
      grader('https://api.openai.com/v1/responses', request('fixture-grader')),
    );
    const body = new FormData();
    body.set('model', 'fixture-audio');
    body.set('file', new Blob(['PRIVATE_MEDIA_BYTES']), 'recording.ogg');
    await audio('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', body });
    await assert.rejects(
      agent('https://api.openai.com/v1/responses', request('fixture-agent')),
      /BUDGET_EXCEEDED/,
    );
    assert.equal(calls, 3);
    const summary = await meter.report();
    assert.equal(summary.requestCount, 3);
    assert.equal(summary.knownActualMicros, 15);
    assert.equal(summary.costComplete, true);
    const log = await readFile(join(directory, 'usage-ledger.ndjson'), 'utf8');
    assert.ok(
      log.includes('turn-one') && log.includes('turn-two') && log.includes('fixture-campaign'),
    );
    assert.ok(!log.includes('PRIVATE_FIXTURE_TEXT') && !log.includes('PRIVATE_MEDIA_BYTES'));
    assert.equal((await stat(join(directory, 'usage-ledger.ndjson'))).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('missing provider usage holds the reservation and cannot silently replenish the allowance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ramesh-eval-unknown-'));
  try {
    const meter = await createEvalUsageMeter(
      { 'max-usd': '0.000005', directory },
      { EVAL_USAGE_PRICES_JSON: prices },
      ['fixture-agent'],
    );
    let calls = 0;
    const fetcher = meter.wrapFetch(async () => {
      calls++;
      return Response.json({ error: 'fixture' }, { status: 500 });
    });
    await fetcher('https://api.openai.com/v1/responses', request('fixture-agent'));
    await assert.rejects(
      fetcher('https://api.openai.com/v1/responses', request('fixture-agent')),
      /BUDGET_EXCEEDED/,
    );
    assert.equal(calls, 1);
    const report = await meter.report();
    assert.equal(report.unknownRequests, 1);
    assert.equal(report.knownActualMicros, 0);
    assert.equal(report.heldMicros, 5);
    assert.equal(report.costComplete, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('private HTTP evaluations fail closed because a local meter cannot cap a remote graph', () => {
  assert.throws(assertRemoteEvaluationBudget, /REMOTE_EVAL_BUDGET_UNSUPPORTED/);
});

test('retained campaign artifacts cannot be overwritten to reset a spent allowance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ramesh-eval-reuse-'));
  try {
    const options = { 'max-usd': '0.000005', campaignId: 'retained-campaign', directory };
    const env = { EVAL_USAGE_PRICES_JSON: prices };
    const meter = await createEvalUsageMeter(options, env, ['fixture-agent']);
    const fetcher = meter.wrapFetch(async () =>
      Response.json({ usage: { input_tokens: 3, output_tokens: 2 } }),
    );
    await fetcher('https://api.openai.com/v1/responses', request('fixture-agent'));
    const policy = await readFile(join(directory, 'usage-policy.json'), 'utf8');
    const ledger = await readFile(join(directory, 'usage-ledger.ndjson'), 'utf8');
    for (const campaignId of ['retained-campaign', 'another-campaign'])
      await assert.rejects(
        createEvalUsageMeter({ ...options, campaignId, 'max-usd': '1' }, env, ['fixture-agent']),
        { code: 'EEXIST' },
      );
    assert.equal(await readFile(join(directory, 'usage-policy.json'), 'utf8'), policy);
    assert.equal(await readFile(join(directory, 'usage-ledger.ndjson'), 'utf8'), ledger);
    assert.equal((await meter.report()).knownActualMicros, 5);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a denied campaign cannot resume spending through a smaller later request', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ramesh-eval-stopped-'));
  try {
    const meter = await createEvalUsageMeter(
      { 'max-usd': '0.000005', directory },
      { EVAL_USAGE_PRICES_JSON: prices },
      ['fixture-agent'],
    );
    let calls = 0;
    const fetcher = meter.wrapFetch(async () => {
      calls++;
      return Response.json({ usage: { input_tokens: 3, output_tokens: 2 } });
    });
    await assert.rejects(
      fetcher('https://api.openai.com/v1/responses', {
        method: 'POST',
        body: JSON.stringify({
          model: 'fixture-agent',
          max_output_tokens: 20,
          service_tier: 'default',
        }),
      }),
      /BUDGET_EXCEEDED/,
    );
    await assert.rejects(
      fetcher('https://api.openai.com/v1/responses', request('fixture-agent')),
      /BUDGET_EXCEEDED/,
    );
    assert.equal(calls, 0);
    assert.equal((await meter.report()).stoppedReason, 'USAGE_BUDGET_EXCEEDED');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('worker failures wait for in-flight work and persist final accounting before propagating', async () => {
  const events: string[] = [];
  let complete!: () => void;
  const remaining = new Promise<void>((resolve) => {
    complete = () => {
      events.push('settled');
      resolve();
    };
  });
  const result = settleEvalWorkers(
    {
      report: async () => {
        events.push('report');
        return { requests: 1 };
      },
    },
    [Promise.reject(new Error('fixture worker failed')), remaining],
  );
  assert.deepEqual(events, []);
  complete();
  await assert.rejects(result, /fixture worker failed/);
  assert.deepEqual(events, ['settled', 'report']);
  assert.deepEqual(await settleEvalWorkers({ report: async () => ({ requests: 0 }) }, []), {
    requests: 0,
  });
});

test('conversation CLI requires an explicit USD allowance and listing remains free', () => {
  for (const [args, reason] of [
    [['--case', 'deal-cards'], 'EVAL_MAX_USD_REQUIRED'],
    [['--list'], undefined],
  ] as const) {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'evals/conversation-run.ts', ...args],
      {
        cwd: new URL('../../', import.meta.url),
        env: {
          ...process.env,
          OPENAI_API_KEY: 'fixture-never-used',
          EVAL_MODEL: 'gpt-6-luna',
          EVAL_MAX_USD: '',
        },
        encoding: 'utf8',
        timeout: 15000,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, reason ? 1 : 0, result.stderr);
    if (reason) assert.ok(result.stderr.includes(reason), result.stderr);
  }
});
