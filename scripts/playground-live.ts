/** Real Supabase + signed Context Engine, with a capture-only sink. No createApplication or Baileys session. */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
import { Pool } from 'pg';
import { loadLivePlaygroundConfig } from '../src/config/playground.js';
import { messagePoolOptions } from '../src/infrastructure/database/message-pool.js';
import { PlaygroundRepository } from '../src/infrastructure/database/playground.repository.js';
import { createPlaygroundAccess } from '../src/app/playground-access.js';
import { OpenAITextModel } from '../src/infrastructure/openai/text-model.js';
import { MediaRepository } from '../src/infrastructure/database/media.repository.js';
import { MediaService } from '../src/modules/media/media.service.js';
import { OpenAIMediaProcessor } from '../src/infrastructure/openai/media-processor.js';
import { loadDebounce } from '../src/modules/messaging/debounce.js';
import { LiveChat } from './lib/live-chat.js';
import { startPlaygroundServer } from './lib/playground-server.js';

async function main() {
  const env = parse(
    await readFile(resolve(process.env.PLAYGROUND_ENV_FILE ?? '.local/live-playground.env')),
  );
  if (process.env.PLAYGROUND_PORT) env.PLAYGROUND_PORT = process.env.PLAYGROUND_PORT;
  const config = loadLivePlaygroundConfig(env);
  const pool = new Pool(messagePoolOptions(config.databaseUrl, config.ca));
  pool.on('error', () => console.error('Playground database connection failed'));
  try {
    const repo = new PlaygroundRepository(
      pool,
      config.namespace,
      config.employeeId,
      config.encryptionKey,
      loadDebounce(env),
    );
    await repo.health();
    await repo.clean();
    const access = createPlaygroundAccess(config, pool);
    if (!(await access.employee(AbortSignal.timeout(config.context.timeoutMs))))
      throw new Error('CONFIGURED_EMPLOYEE_INACTIVE_OR_AMBIGUOUS');
    const media = new MediaService(
      new MediaRepository(
        pool,
        `${config.namespace}:${config.employeeId}`,
        config.encryptionKey,
        'capture',
      ),
      new OpenAIMediaProcessor(config.model),
    );
    await media.clean();
    const maintenance = setInterval(
      () => void media.clean().catch(() => console.error('Media cleanup failed')),
      60000,
    );
    maintenance.unref();
    const chat = new LiveChat(
      config.model,
      new OpenAITextModel(config.model),
      repo,
      access,
      Math.max(config.context.timeoutMs, 60000),
      media,
    );
    const server = await startPlaygroundServer({
      port: config.port,
      model: config.model.model,
      chat,
      live: true,
      employeeLabel: config.employeeLabel,
      mode: `Live personal assistant as ${config.employeeLabel}. CRM, supply, knowledge and analytics within employee permissions. Supabase capture queues; no WhatsApp delivery.`,
    });
    console.log(`Real-data Ramesh playground: http://127.0.0.1:${server.port}`);
    console.log(
      'Supabase test queues + signed Context Engine. Delivery: CAPTURE ONLY. No WhatsApp session.',
    );
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      clearInterval(maintenance);
      await server.close();
      await chat.drain();
      await pool.end();
    };
    process.once('SIGINT', () => void stop());
    process.once('SIGTERM', () => void stop());
  } catch (error) {
    await pool.end();
    throw error;
  }
}
main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : '';
  console.error(/^[A-Z_]+$/.test(message) ? message : 'LIVE_PLAYGROUND_STARTUP_FAILED');
  process.exitCode = 1;
});
