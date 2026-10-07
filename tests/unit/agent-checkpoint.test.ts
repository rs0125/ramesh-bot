import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import {
  AgentCheckpointRepository,
  canonicalCheckpointJson,
  CHECKPOINT_MAX_BYTES,
} from '../../src/infrastructure/database/agent-checkpoint.repository.js';
import { CheckpointError } from '../../src/modules/assistant/checkpoint.types.js';

test('checkpoint request keys ignore JSON property order but preserve list and content order', () => {
  const first = {
    model: 'fixture',
    input: [{ role: 'user', content: 'hello' }],
    config: { z: 2, a: 1 },
  };
  const reordered = {
    config: { a: 1, z: 2 },
    input: [{ content: 'hello', role: 'user' }],
    model: 'fixture',
  };
  assert.equal(canonicalCheckpointJson(first), canonicalCheckpointJson(reordered));
  assert.notEqual(canonicalCheckpointJson([1, 2]), canonicalCheckpointJson([2, 1]));
  assert.notEqual(
    canonicalCheckpointJson(first),
    canonicalCheckpointJson({ ...first, model: 'changed' }),
  );
  assert.equal(canonicalCheckpointJson({ defined: 1, absent: undefined }), '{"defined":1}');
  assert.throws(() => canonicalCheckpointJson(undefined));
  assert.throws(() => canonicalCheckpointJson('x'.repeat(CHECKPOINT_MAX_BYTES)));
});

test('checkpoint persistence failures are typed and do not leak database diagnostics', async () => {
  const repo = new AgentCheckpointRepository(
    {
      connect: async () => {
        throw new Error('database-password-or-query-must-stay-private');
      },
    } as unknown as Pool,
    {
      namespace: 'production',
      accountId: 'fixture',
      encryptionKey: randomBytes(32).toString('base64url'),
    },
  );
  await assert.rejects(repo.clean(), (error: unknown) => {
    assert.ok(error instanceof CheckpointError);
    assert.equal(error.message, 'CHECKPOINT_OPERATION_FAILED');
    assert.equal(error.cause, undefined);
    return true;
  });
});

test('rolled-back database contention retries persistence without restarting research', async () => {
  let attempts = 0;
  const client = {
    async query() {
      return { rows: [] };
    },
    release() {},
  };
  const repository = new AgentCheckpointRepository(
    {
      async connect() {
        if (++attempts < 3)
          throw Object.assign(new Error('private database detail'), { code: '55P03' });
        return client;
      },
    } as unknown as Pool,
    {
      namespace: 'production',
      accountId: 'fixture',
      encryptionKey: randomBytes(32).toString('base64url'),
    },
  );
  await repository.clean();
  assert.equal(attempts, 3);
});

test('exhausted database contention reports a fixed diagnostic, and ambiguous connection failures are not retried', async () => {
  for (const [code, expectedAttempts, expectedCode] of [
    ['40P01', 3, 'CHECKPOINT_DB_40P01'],
    ['08006', 1, 'CHECKPOINT_OPERATION_FAILED'],
  ] as const) {
    let attempts = 0;
    const repository = new AgentCheckpointRepository(
      {
        async connect() {
          attempts++;
          throw Object.assign(new Error('secret server diagnostic'), { code });
        },
      } as unknown as Pool,
      {
        namespace: 'production',
        accountId: 'fixture',
        encryptionKey: randomBytes(32).toString('base64url'),
      },
    );
    await assert.rejects(repository.clean(), (error: unknown) => {
      assert.ok(error instanceof CheckpointError);
      assert.equal(error.code, expectedCode);
      assert.equal(error.cause, undefined);
      assert.ok(!JSON.stringify(error).includes('secret'));
      return true;
    });
    assert.equal(attempts, expectedAttempts);
  }
});
