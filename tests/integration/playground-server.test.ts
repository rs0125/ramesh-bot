import test from 'node:test';
import assert from 'node:assert/strict';
import { startPlaygroundServer } from '../../scripts/lib/playground-server.js';

test('capture UI labels real data, protects requests and rejects browser actor/destination overrides', async () => {
  let calls = 0;
  const server = await startPlaygroundServer({
    port: 0,
    model: 'fixture',
    mode: 'LIVE CRM',
    employeeLabel: 'Raghav <test>',
    live: true,
    chat: {
      async clear() {},
      async send() {
        calls++;
        return {
          text: 'captured',
          responseText: 'common response',
          transcripts: [{ text: 'Exact <quoted> words.' }],
          outcome: 'captured',
          queueId: 'fixture',
          trace: {
            runId: 'test',
            model: 'fixture',
            promptVersion: 'test',
            durationMs: 0,
            stages: [],
            outcome: 'completed',
          },
        };
      },
    },
  });
  try {
    const origin = `http://127.0.0.1:${server.port}`;
    const response = await fetch(origin);
    const html = await response.text();
    assert.match(html, /Raghav &lt;test&gt;/);
    assert.match(html, /Supabase test queues/);
    assert.match(html, /Unknown user/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const token = /name="playground-token" content="([^"]+)"/.exec(html)![1]!;
    const body = { conversation: 'test', sender: 'me', group: false, text: 'hello' };
    const post = (input: object, headers: Record<string, string> = {}) =>
      fetch(origin + '/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-playground-token': token, ...headers },
        body: JSON.stringify(input),
      });
    assert.equal((await post(body, { 'x-playground-token': 'wrong' })).status, 403);
    assert.equal((await post(body, { origin: 'https://attacker.example' })).status, 403);
    for (const override of [
      { employeeId: 99 },
      { phone: '+919999999999' },
      { destination: 'real@g.us' },
      { transport: 'baileys' },
    ])
      assert.equal((await post({ ...body, ...override })).status, 400);
    const result = await post(body);
    assert.equal(result.status, 200);
    const payload = await result.json();
    assert.equal(payload.outcome, 'captured');
    assert.equal(payload.responseText, 'common response');
    assert.deepEqual(payload.transcripts, [{ text: 'Exact <quoted> words.' }]);
    assert.equal(payload.voice, undefined);
    assert.equal(calls, 1);
  } finally {
    await server.close();
  }
});
