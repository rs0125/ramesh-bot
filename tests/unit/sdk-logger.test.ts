import test from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { privateTransportLogger } from '../../src/infrastructure/whatsapp/sdk-logger.js';

test('SDK logs retain severity and safe codes while dropping protocol payloads, messages and child bindings', () => {
  const rows: Record<string, unknown>[] = [];
  const sink = pino(
    { level: 'trace', base: { service: 'fixture' }, timestamp: false },
    {
      write(value: string) {
        rows.push(JSON.parse(value));
      },
    },
  );
  const logger = privateTransportLogger(sink);
  const sentinel = 'PRIVATE_FIXTURE_SENTINEL';
  const error = Object.assign(new Error(`${sentinel}: provider exception`), {
    code: 'ECONNRESET',
    authorization: `Bearer ${sentinel}`,
  });
  const child = logger.child({ phone: sentinel, node: { text: sentinel } });
  child.setBindings({ credential: sentinel });
  for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const)
    child[level]({ error, node: sentinel, attrs: { from: sentinel } }, `${sentinel} %s`, sentinel);
  child.error(sentinel);
  child.warn({ error: { code: sentinel }, data: sentinel }, sentinel);
  assert.equal(logger.level, 'trace');
  assert.equal(logger.isLevelEnabled('debug'), true);
  assert.deepEqual(
    rows.slice(0, 6).map((row) => row.level),
    [10, 20, 30, 40, 50, 60],
  );
  assert.ok(rows.slice(0, 6).every((row) => row.code === 'ECONNRESET'));
  assert.ok(
    rows.every(
      (row) => row.event === 'whatsapp_transport_log' && row.msg === 'WhatsApp transport event',
    ),
  );
  assert.ok(!JSON.stringify(rows).includes(sentinel));
  assert.equal(rows[7]?.code, undefined);
});

test('SDK child level options cannot lower the configured transport logging threshold', () => {
  const output: string[] = [];
  const logger = privateTransportLogger(
    pino(
      { level: 'warn' },
      {
        write(value: string) {
          output.push(value);
        },
      },
    ),
  );
  logger.child({ private: 'fixture' }, { level: 'trace' }).debug('PRIVATE_FIXTURE_SENTINEL');
  logger.warn('PRIVATE_FIXTURE_SENTINEL');
  assert.equal(output.length, 1);
  assert.ok(!output[0]!.includes('PRIVATE_FIXTURE_SENTINEL'));
  assert.equal(logger.isLevelEnabled('debug'), false);
});
