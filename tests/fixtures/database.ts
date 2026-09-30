/** Isolated SQLite databases built from the actual migrations; no shared DB is touched. */
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PrismaClient } from '@prisma/client';

export async function temporaryDatabase() {
  const directory = await mkdtemp(join(tmpdir(), 'wog-bot-test-'));
  const path = join(directory, 'state.db');
  const sqlite = new DatabaseSync(path);
  try {
    const root = new URL('../../prisma/migrations/', import.meta.url);
    for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.isDirectory())
        sqlite.exec(await readFile(new URL(`${entry.name}/migration.sql`, root), 'utf8'));
    }
  } finally {
    sqlite.close();
  }
  const db = new PrismaClient({ datasources: { db: { url: `file:${path}` } } });
  return {
    db,
    path,
    async close() {
      await db.$disconnect();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
