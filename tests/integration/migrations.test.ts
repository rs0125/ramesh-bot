/** Rejects schema changes without migrations using Prisma's actual schema diff engine. */
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

test('committed migrations produce exactly the checked-in Prisma schema', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'wog-schema-'));
  const root = fileURLToPath(new URL('../../', import.meta.url));
  try {
    await promisify(execFile)(
      process.execPath,
      [
        'node_modules/prisma/build/index.js',
        'migrate',
        'diff',
        '--from-migrations',
        'prisma/migrations',
        '--to-schema-datamodel',
        'prisma/schema.prisma',
        '--shadow-database-url',
        `file:${temporary}/shadow.db`,
        '--exit-code',
      ],
      {
        cwd: root,
        env: { ...process.env, DATABASE_URL: `file:${temporary}/unused.db` },
        timeout: 30_000,
      },
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
