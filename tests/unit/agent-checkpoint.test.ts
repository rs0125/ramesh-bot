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
