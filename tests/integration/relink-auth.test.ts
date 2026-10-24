/** Real SQLite recovery checks: capture WAL state and preserve all non-WhatsApp records. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createAuthStore } from '../../src/infrastructure/database/auth-store.js';
import { resetWhatsAppAuth } from '../../src/infrastructure/database/relink-auth.js';
import { temporaryDatabase } from '../fixtures/database.js';

test('relink snapshots committed WAL, resets the identity and keys, and preserves admin and message state', async () => {
  const fixture = await temporaryDatabase();
  const sqlite = new DatabaseSync(fixture.path);
  sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
  try {
    const key = randomBytes(32).toString('base64url');
    const auth = await createAuthStore(fixture.db, key, () => {});
    auth.state.creds.me = { id: '100@s.whatsapp.net', name: 'Saved bot' };
    await auth.saveCredentials();
    await auth.state.keys.set({ session: { peer: Buffer.from('saved-signal-key') } });
    const before = await fixture.db.whatsAppAuthEntry.findMany();
    await fixture.db.adminSession.create({
      data: { tokenHash: 'a'.repeat(64), expiresAt: new Date(Date.now() + 60000) },
    });
    await fixture.db.botSetting.create({ data: { key: 'whatsapp-enabled', value: 'false' } });
    await fixture.db.greeting.create({ data: { chatId: 'chat', messageId: 'already-sent' } });
    const destination = await resetWhatsAppAuth(fixture.db);
    assert.equal((await stat(destination)).mode & 0o777, 0o600);
    assert.equal((await stat(dirname(destination))).mode & 0o777, 0o700);
    const snapshot = new DatabaseSync(destination, { readOnly: true });
    try {
      assert.equal(snapshot.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
      assert.equal(
        snapshot.prepare('SELECT count(*) AS count FROM WhatsAppAuthEntry').get()?.count,
        before.length,
      );
      assert.equal(
        snapshot
          .prepare('SELECT encrypted FROM WhatsAppAuthEntry WHERE category = ?')
          .get('credentials')?.encrypted,
        before.find((row) => row.category === 'credentials')?.encrypted,
      );
      assert.equal(snapshot.prepare('SELECT count(*) AS count FROM Greeting').get()?.count, 1);
    } finally {
      snapshot.close();
    }
    assert.equal(await fixture.db.whatsAppAuthEntry.count(), 0);
    assert.equal(await fixture.db.adminSession.count(), 1);
    assert.equal(await fixture.db.greeting.count(), 1);
    assert.equal(
      (await fixture.db.botSetting.findUniqueOrThrow({ where: { key: 'whatsapp-enabled' } })).value,
      'false',
    );
    const fresh = await createAuthStore(fixture.db, key, () => {});
    assert.equal(fresh.state.creds.me, undefined);
    assert.notDeepEqual(fresh.state.creds.noiseKey, auth.state.creds.noiseKey);
    assert.deepEqual(await fresh.state.keys.get('session', ['peer']), {});
  } finally {
    sqlite.close();
    await fixture.close();
  }
});

test('an unavailable backup directory leaves every saved authentication record intact', async () => {
  const fixture = await temporaryDatabase();
  try {
    await createAuthStore(fixture.db, randomBytes(32).toString('base64url'), () => {});
    const before = await fixture.db.whatsAppAuthEntry.findMany();
    await writeFile(join(dirname(fixture.path), 'whatsapp-auth-backups'), 'blocked');
    await assert.rejects(resetWhatsAppAuth(fixture.db));
    assert.deepEqual(await fixture.db.whatsAppAuthEntry.findMany(), before);
  } finally {
    await fixture.close();
  }
});

test('a failed auth reset retains the verified backup and the original credentials', async () => {
  const fixture = await temporaryDatabase();
  try {
    await createAuthStore(fixture.db, randomBytes(32).toString('base64url'), () => {});
    const before = await fixture.db.whatsAppAuthEntry.findMany();
    await fixture.db.$executeRawUnsafe(
      "CREATE TRIGGER reject_auth_delete BEFORE DELETE ON WhatsAppAuthEntry BEGIN SELECT RAISE(FAIL, 'simulated storage failure'); END",
    );
    await assert.rejects(resetWhatsAppAuth(fixture.db));
    assert.deepEqual(await fixture.db.whatsAppAuthEntry.findMany(), before);
    assert.equal(
      (await readdir(join(dirname(fixture.path), 'whatsapp-auth-backups'))).filter((name) =>
        name.endsWith('.db'),
      ).length,
      1,
    );
  } finally {
    await fixture.close();
  }
});
