import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  GateRejection,
  annotateStage,
  classifyFailure,
} from '../../src/modules/assistant/failure.js';
import { ModelFailureError } from '../../src/modules/assistant/model-failure.js';
import { ContextEngineError } from '../../src/modules/context-engine/context.types.js';
import { SchedulingError } from '../../src/modules/scheduling/scheduling.types.js';
import { WriteStorageError } from '../../src/modules/writes/write.types.js';

test('every error family maps to a stable code and stage', () => {
  const gate = new GateRejection('EXECUTOR_UNKNOWN_TOOL', { names: ['x'] });
  annotateStage(gate, 'executor');
  assert.deepEqual(classifyFailure(gate), {
    stage: 'executor',
    family: 'GateRejection',
    code: 'EXECUTOR_UNKNOWN_TOOL',
    detail: { names: ['x'] },
  });
  assert.deepEqual(
    classifyFailure(
      new ModelFailureError({ stage: 'verifier', code: 'RATE_LIMITED', httpStatus: 429 }, 'x'),
    ),
    {
      stage: 'verifier',
      family: 'ModelFailureError',
      code: 'RATE_LIMITED',
      detail: { httpStatus: 429 },
    },
  );
  assert.equal(
    classifyFailure(new ContextEngineError('INVALID_ARGUMENTS')).code,
    'INVALID_ARGUMENTS',
  );
  assert.equal(
    classifyFailure(new SchedulingError('UNTRUSTED_COMMAND_SOURCE')).code,
    'UNTRUSTED_COMMAND_SOURCE',
  );
  assert.equal(classifyFailure(new WriteStorageError('WRITE_CONFLICT')).code, 'WRITE_CONFLICT');
  assert.equal(
    classifyFailure(new Error('CONTEXT_SUMMARY_INVALID')).code,
    'CONTEXT_SUMMARY_INVALID',
  );
  assert.equal(classifyFailure(undefined, 'graph').stage, 'graph');
  // DOMException carries a numeric legacy code and a prose message; its name is the signal.
  assert.equal(classifyFailure(new DOMException('Reply deadline', 'TimeoutError')).code, 'TIMEOUT');
  assert.equal(classifyFailure(AbortSignal.abort().reason).code, 'ABORTED');
});

test('free-text messages are never kept, because they can carry provider bodies', () => {
  const failure = classifyFailure(new Error('provider said: synthetic-secret body'), 'graph');
  assert.equal(failure.code, 'UNCLASSIFIED');
  assert.ok(!JSON.stringify(failure).includes('synthetic-secret'));
});

test('a stage annotation is kept by the first annotator and is invisible to serialization', () => {
  const error = new GateRejection('REPLY_LENGTH_INVALID');
  annotateStage(error, 'formatter');
  annotateStage(error, 'graph');
  assert.equal(classifyFailure(error).stage, 'formatter');
  assert.ok(!JSON.stringify(error).includes('formatter'));
  assert.ok(error instanceof GateRejection && error instanceof Error);
});

test('no bare Error throws in the assistant and OpenAI layers; use GateRejection with a code', async () => {
  const offenders: string[] = [];
  for (const dir of ['src/modules/assistant', 'src/infrastructure/openai']) {
    for (const file of await readdir(dir)) {
      if (!file.endsWith('.ts')) continue;
      const text = await readFile(join(dir, file), 'utf8');
      text.split('\n').forEach((line, index) => {
        if (/throw new Error\(/.test(line)) offenders.push(`${dir}/${file}:${index + 1}`);
      });
    }
  }
  assert.deepEqual(offenders, []);
});
