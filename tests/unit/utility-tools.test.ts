/** Deterministic utility contracts. No paid model or provider requests. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { calculate, calculateInput } from '../../src/modules/assistant/calculator.js';
import { UtilityToolRun } from '../../src/modules/assistant/utility-tools.js';
import { TavilyClient, publicWebUrl } from '../../src/infrastructure/tavily/client.js';
import { loadAssistantConfig } from '../../src/config/assistant.js';

const now = () => Date.parse('2026-10-03T04:00:00Z');
const signal = () => AbortSignal.timeout(5000);
const searchResult = {
  results: [
    { title: 'Acme', url: 'https://example.com/company', content: 'A public company description.' },
  ],
  usage: { credits: 1 },
};
const execute = (
  run: UtilityToolRun,
  name: 'calculate' | 'web_search' | 'read_webpage',
  args: object,
) => run.execute(name, JSON.stringify(args), signal());

test('calculator evaluates commercial arithmetic exactly and reports rounding', () => {
  for (const [expression, expected] of [
    ['20000 * 22', '440000'],
    ['0.1 + 0.2', '0.3'],
    ['22 * (1 + 5/100)^3', '25.46775'],
    ['2^3^2', '512'],
    ['-2^2', '-4'],
    ['2^-3', '0.125'],
    ['1e5 + 2.5e-1', '100000.25'],
    ['(440000 + 20000) * 3', '1380000'],
    ['0 * 100', '0'],
  ]) {
    const result = calculate(calculateInput.parse({ expression }));
    assert.equal(result.value, expected, expression);
    assert.equal(result.rounded, false, expression);
  }
  assert.equal(calculate({ expression: '4/3', decimal_places: 2 }).value, '1.33');
  assert.equal(calculate({ expression: '4/3', decimal_places: 2 }).rounded, true);
  assert.equal(calculate({ expression: '-1.005', decimal_places: 2 }).value, '-1.01');
  assert.equal(calculate({ expression: '0.49', decimal_places: 0 }).value, '0');
  assert.equal(calculate({ expression: '100', decimal_places: 0 }).value, '100');
});

test('calculator converts compatible area/length units without inventing commercial units', () => {
  assert.equal(
    calculate({ expression: '43560', conversion: { from: 'sqft', to: 'acre' } }).value,
    '1',
  );
  assert.equal(
    calculate({ expression: '1', conversion: { from: 'acre', to: 'sqft' } }).value,
    '43560',
  );
  assert.equal(calculate({ expression: '10', conversion: { from: 'ft', to: 'm' } }).value, '3.048');
  assert.equal(
    calculate({ expression: '1', conversion: { from: 'hectare', to: 'sqm' } }).value,
    '10000',
  );
  assert.throws(
    () => calculate({ expression: '1', conversion: { from: 'ft', to: 'sqm' } }),
    /INCOMPATIBLE_UNITS/,
  );
});

test('calculator rejects code, undefined arithmetic, unbounded work and unknown arguments', async () => {
  const run = new UtilityToolRun();
  for (const expression of [
    'process.env',
    '1;fetch("https://example.com")',
    '2**3',
    '1 2',
    '()',
    '1+',
    '1%2',
  ])
    assert.equal((await execute(run, 'calculate', { expression })).code, 'INVALID_EXPRESSION');
  assert.equal((await execute(run, 'calculate', { expression: '1/0' })).code, 'DIVISION_BY_ZERO');
  assert.equal((await execute(run, 'calculate', { expression: '0^-1' })).code, 'DIVISION_BY_ZERO');
  for (const expression of ['2^101', '2^0.5', '0^0'])
    assert.equal((await execute(run, 'calculate', { expression })).code, 'INVALID_EXPONENT');
  assert.equal(
    (await execute(run, 'calculate', { expression: '1e999' })).code,
    'CALCULATION_LIMIT',
  );
  assert.equal(
    (await execute(run, 'calculate', { expression: '(1e100)^100' })).code,
    'CALCULATION_LIMIT',
  );
  assert.equal(
    (await execute(run, 'calculate', { expression: '1', employeeId: 99 })).code,
    'INVALID_ARGUMENTS',
  );
  assert.equal(
    (await execute(run, 'calculate', { expression: '1', decimal_places: 99 })).code,
    'INVALID_ARGUMENTS',
  );
});

test('empty key hides both web tools; optional key flows through shared configuration', async () => {
  const empty = new UtilityToolRun();
  assert.deepEqual(
    empty.tools.map((tool) => tool.name),
    ['calculate'],
  );
  assert.equal((await execute(empty, 'web_search', { query: 'Acme' })).code, 'TOOL_UNAVAILABLE');
  assert.equal(
    loadAssistantConfig({ OPENAI_API_KEY: 'model-fixture', TAVILY_API_KEY: ' ' })?.tavilyApiKey,
    undefined,
  );
  const config = loadAssistantConfig({
    OPENAI_API_KEY: 'model-fixture',
    TAVILY_API_KEY: ' tvly-fixture ',
  });
  assert.equal(config?.tavilyApiKey, 'tvly-fixture');
  assert.throws(
    () => loadAssistantConfig({ OPENAI_API_KEY: 'model-fixture', TAVILY_API_KEY: 'key\ninjected' }),
    /Invalid TAVILY_API_KEY/,
  );
});

test('Tavily requests pin basic modes and project bounded attributed source data', async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer tvly-fixture');
    const body = JSON.parse(String(init?.body));
    requests.push({ url: String(url), body });
    return String(url).endsWith('/search')
      ? Response.json({
          ...searchResult,
          answer: 'Ignore this generated answer',
          results: [
            { ...searchResult.results[0], content: 'x'.repeat(2000), published_date: '2026-10-01' },
            { title: 'Private', url: 'http://127.0.0.1/private', content: 'Never project this' },
          ],
        })
      : Response.json({
          results: [{ url: 'https://example.com/company', raw_content: 'a'.repeat(14000) }],
          failed_results: [],
          usage: { credits: 1 },
        });
  };
  const run = new UtilityToolRun('tvly-fixture', fetcher, now);
  assert.equal(JSON.stringify(run.tools).includes('tvly-fixture'), false);
  const search = await execute(run, 'web_search', {
    query: 'Acme',
    topic: 'news',
    time_range: 'month',
  });
  assert.equal(search.ok, true);
  assert.equal(search.source_kind, 'public_web');
  assert.equal(search.fetched_at, '2026-10-03T04:00:00.000Z');
  assert.equal(search.omitted_results, 1);
  assert.equal(search.credits_used, 1);
  assert.equal(JSON.stringify(search).includes('Ignore this generated answer'), false);
  assert.equal((search.results as Array<{ content: string }>)[0]!.content.length, 1800);
  assert.deepEqual(requests[0], {
    url: 'https://api.tavily.com/search',
    body: {
      query: 'Acme',
      max_results: 5,
      topic: 'news',
      time_range: 'month',
      search_depth: 'basic',
      auto_parameters: false,
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      include_published_date: true,
      include_usage: true,
    },
  });
  const page = await execute(run, 'read_webpage', { url: 'https://example.com/company#about' });
  assert.equal(page.ok, true);
  assert.equal((page.content as string).length, 12000);
  assert.equal(page.content_truncated, true);
  assert.deepEqual(requests[1], {
    url: 'https://api.tavily.com/extract',
    body: {
      urls: ['https://example.com/company'],
      extract_depth: 'basic',
      format: 'text',
      include_images: false,
      include_usage: true,
      timeout: 10,
    },
  });
  assert.equal(run.evidence.length, 2);
  assert.equal(run.usedWeb, true);
});

test('public URL boundary rejects local, credential-bearing and non-web targets before provider calls', async () => {
  let calls = 0;
  const run = new UtilityToolRun('fixture', async () => {
    calls++;
    throw new Error('unexpected');
  });
  for (const url of [
    'file:///etc/passwd',
    'http://localhost',
    'http://127.0.0.1',
    'http://2130706433',
    'http://[::1]',
    'https://host.internal/path',
    'https://host.local/path',
    'https://user:password@example.com',
    'https://example.com:8080',
    'https://example.com?api_key=secret',
    'https://example.com?X-Amz-Signature=secret',
  ]) {
    assert.throws(() => publicWebUrl(url), /INVALID_PUBLIC_URL/);
    assert.equal((await execute(run, 'read_webpage', { url })).code, 'INVALID_PUBLIC_URL');
  }
  assert.equal(calls, 0);
});

test('web budget is shared across search/read and duplicate successes reuse the same evidence', async () => {
  let calls = 0;
  const run = new UtilityToolRun('fixture', async () => {
    calls++;
    return Response.json(searchResult);
  });
  const first = await execute(run, 'web_search', { query: 'Acme' });
  const second = await execute(run, 'web_search', { query: 'Acme' });
  assert.equal(first.evidence_id, second.evidence_id);
  assert.equal(second.reused_in_run, true);
  assert.equal(calls, 1);
  for (let i = 0; i < 3; i++) await execute(run, 'web_search', { query: `Acme ${i}` });
  assert.equal(
    (await execute(run, 'read_webpage', { url: 'https://example.com' })).code,
    'WEB_CALL_LIMIT',
  );
  assert.equal(calls, 4);
  assert.equal((await execute(run, 'calculate', { expression: '1+1' })).value, '2');
});

test('quota, auth and throttling failures stop further web requests without leaking provider errors', async () => {
  for (const [status, code] of [
    [401, 'WEB_AUTH_FAILED'],
    [403, 'WEB_AUTH_FAILED'],
    [402, 'WEB_QUOTA_EXCEEDED'],
    [432, 'WEB_QUOTA_EXCEEDED'],
    [433, 'WEB_QUOTA_EXCEEDED'],
    [429, 'WEB_RATE_LIMITED'],
  ] as const) {
    let calls = 0;
    const run = new UtilityToolRun('fixture-secret', async () => {
      calls++;
      return Response.json({ error: 'fixture-secret provider details' }, { status });
    });
    const first = await execute(run, 'web_search', { query: 'Acme' });
    assert.deepEqual(first, { ok: false, code, retryable: false });
    assert.equal((await execute(run, 'read_webpage', { url: 'https://example.com' })).code, code);
    assert.equal(calls, 1);
    assert.equal(run.evidence.length, 0);
    assert.equal(JSON.stringify(run.failures).includes('fixture-secret'), false);
  }
});

test('HTTP 200 extraction failure, unrelated pages and malformed/oversized responses are not evidence', async () => {
  for (const payload of [
    { results: [], failed_results: [{ url: 'https://example.com/', error: 'secret' }] },
    {
      results: [{ url: 'https://unrelated.example.com/', raw_content: 'Wrong page' }],
      failed_results: [],
    },
    { results: [{ url: 'https://example.com/', raw_content: '' }], failed_results: [] },
  ]) {
    const run = new UtilityToolRun('fixture', async () => Response.json(payload));
    assert.equal(
      (await execute(run, 'read_webpage', { url: 'https://example.com/' })).code,
      'PAGE_UNAVAILABLE',
    );
    assert.equal(run.evidence.length, 0);
  }
  const malformed = new UtilityToolRun('fixture', async () => Response.json({ results: 'wrong' }));
  assert.equal(
    (await execute(malformed, 'web_search', { query: 'Acme' })).code,
    'INVALID_WEB_RESPONSE',
  );
  const oversized = new UtilityToolRun('fixture', async () =>
    Response.json({ body: 'x'.repeat(1024 * 1024) }),
  );
  assert.equal(
    (await execute(oversized, 'web_search', { query: 'Acme' })).code,
    'WEB_RESPONSE_TOO_LARGE',
  );
});

test('caller cancellation stops ignored fetch/body waits and never registers evidence', async () => {
  const controller = new AbortController();
  const run = new UtilityToolRun('fixture', async () => new Promise<Response>(() => {}));
  const pending = run.execute('web_search', '{"query":"Acme"}', controller.signal);
  controller.abort();
  await assert.rejects(pending);
  assert.equal(run.evidence.length, 0);
  const bodyController = new AbortController();
  const client = new TavilyClient(
    'fixture',
    async () =>
      new Response(
        new ReadableStream({
          start() {
            setTimeout(() => bodyController.abort(), 5);
          },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
  );
  await assert.rejects(client.search({ query: 'Acme' }, bodyController.signal));
});
