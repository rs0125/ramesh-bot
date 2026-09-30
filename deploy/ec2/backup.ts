/** Root-only daily SQLite backup; encryption keys are backed up separately in Parameter Store. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, rm, stat } from 'node:fs/promises';
import { snapshotDatabase } from '../sqlite-backup.ts';

const directory = '/var/backups/wareongo-sales-bot';
const bucket = process.env.BACKUP_BUCKET ?? '';
const region = process.env.AWS_REGION ?? '';
if (!/^[a-z0-9-]{3,63}$/.test(bucket) || !/^[a-z]{2}-[a-z]+-\d$/.test(region))
  throw new Error('Invalid backup destination');
const filename = `daily-${new Date().toISOString().replaceAll(':', '-')}.db`;
const path = `${directory}/${filename}`;
try {
  if (!(await snapshotDatabase('/var/lib/wareongo-sales-bot/bot.db', path)))
    throw new Error('Worker database is missing');
  await promisify(execFile)(
    '/usr/bin/aws',
    [
      's3api',
      'put-object',
      '--bucket',
      bucket,
      '--key',
      `daily/${filename}`,
      '--body',
      path,
      '--region',
      region,
      '--server-side-encryption',
      'AES256',
      '--no-cli-pager',
    ],
    { timeout: 120_000, maxBuffer: 16_384 },
  );
  // Expire local deployment/daily snapshots only after an off-instance upload succeeds.
  for (const name of await readdir(directory)) {
    if (!/^(?:daily-|\d+-)[a-zA-Z0-9T:.\-]+\.db$/.test(name)) continue;
    const file = `${directory}/${name}`;
    if ((await stat(file)).mtimeMs < Date.now() - 7 * 86_400_000) await rm(file);
  }
  console.log('Encrypted off-instance database backup completed');
} finally {
  await rm(path, { force: true });
}
