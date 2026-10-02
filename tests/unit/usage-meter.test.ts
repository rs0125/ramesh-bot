/** Real SDK serialization/retries with injected fake fetch only. Prices are fictional fixtures. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadUsagePolicy,
  usdToMicros,
  type UsagePolicy,
  type UsagePrice,
} from '../../src/config/usage.js';
import { UsageMeter, type UsageEvent } from '../../src/modules/usage/usage-meter.js';
import { MemoryUsageLedger } from '../../src/modules/usage/memory-ledger.js';
import { reportedUsage, priceUsage, reserveUsage } from '../../src/modules/usage/usage-pricing.js';
import { withUsageStage } from '../../src/modules/usage/usage-scope.js';
import { OpenAITextModel } from '../../src/infrastructure/openai/text-model.js';
import { OpenAIMediaProcessor } from '../../src/infrastructure/openai/media-processor.js';

const price: UsagePrice = {
  inputMicrosPerMillion: 1_000_000,
  outputMicrosPerMillion: 2_000_000,
  cachedInputMicrosPerMillion: 500_000,
  audioInputMicrosPerMillion: 3_000_000,
  maxInputTokens: 100,
  maxOutputTokens: 20,
};
const prices = { version: 'fictional-v1', models: { 'fixture-model': price } };
const usage = {
  input_tokens: 10,
  output_tokens: 5,
  input_tokens_details: { cached_tokens: 4 },
  output_tokens_details: { reasoning_tokens: 3 },
};
function response(status = 'completed') {
  return Response.json(
    {
      id: 'fixture_response',
      object: 'response',
      status,
      usage,
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Fixture reply.' }],
        },
      ],
    },
    { headers: { 'x-request-id': 'req_fixture' } },
  );
}
const request = {
  stage: 'converser' as const,
  instructions: 'PRIVATE_INSTRUCTIONS',
  messages: [{ role: 'user' as const, content: 'PRIVATE_CONTENT' }],
};
const config = {
  apiKey: 'PRIVATE_KEY',
  model: 'fixture-model',
  timeoutMs: 2000,
  maxOutputTokens: 20,
};
const url = 'https://api.openai.com/v1/responses';
const init = {
  method: 'POST',
  body: JSON.stringify({ model: 'fixture-model', service_tier: 'default', max_output_tokens: 20 }),
};
function setup(
  limits: UsagePolicy['limits'] = { runMicros: 2000 },
  mode: UsagePolicy['mode'] = 'enforce',
) {
  const events: UsageEvent[] = [];
  const ledger = new MemoryUsageLedger('fixture-account', 'evaluation');
  const meter = new UsageMeter(ledger, {
    accountId: 'fixture-account',
    purpose: 'evaluation',
    policy: { mode, prices, limits },
    observe: (event) => {
      events.push(event);
    },
    now: () => Date.UTC(2026, 9, 2, 20),
  });
  return { meter, ledger, events };
}
const scope = { runId: 'fixture-run', subjectId: 'employee:7' };

test('USD parsing and policy loading never infer a price or a monetary allowance', () => {
  assert.deepEqual(loadUsagePolicy({}), { mode: 'off', limits: {} });
  assert.equal(usdToMicros('0.000001'), 1);
  assert.equal(usdToMicros('12.345678'), 12_345_678);
  for (const value of ['-1', '+1', '1e2', 'NaN', ' 1', '1.0000001', '9007199255'])
    assert.throws(() => usdToMicros(value), /INVALID_USAGE_USD/);
  assert.throws(() => loadUsagePolicy({ USAGE_MODE: 'enforce' }), /POLICY_REQUIRED/);
  assert.throws(() => loadUsagePolicy({ USAGE_RUN_MAX_USD: '1' }), /LIMITS_DISABLED/);
  assert.throws(
    () => loadUsagePolicy({ USAGE_PRICES_JSON: JSON.stringify({ ...prices, apiKey: 'secret' }) }),
    /INVALID_USAGE_PRICES/,
  );
  assert.equal(
    loadUsagePolicy({
      USAGE_MODE: 'enforce',
      USAGE_PRICES_JSON: JSON.stringify(prices),
      USAGE_RUN_MAX_USD: '0',
    }).limits.runMicros,
    0,
  );
});

test('enabling accounting without wiring the shared meter fails before constructing a provider client', () => {
  const missingMeter = {
    ...config,
    usagePolicy: { mode: 'enforce' as const, prices, limits: { runMicros: 1000 } },
  };
  const neverFetch: typeof fetch = async () => assert.fail('No request allowed');
  assert.throws(() => new OpenAITextModel(missingMeter, neverFetch), /USAGE_METER_REQUIRED/);
  assert.throws(
    () => new OpenAIMediaProcessor(missingMeter, 'fixture-model', neverFetch),
    /USAGE_METER_REQUIRED/,
  );
});

test('pricing counts reported cached input and includes reasoning in output exactly once', () => {
  const result = reportedUsage({ usage }, 'responses');
  assert.equal(priceUsage(result, price), 18); // 6 regular + 2 cached + 10 output micros.
  assert.equal(result.fields.reasoningTokens, 3);
  assert.equal(
    priceUsage(
      reportedUsage({ usage: { ...usage, output_tokens_details: {} } }, 'responses'),
      price,
    ),
    18,
  );
  assert.equal(
    priceUsage(reportedUsage({ usage: { input_tokens: 1, output_tokens: 0 } }, 'responses'), {
      inputMicrosPerMillion: 1,
      outputMicrosPerMillion: 1,
    }),
    1,
  ); // Round up fractions of a micro, never silently lose them.
});

test('missing, inconsistent and unsupported billing dimensions remain explicitly unknown', () => {
  const variants = [
    undefined,
    {},
    { usage: {} },
    { usage: { ...usage, input_tokens: -1 } },
    { usage: { ...usage, input_tokens_details: { cached_tokens: 11 } } },
    { usage: { ...usage, output_tokens_details: { reasoning_tokens: 6 } } },
    { usage: { ...usage, input_tokens_details: { cached_tokens: 4, cache_write_tokens: 2 } } },
    { usage: { input_tokens: 10, output_tokens: 5 } },
  ];
  for (const body of variants)
    assert.equal(priceUsage(reportedUsage(body, 'responses'), price), null);
  const { cachedInputMicrosPerMillion: _, ...noCachedPrice } = price;
  assert.equal(priceUsage(reportedUsage({ usage }, 'responses'), noCachedPrice), null);
  assert.equal(priceUsage(reportedUsage({ usage }, 'responses')), null);
});

test('transcription prices audio/text splits and duration but refuses an unbounded duration reservation', () => {
  const tokens = reportedUsage(
    {
      usage: {
        type: 'tokens',
        input_tokens: 12,
        output_tokens: 2,
        input_token_details: { audio_tokens: 10, text_tokens: 2 },
      },
    },
    'transcription',
  );
  assert.equal(priceUsage(tokens, price), 36);
  assert.equal(
    priceUsage(
      reportedUsage({ usage: { input_tokens: 12, output_tokens: 2 } }, 'transcription'),
      price,
    ),
    null,
  );
  const durationPrice = { ...price, durationMicrosPerSecond: 2 };
  assert.equal(
    priceUsage(
      reportedUsage({ usage: { type: 'duration', seconds: 1.25 } }, 'transcription'),
      durationPrice,
    ),
    3,
  );
  assert.equal(reserveUsage(durationPrice, undefined, 'transcription'), null);
  assert.equal(reserveUsage(price), 340);
  assert.equal(reserveUsage({ ...price, maxInputTokens: undefined }), null);
  assert.equal(reserveUsage({ ...price, maxOutputTokens: undefined }), null);
  assert.equal(
    reserveUsage({ ...price, audioInputMicrosPerMillion: undefined }, undefined, 'transcription'),
    null,
  );
});

test('real text SDK shares run accounting across stages and stores no request content', async () => {
  const { meter, events } = setup({
    runMicros: 2000,
    subjectDayMicros: 2000,
    accountDayMicros: 2000,
  });
  const model = new OpenAITextModel({ ...config, usageMeter: meter }, async () => response());
  await meter.run(scope, async () => {
    await model.complete(request);
    await model.complete({ ...request, stage: 'formatter' });
    await model.startToolSession({ ...request, tools: [] }).next(0, AbortSignal.timeout(2000));
  });
  const reserved = events.filter((event) => event.type === 'reserved');
  assert.deepEqual(
    reserved.map((event) => event.reservation.stage),
    ['converser', 'formatter', 'worker'],
  );
  assert.ok(reserved.every((event) => event.reservation.subjectId === 'employee:7'));
  assert.ok(
    reserved.every((event) =>
      event.reservation.buckets.some((bucket) => bucket.key === 'subject:employee:7:2026-10-02'),
    ),
  );
  assert.equal((await meter.summarize(scope.runId)).knownActualMicros, 54);
  assert.equal((await meter.summarize(scope.runId)).costComplete, true);
  const serialized = JSON.stringify(events);
  for (const privateValue of [
    'PRIVATE_INSTRUCTIONS',
    'PRIVATE_CONTENT',
    'PRIVATE_KEY',
    'Fixture reply.',
  ])
    assert.ok(!serialized.includes(privateValue));
});

test('actual SDK retry gets its own reservation while an unknown prior attempt remains held', async () => {
  const { meter, events } = setup();
  let calls = 0;
  const model = new OpenAITextModel({ ...config, usageMeter: meter }, async () => {
    if (++calls === 1)
      return Response.json(
        { error: { message: 'fixture failure' } },
        {
          status: 503,
          headers: { 'retry-after-ms': '1' },
        },
      );
    return response();
  });
  await meter.run(scope, () => model.complete(request));
  assert.equal(calls, 2);
  assert.deepEqual(
    events.filter((event) => event.type === 'reserved').map((event) => event.reservation.attempt),
    [0, 1],
  );
  const summary = await meter.summarize(scope.runId);
  assert.equal(summary.requestCount, 2);
  assert.equal(summary.knownActualMicros, 18);
  assert.equal(summary.heldMicros, 340);
  assert.equal(summary.unknownRequests, 1);
  assert.equal(summary.costComplete, false);
});

test('SDK retry cannot spend a second allowance after a missing-usage provider error', async () => {
  const { meter } = setup({ runMicros: 340 });
  let calls = 0;
  const model = new OpenAITextModel({ ...config, usageMeter: meter }, async () => {
    calls++;
    return Response.json(
      { error: { message: 'fixture failure' } },
      { status: 429, headers: { 'retry-after-ms': '1' } },
    );
  });
  await assert.rejects(
    meter.run(scope, () => model.complete(request)),
    /OpenAI request failed/,
  );
  assert.equal(calls, 1);
  assert.equal((await meter.summarize(scope.runId)).heldMicros, 340);
});

test('incomplete text consumes reported usage even though the adapter rejects the answer', async () => {
  const { meter } = setup();
  const model = new OpenAITextModel({ ...config, usageMeter: meter }, async () =>
    response('incomplete'),
  );
  await assert.rejects(
    meter.run(scope, () => model.complete(request)),
    /OpenAI request failed/,
  );
  assert.equal((await meter.summarize(scope.runId)).knownActualMicros, 18);
});

test('parallel stage requests reserve atomically against one run ceiling', async () => {
  const { meter } = setup({ runMicros: 340 });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const wrapped = meter.wrapFetch(async () => {
    calls++;
    await pending;
    return response();
  });
  await meter.run(scope, async () => {
    const first = withUsageStage('media-extractor', () => wrapped(url, init));
    await assert.rejects(
      withUsageStage('worker', () => wrapped(url, init)),
      /USAGE_BUDGET_EXCEEDED/,
    );
    release();
    await first;
  });
  assert.equal(calls, 1);
});

test('Request objects preserve attribution and cancellation before admission spends nothing', async () => {
  const { meter } = setup();
  let calls = 0;
  const wrapped = meter.wrapFetch(async () => {
    calls++;
    return response();
  });
  await meter.run(scope, () => wrapped(new Request(url, init)));
  await assert.rejects(
    meter.run(scope, () => wrapped(new Request(url, { ...init, signal: AbortSignal.abort() }))),
  );
  await assert.rejects(wrapped(url, init), /USAGE_RUN_SCOPE_REQUIRED/);
  await assert.rejects(
    meter.run(scope, () => wrapped('https://attacker.invalid/v1/responses', init)),
    /PROVIDER_NOT_SUPPORTED/,
  );
  assert.equal(calls, 1);
});

test('transport failure retains a reservation rather than counting zero', async () => {
  const { meter } = setup();
  const wrapped = meter.wrapFetch(async () => {
    throw new Error('fixture timeout');
  });
  await assert.rejects(
    meter.run(scope, () => wrapped(url, init)),
    /fixture timeout/,
  );
  const summary = await meter.summarize(scope.runId);
  assert.equal(summary.heldMicros, 340);
  assert.equal(summary.unknownRequests, 1);
});

test('unsupported cache-write counts are retained for diagnosis without guessing a price', async () => {
  const { meter, events } = setup();
  const wrapped = meter.wrapFetch(async () =>
    Response.json({
      usage: {
        ...usage,
        input_tokens_details: { cached_tokens: 4, cache_write_tokens: 2 },
      },
    }),
  );
  await meter.run(scope, () => wrapped(url, init));
  const event = events.find((item) => item.type === 'settled');
  assert.ok(event?.type === 'settled');
  assert.equal(event.settlement.cacheWriteTokens, 2);
  assert.equal(event.settlement.actualMicros, null);
  assert.equal((await meter.summarize(scope.runId)).heldMicros, 340);
});

test('real media SDK multipart and image requests share the same meter', async () => {
  const { meter, events } = setup({ runMicros: 30_000 });
  const processor = new OpenAIMediaProcessor(
    { ...config, usageMeter: meter },
    'fixture-model',
    async (input, req) => {
      if (String(input).includes('/audio/transcriptions')) {
        assert.ok(req?.body instanceof FormData);
        return Response.json({
          text: 'PRIVATE_TRANSCRIPT',
          usage: {
            type: 'tokens',
            input_tokens: 12,
            output_tokens: 2,
            input_token_details: { audio_tokens: 10, text_tokens: 2 },
          },
        });
      }
      return response();
    },
  );
  await meter.run(scope, async () => {
    await processor.extract(
      { mime: 'audio/ogg', bytes: Buffer.from('fake audio'), name: 'private.ogg' },
      AbortSignal.timeout(2000),
    );
    await processor.extract(
      { mime: 'image/png', bytes: Buffer.from('fake image'), name: 'private.png' },
      AbortSignal.timeout(2000),
    );
  });
  assert.deepEqual(
    events.filter((event) => event.type === 'reserved').map((event) => event.reservation.stage),
    ['transcription', 'media-extractor'],
  );
  assert.equal((await meter.summarize(scope.runId)).knownActualMicros, 54);
  assert.ok(!JSON.stringify(events).includes('PRIVATE_TRANSCRIPT'));
});

test('duration-priced transcription cannot send under enforcement without a trusted duration bound', async () => {
  const meter = new UsageMeter(new MemoryUsageLedger(), {
    accountId: 'fixture',
    purpose: 'evaluation',
    policy: {
      mode: 'enforce',
      limits: { runMicros: 10000 },
      prices: {
        version: 'fictional-v1',
        models: { 'fixture-model': { ...price, durationMicrosPerSecond: 2 } },
      },
    },
  });
  const body = new FormData();
  body.set('model', 'fixture-model');
  const wrapped = meter.wrapFetch(async () => assert.fail('No provider request allowed'));
  await assert.rejects(
    meter.run(scope, () =>
      wrapped(
        new Request('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', body }),
      ),
    ),
    /USAGE_PRICE_UNKNOWN/,
  );
});

test('observer and reservation/settlement storage failures stop subsequent fetches', async () => {
  for (const fail of ['observer', 'settle', 'reserve'] as const) {
    let calls = 0;
    const ledger = new MemoryUsageLedger();
    if (fail === 'settle')
      ledger.settle = async () => {
        throw new Error('private database error');
      };
    if (fail === 'reserve')
      ledger.reserve = async () => {
        throw new Error('private database error');
      };
    const meter = new UsageMeter(ledger, {
      accountId: 'fixture',
      purpose: 'evaluation',
      policy: { mode: 'enforce', prices, limits: { runMicros: 1000 } },
      observe: () => {
        if (fail === 'observer') throw new Error('private log error');
      },
    });
    const wrapped = meter.wrapFetch(async () => {
      calls++;
      return response();
    });
    await assert.rejects(
      meter.run(scope, () => wrapped(url, init)),
      /USAGE_(OBSERVER|LEDGER)_UNAVAILABLE/,
    );
    await assert.rejects(
      meter.run(scope, () => wrapped(url, init)),
      /USAGE_(OBSERVER|LEDGER)_UNAVAILABLE/,
    );
    assert.equal(calls, fail === 'settle' ? 1 : 0);
  }
});

test('unpriced provider features and tiers are rejected before fetch; unexpected response tiers remain unknown', async () => {
  const { meter } = setup();
  let calls = 0;
  const wrapped = meter.wrapFetch(async () => {
    calls++;
    return Response.json({ usage, service_tier: 'priority' });
  });
  for (const extra of [
    { service_tier: 'auto' },
    { service_tier: 'priority' },
    { background: true },
    { stream: true },
    { tools: [{ type: 'web_search' }] },
    { tools: [{ type: 'code_interpreter' }] },
  ])
    await assert.rejects(
      meter.run(scope, () =>
        wrapped(url, {
          ...init,
          body: JSON.stringify({ ...JSON.parse(init.body), ...extra }),
        }),
      ),
      /USAGE_REQUEST_PRICING_UNSUPPORTED/,
    );
  assert.equal(calls, 0);
  await assert.rejects(
    meter.run(scope, () => wrapped(url, init)),
    /USAGE_PROVIDER_PRICE_MISMATCH/,
  );
  assert.equal((await meter.summarize(scope.runId)).unknownRequests, 1);
  await assert.rejects(
    meter.run(scope, () => wrapped(url, init)),
    /USAGE_PROVIDER_PRICE_MISMATCH/,
  );
  assert.equal(calls, 1);
});

test('observe mode records unpriced usage explicitly and off mode leaves fetch untouched', async () => {
  const fetcher: typeof fetch = async () => response();
  assert.equal(setup({}, 'off').meter.wrapFetch(fetcher), fetcher);
  const meter = new UsageMeter(new MemoryUsageLedger(), {
    accountId: 'fixture',
    purpose: 'evaluation',
    policy: { mode: 'observe', limits: {} },
  });
  await meter.run(scope, () => meter.wrapFetch(fetcher)(url, init));
  const summary = await meter.summarize(scope.runId);
  assert.equal(summary.unpricedRequests, 1);
  assert.equal(summary.costComplete, false);
});
