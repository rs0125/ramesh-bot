/** Snapshot live SQLite, then remove only WhatsApp credentials after the socket has drained. */
import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import type { PrismaClient } from '@prisma/client';

/** Caller must stop WhatsApp and flush its pending credential writes before calling this. */
export async function resetWhatsAppAuth(db: PrismaClient): Promise<string> {
  const databases = await db.$queryRaw<Array<{ name: string; file: string }>>`PRAGMA database_list`;
  const path = databases.find((entry) => entry.name === 'main')?.file;
  if (!path) throw new Error('WhatsApp relinking requires a persistent database');
  const directory = join(dirname(path), 'whatsapp-auth-backups');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = join(
    directory,
    `relink-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.db`,
  );
  const file = await open(destination, 'wx', 0o600);
  await file.close();
  try {
    const source = new DatabaseSync(path, { readOnly: true });
    try {
      await backup(source, destination);
    } finally {
      source.close();
    }
    const snapshot = new DatabaseSync(destination, { readOnly: true });
    try {
      if (snapshot.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok')
        throw new Error('WhatsApp relink backup failed verification');
    } finally {
      snapshot.close();
    }
  } catch (error) {
    await rm(destination, { force: true });
    throw error;
  }
  await db.whatsAppAuthEntry.deleteMany();
  // Keep three completed snapshots; a cleanup failure must not prevent pairing.
  await readdir(directory)
    .then((names) =>
      Promise.all(
        names
          .filter((name) => /^relink-[\dT.Z-]+-[a-f0-9-]{36}\.db$/.test(name))
          .sort()
          .slice(0, -3)
          .map((name) => rm(join(directory, name), { force: true })),
      ),
    )
    .catch(() => undefined);
  return destination;
}
