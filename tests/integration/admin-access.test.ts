/** Verifies shared login limits, durable revocation, expiry, and bounded retention. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { PrismaAdminAccess } from '../../src/infrastructure/database/admin-access.js';
import { temporaryDatabase } from '../fixtures/database.js';

test('concurrent login requests share a persisted limit that resets only after the window', async () => {
  const fixture = await temporaryDatabase();
  let now = Date.now();
  try {
    const access = new PrismaAdminAccess(fixture.db, () => now);
    const attempts = await Promise.all(
      Array.from({ length: 20 }, () => access.attempt('test-client')),
    );
    assert.equal(attempts.filter((attempt) => attempt.allowed).length, 10);
    const anotherInstance = new PrismaAdminAccess(fixture.db, () => now);
    assert.equal((await anotherInstance.attempt('test-client')).allowed, false);
    now += 60_001;
    assert.equal((await anotherInstance.attempt('test-client')).allowed, true);
  } finally {
    await fixture.close();
  }
});

test('logout revokes copied sessions, expiry fails closed, and cleanup retains recent claims', async () => {
  const fixture = await temporaryDatabase();
  let now = Date.now();
  try {
    const access = new PrismaAdminAccess(fixture.db, () => now);
    await access.create('signed-token-hash', new Date(now + 10_000));
    assert.equal(
      await new PrismaAdminAccess(fixture.db, () => now).verify('signed-token-hash'),
      true,
    );
    await access.revoke('signed-token-hash');
    assert.equal(await access.verify('signed-token-hash'), false);
    await access.create('expiring', new Date(now + 10_000));
    await access.attempt('old-bucket');
    await fixture.db.greeting.createMany({
      data: [
        { chatId: 'test', messageId: 'recent', createdAt: new Date(now) },
        { chatId: 'test', messageId: 'old', createdAt: new Date(now - 31 * 86_400_000) },
      ],
    });
    now += 60_001;
    assert.equal(await access.verify('expiring'), false);
    await access.clean();
    assert.equal(await fixture.db.adminSession.count(), 0);
    assert.equal(await fixture.db.loginBucket.count(), 0);
    assert.equal(await fixture.db.greeting.count(), 1);
  } finally {
    await fixture.close();
  }
});
