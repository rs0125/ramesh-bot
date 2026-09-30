/** Uses a real WAL database to guard against inconsistent snapshots and unsafe restore behavior. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { restoreDatabase, snapshotDatabase } from '../sqlite-backup.ts';

test('backup captures committed WAL data and can restore a migration that never started a worker', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wog-backup-'));
  const path = join(dir, 'bot.db'),
    snapshot = join(dir, 'snapshot.db');
  try {
    let db = new DatabaseSync(path);
    db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE secret (value TEXT); INSERT INTO secret VALUES ('encrypted-state');",
    );
    assert.equal(await snapshotDatabase(path, snapshot), true);
    assert.equal((await stat(snapshot)).mode & 0o777, 0o600);
    db.exec('DROP TABLE secret;');
    db.close();
    await restoreDatabase(path, snapshot);
    db = new DatabaseSync(path);
    assert.equal(db.prepare('SELECT value FROM secret').get()?.value, 'encrypted-state');
    db.close();
    await restoreDatabase(path, null);
    assert.equal(await snapshotDatabase(path, snapshot), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
