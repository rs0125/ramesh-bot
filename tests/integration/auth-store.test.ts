/** Exercises encryption, transaction rollback, and session recovery against real SQLite. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { createAuthStore, AuthStorageError } from '../../src/infrastructure/database/auth-store.js';
import { temporaryDatabase } from '../fixtures/database.js';

test('credentials and binary Signal keys round-trip after reconnect without plaintext storage', async () => {
  const fixture = await temporaryDatabase();
  try {
    const key = randomBytes(32).toString('base64url');
    const errors: unknown[] = [];
    const auth = await createAuthStore(fixture.db, key, (error) => errors.push(error));
    auth.state.creds.registered = true;
    auth.state.creds.me = { id: '100@s.whatsapp.net', name: 'test-private-name' };
    await auth.saveCredentials();
    const first = Buffer.from('private-signal-value');
    await auth.state.keys.set({
      session: { one: first },
      'app-state-sync-key': { sync: { keyData: first } },
    });
    const encryptedRows = JSON.stringify(await fixture.db.whatsAppAuthEntry.findMany());
    assert.equal(encryptedRows.includes('test-private-name'), false);
    assert.equal(encryptedRows.includes(first.toString('base64')), false);
    const restored = await createAuthStore(fixture.db, key, (error) => errors.push(error));
    assert.equal(restored.state.creds.registered, true);
    assert.deepEqual(restored.state.creds.noiseKey, auth.state.creds.noiseKey);
    assert.deepEqual((await restored.state.keys.get('session', ['one'])).one, first);
    assert.deepEqual(
      (await restored.state.keys.get('app-state-sync-key', ['sync'])).sync?.keyData,
      first,
    );
    await restored.state.keys.set({ session: { one: null } });
    assert.equal((await restored.state.keys.get('session', ['one'])).one, undefined);
    assert.equal(errors.length, 0);
  } finally {
    await fixture.close();
  }
});

test('wrong encryption key and tampered rows fail closed without replacing an existing identity', async () => {
  const fixture = await temporaryDatabase();
  try {
    const key = randomBytes(32).toString('base64url');
    const original = await createAuthStore(fixture.db, key, () => {});
    const before = await fixture.db.whatsAppAuthEntry.findMany();
    await assert.rejects(
      createAuthStore(fixture.db, randomBytes(32).toString('base64url'), () => {}),
      AuthStorageError,
    );
    assert.deepEqual(await fixture.db.whatsAppAuthEntry.findMany(), before);
    await original.state.keys.set({
      session: { one: Buffer.from('one'), two: Buffer.from('two') },
    });
    const one = await fixture.db.whatsAppAuthEntry.findUniqueOrThrow({
      where: { category_keyId: { category: 'session', keyId: 'one' } },
    });
    await fixture.db.whatsAppAuthEntry.update({
      where: { category_keyId: { category: 'session', keyId: 'two' } },
      data: { encrypted: one.encrypted },
    });
    await assert.rejects(async () => original.state.keys.get('session', ['two']), AuthStorageError);
    await assert.rejects(async () => original.state.keys.get('session', ['one']), AuthStorageError);
    await assert.rejects(original.saveCredentials(), AuthStorageError);
  } finally {
    await fixture.close();
  }
});

test('a failed Signal key batch rolls back every key and prevents further writes', async () => {
  const fixture = await temporaryDatabase();
  try {
    let failures = 0;
    const auth = await createAuthStore(fixture.db, randomBytes(32).toString('base64url'), () => {
      failures++;
    });
    await fixture.db.$executeRawUnsafe(
      `CREATE TRIGGER reject_test_key BEFORE INSERT ON "WhatsAppAuthEntry" WHEN NEW."keyId" = 'bad' BEGIN SELECT RAISE(FAIL, 'simulated disk error'); END`,
    );
    await assert.rejects(
      async () =>
        auth.state.keys.set({ session: { good: Buffer.from('a'), bad: Buffer.from('b') } }),
      AuthStorageError,
    );
    assert.equal(await fixture.db.whatsAppAuthEntry.count({ where: { category: 'session' } }), 0);
    await assert.rejects(auth.saveCredentials(), AuthStorageError);
    assert.equal(failures, 1);
  } finally {
    await fixture.close();
  }
});

test('queued credential snapshots preserve update order and missing credentials do not reset keys', async () => {
  const fixture = await temporaryDatabase();
  try {
    const key = randomBytes(32).toString('base64url');
    const auth = await createAuthStore(fixture.db, key, () => {});
    auth.state.creds.me = { id: '100@s.whatsapp.net', name: 'first' };
    const first = auth.saveCredentials();
    auth.state.creds.me.name = 'second';
    await Promise.all([first, auth.saveCredentials()]);
    assert.equal((await createAuthStore(fixture.db, key, () => {})).state.creds.me?.name, 'second');
    await auth.state.keys.set({ session: { one: Buffer.from('one') } });
    await fixture.db.whatsAppAuthEntry.deleteMany({ where: { category: 'credentials' } });
    await assert.rejects(
      createAuthStore(fixture.db, key, () => {}),
      AuthStorageError,
    );
    assert.equal(
      await fixture.db.whatsAppAuthEntry.count({ where: { category: 'credentials' } }),
      0,
    );
  } finally {
    await fixture.close();
  }
});
