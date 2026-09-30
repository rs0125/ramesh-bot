/** SQLite's backup API includes WAL state; copying a live database file alone does not. */
import { DatabaseSync, backup } from 'node:sqlite';
import { chmod, copyFile, rm, stat } from 'node:fs/promises';

export async function snapshotDatabase(path: string, destination: string): Promise<boolean> {
  try {
    await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    await backup(db, destination);
    await chmod(destination, 0o600);
  } finally {
    db.close();
  }
  return true;
}

/** Call only with the worker stopped and before a candidate has ever opened WhatsApp. */
export async function restoreDatabase(path: string, snapshot: string | null): Promise<void> {
  for (const suffix of ['-wal', '-shm', '-journal']) await rm(`${path}${suffix}`, { force: true });
  if (snapshot) {
    await copyFile(snapshot, path);
    await chmod(path, 0o600);
  } else await rm(path, { force: true });
}
