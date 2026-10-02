/** Synthetic SQLite playground. Use dev:chat:live for real Supabase/Context Engine reads. */
import { fileURLToPath } from 'node:url';
import { config as loadEnvironment } from 'dotenv';
import { loadAssistantConfig } from '../src/config/assistant.js';
import { OpenAITextModel } from '../src/infrastructure/openai/text-model.js';
import { LocalChat, openLocalChatDatabase } from './lib/local-chat.js';
import { createFollowupFixture } from './lib/followup-fixture.js';
import { startPlaygroundServer } from './lib/playground-server.js';

loadEnvironment({ path: new URL('../.env', import.meta.url), quiet: true });
const config = loadAssistantConfig();
if (!config)
  throw new Error('Set OPENAI_API_KEY in the worker .env before starting the playground');
const port = Number(process.env.PLAYGROUND_PORT ?? 3012);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('Invalid PLAYGROUND_PORT');
const db = await openLocalChatDatabase(
  fileURLToPath(new URL('../.local/playground.db', import.meta.url)),
);
const fixture =
  process.env.PLAYGROUND_CRM_FIXTURES === 'true' ? createFollowupFixture() : undefined;
const chat = new LocalChat(config, new OpenAITextModel(config), db, fixture);
const server = await startPlaygroundServer({
  port,
  model: config.model,
  chat,
  mode: fixture
    ? 'Synthetic CRM enabled. All lead data is fake.'
    : 'Synthetic mode. For real CRM and Supabase capture, start npm run dev:chat:live.',
});
console.log(`Synthetic Ramesh playground: http://127.0.0.1:${server.port}`);
console.log(
  'Isolated SQLite + captured transport. No WhatsApp, Supabase or Context Engine connection.',
);
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await server.close();
  await chat.drain();
  await db.$disconnect();
};
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
