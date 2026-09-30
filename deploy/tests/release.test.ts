/** Exercises promotion/rollback invariants, including the Signal-key state that must never rewind. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import {
  checkMigrations,
  commitSha,
  healthyRelease,
  release,
  type ReleaseSteps,
} from '../release-core.ts';
import { commandArguments, invocationState } from '../ssm-client.ts';

function fixture(failure?: keyof ReleaseSteps) {
  const calls: string[] = [];
  const names: (keyof ReleaseSteps)[] = [
    'prepare',
    'assertCurrent',
    'stop',
    'backup',
    'migrate',
    'activate',
    'start',
    'verify',
    'restoreDatabase',
    'rollbackCode',
    'recordSuccess',
  ];
  let thrown = false;
  const steps = Object.fromEntries(
    names.map((name) => [
      name,
      async () => {
        calls.push(name);
        if (failure === name && !thrown) {
          thrown = true;
          throw new Error(`Failure: ${name}`);
        }
      },
    ]),
  ) as unknown as ReleaseSteps;
  return { steps, calls };
}
test('successful deployment builds before stopping and verifies before recording success', async () => {
  const { steps, calls } = fixture();
  await release(steps);
  assert.deepEqual(calls, [
    'prepare',
    'assertCurrent',
    'stop',
    'backup',
    'migrate',
    'activate',
    'start',
    'verify',
    'recordSuccess',
  ]);
});
test('build failures and an advanced main branch leave the running worker untouched', async () => {
  for (const point of ['prepare', 'assertCurrent'] as const) {
    const { steps, calls } = fixture(point);
    await assert.rejects(release(steps));
    assert.equal(calls.includes('stop'), false);
  }
});
test('failed migration restores a consistent backup before restarting previous code', async () => {
  const { steps, calls } = fixture('migrate');
  await assert.rejects(release(steps));
  assert.deepEqual(calls.slice(-3), ['stop', 'restoreDatabase', 'rollbackCode']);
  assert.equal(calls.includes('start'), false);
});
test('a partially failed stop is retried before recovering the previous worker', async () => {
  const { steps, calls } = fixture('stop');
  await assert.rejects(release(steps));
  assert.deepEqual(calls.slice(-3), ['stop', 'stop', 'rollbackCode']);
  assert.equal(calls.includes('restoreDatabase'), false);
});
test('once the candidate starts, rollback keeps new keys and dedupe state', async () => {
  for (const point of ['start', 'verify'] as const) {
    const { steps, calls } = fixture(point);
    await assert.rejects(release(steps));
    assert.equal(calls.includes('restoreDatabase'), false);
    assert.deepEqual(calls.slice(-2), ['stop', 'rollbackCode']);
  }
});
test('actual migrations pass the conservative additive guard; rewrites and history edits fail', async () => {
  const root = new URL('../../prisma/migrations/', import.meta.url);
  const migrations = new Map<string, string>();
  for (const entry of await readdir(root, { withFileTypes: true }))
    if (entry.isDirectory())
      migrations.set(
        entry.name,
        await readFile(new URL(`${entry.name}/migration.sql`, root), 'utf8'),
      );
  checkMigrations(new Map(), migrations);
  checkMigrations(migrations, migrations);
  for (const sql of [
    'DROP TABLE "Greeting";',
    'DELETE FROM "Greeting";',
    'CREATE TRIGGER bad AFTER INSERT ON "Greeting" BEGIN DELETE FROM "Greeting"; END;',
    'CREATE UNIQUE INDEX "new" ON "Greeting"("messageId");',
    'ALTER TABLE "Greeting" ADD COLUMN "required" TEXT NOT NULL;',
    'ALTER TABLE "Greeting" ADD COLUMN "constrained" TEXT CHECK (length("messageId") > 10);',
    'CREATE TABLE "Linked" (id TEXT REFERENCES "Greeting"("messageId"));',
  ]) {
    assert.throws(() =>
      checkMigrations(migrations, new Map([...migrations, ['20990101_change', sql]])),
    );
  }
  const altered = new Map(migrations);
  altered.set([...migrations.keys()][0]!, 'CREATE TABLE "changed" (id INT);');
  assert.throws(() => checkMigrations(migrations, altered));
  assert.throws(() => checkMigrations(migrations, new Map()));
});
test('deployment inputs and health require the exact tested commit', () => {
  const sha = 'a'.repeat(40);
  for (const input of ['main', '../main', 'a'.repeat(39), `${sha}; touch /tmp/injected`])
    assert.throws(() => commitSha(input));
  assert.equal(healthyRelease({ status: 'ok', release: sha }, sha), true);
  assert.equal(healthyRelease({ status: 'ok', release: 'b'.repeat(40) }, sha), false);
  const target = {
    instance: 'i-0123456789abcdef0',
    document: 'wareongo-bot-deploy',
    version: '1',
    region: 'ap-south-1',
  };
  const args = commandArguments(sha, target);
  assert.deepEqual(JSON.parse(args[args.indexOf('--parameters') + 1]!), { Commit: [sha] });
  assert.throws(() => commandArguments(sha, { ...target, document: 'AWS-RunShellScript; bad' }));
  assert.equal(invocationState('Pending'), 'waiting');
  assert.equal(invocationState('Success'), 'success');
  for (const status of ['Failed', 'Cancelled', 'TimedOut', 'unknown'])
    assert.throws(() => invocationState(status));
});
