/** Loopback-only chat playground. Uses isolated SQLite and a fake transport, never createApplication(). */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { config as loadEnvironment } from 'dotenv';
import { loadAssistantConfig } from '../src/config/assistant.js';
import { OpenAITextModel } from '../src/infrastructure/openai/text-model.js';
import { HttpError, jsonBody } from '../src/infrastructure/http/json-body.js';
import { LocalChat, openLocalChatDatabase } from './lib/local-chat.js';

loadEnvironment({ path: new URL('../.env', import.meta.url), quiet: true });
const config = loadAssistantConfig();
if (!config)
  throw new Error('Set OPENAI_API_KEY in the worker .env before starting the playground');
const port = Number(process.env.PLAYGROUND_PORT ?? 3012);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('Invalid PLAYGROUND_PORT');
// These paths intentionally ignore DATABASE_URL, MESSAGE_DATABASE_URL, account keys, and pairing state.
const db = await openLocalChatDatabase(
  fileURLToPath(new URL('../.local/playground.db', import.meta.url)),
);
const chat = new LocalChat(config, new OpenAITextModel(config), db);
const token = randomBytes(32).toString('hex');
const html = (await readFile(new URL('../playground/index.html', import.meta.url), 'utf8'))
  .replaceAll('__PLAYGROUND_TOKEN__', token)
  .replaceAll('__MODEL__', config.model);
const assets = new Map([
  [
    '/app.js',
    [
      'application/javascript',
      await readFile(new URL('../playground/app.js', import.meta.url), 'utf8'),
    ],
  ],
  [
    '/style.css',
    ['text/css', await readFile(new URL('../playground/style.css', import.meta.url), 'utf8')],
  ],
]);
const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
const active = new Set<AbortController>();
const server = createServer((request, response) => {
  const abort = new AbortController();
  active.add(abort);
  response.on('close', () => {
    active.delete(abort);
    if (!response.writableEnded) abort.abort();
  });
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
  );
  void (async () => {
    if (!hosts.has(request.headers.host ?? '')) throw new HttpError(403, 'Local access only');
    const path = request.url?.split('?')[0];
    if (request.method === 'GET' && path === '/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(html);
      return;
    }
    const asset = assets.get(path ?? '');
    if (request.method === 'GET' && asset) {
      response.setHeader('Content-Type', `${asset[0]}; charset=utf-8`);
      response.end(asset[1]);
      return;
    }
    if (request.method !== 'POST' || !['/api/chat', '/api/reset'].includes(path ?? ''))
      throw new HttpError(404, 'Not found');
    if (request.headers['x-playground-token'] !== token)
      throw new HttpError(403, 'Refresh the playground');
    if (
      request.headers.origin &&
      ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(request.headers.origin)
    )
      throw new HttpError(403, 'Local access only');
    const body = await jsonBody(request, 32_768);
    if (
      typeof body.conversation !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(body.conversation) ||
      !['me', 'teammate'].includes(String(body.sender)) ||
      typeof body.group !== 'boolean'
    )
      throw new HttpError(400, 'Invalid chat');
    const identity = {
      conversation: body.conversation,
      sender: String(body.sender),
      group: body.group,
    };
    response.setHeader('Content-Type', 'application/json');
    if (path === '/api/reset') {
      chat.clear(identity);
      response.end('{"ok":true}');
      return;
    }
    if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 6000)
      throw new HttpError(400, 'Enter a message of up to 6000 characters');
    const result = await chat.send({ ...identity, text: body.text }, abort.signal);
    response.end(JSON.stringify({ text: result.text, trace: result.trace }));
  })().catch((error: unknown) => {
    if (response.destroyed) return;
    response.writeHead(error instanceof HttpError ? error.status : 500, {
      'Content-Type': 'application/json',
    });
    response.end(
      JSON.stringify({
        error:
          error instanceof HttpError ? error.message : 'Could not process that message. Try again.',
      }),
    );
  });
});
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.listen(port, '127.0.0.1', () => {
  console.log(`Ramesh playground: http://127.0.0.1:${port}`);
  console.log(
    `Model: ${config.model}. Isolated SQLite + simulated transport. No WhatsApp connection.`,
  );
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  for (const controller of active) controller.abort();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await chat.drain();
  await db.$disconnect();
}
process.on('SIGINT', () => {
  void stop();
});
process.on('SIGTERM', () => {
  void stop();
});
