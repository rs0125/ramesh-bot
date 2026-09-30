/** Creates local-only secrets without printing them; existing settings survive repeated runs. */
import { randomBytes } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { parse } from 'dotenv';

async function read(path: URL, example: URL): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return await readFile(example, 'utf8');
  }
}

function fill(text: string, values: Record<string, string>): string {
  const env = parse(text);
  for (const [key, value] of Object.entries(values)) {
    if (env[key]) continue;
    const line = `${key}=${JSON.stringify(value)}`;
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    text = pattern.test(text) ? text.replace(pattern, line) : `${text.trimEnd()}\n${line}\n`;
  }
  return text;
}

const root = new URL('../', import.meta.url);
const workerPath = new URL('.env', root);
let worker = await read(workerPath, new URL('.env.example', root));
const existingWorkerToken = parse(worker).WORKER_API_TOKEN;
const token = existingWorkerToken || randomBytes(32).toString('base64url');
worker = fill(worker, {
  WORKER_API_TOKEN: token,
  WORKER_HOST: '127.0.0.1',
  WORKER_PORT: '3011',
  WHATSAPP_AUTO_CONNECT: 'false',
  AUTH_ENCRYPTION_KEY: randomBytes(32).toString('base64url'),
});
await writeFile(workerPath, worker, { mode: 0o600 });
await chmod(workerPath, 0o600);
console.log(
  'Worker .env ready. Configure the same WORKER_API_TOKEN in your admin app. No secrets were printed.',
);
