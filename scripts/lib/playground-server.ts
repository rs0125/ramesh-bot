/** Shared loopback-only UI for synthetic and live-read capture adapters. No transport composition. */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { SALES_PROMPT_VERSION } from '../../src/modules/assistant/sales-prompts.js';
import { MAX_MEDIA_BYTES, type MediaUpload } from '../../src/modules/media/media.types.js';
import type { AgentTrace } from '../../src/modules/assistant/assistant.types.js';
import type { VoiceTranscript } from '../../src/modules/media/voice-reply.js';
import { HttpError, jsonBody } from '../../src/infrastructure/http/json-body.js';
import type { LocalChatInput } from './local-chat.js';

export interface PlaygroundChat {
  send(
    input: LocalChatInput,
    signal?: AbortSignal,
  ): Promise<{
    text: string;
    trace: AgentTrace;
    outcome: string;
    queueId?: string;
    responseText?: string;
    transcripts?: VoiceTranscript[];
  }>;
  clear(input: Omit<LocalChatInput, 'text'>): void | Promise<void>;
  upload?(
    input: Omit<LocalChatInput, 'text'>,
    file: MediaUpload,
    sourceId: string,
  ): Promise<string>;
}
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
export async function startPlaygroundServer(options: {
  port: number;
  model: string;
  mode: string;
  live?: boolean;
  employeeLabel?: string;
  chat: PlaygroundChat;
}) {
  const token = randomBytes(32).toString('hex');
  const html = (await readFile(new URL('../../playground/index.html', import.meta.url), 'utf8'))
    .replaceAll('__PLAYGROUND_TOKEN__', token)
    .replaceAll('__MODEL__', escape(options.model))
    .replaceAll('__CRM_MODE__', escape(options.mode))
    .replaceAll('__EMPLOYEE__', escape(options.employeeLabel ?? 'You'))
    .replaceAll(
      '__ASSISTANT_ROLE__',
      options.live ? 'Personal chief of staff' : 'Converser + formatter',
    )
    .replaceAll(
      '__SECOND_ACTOR__',
      options.live ? 'Unknown user (no business access)' : 'Test teammate',
    )
    .replaceAll(
      '__STORAGE__',
      options.live
        ? 'Real CRM, supply, knowledge and analytics reads. Replies are captured in Supabase test queues. Nothing goes to WhatsApp.'
        : 'SQLite + a fake chat transport. Nothing here goes to WhatsApp.',
    );
  const assets = new Map([
    [
      '/app.js',
      [
        'application/javascript',
        await readFile(new URL('../../playground/app.js', import.meta.url), 'utf8'),
      ],
    ],
    [
      '/style.css',
      ['text/css', await readFile(new URL('../../playground/style.css', import.meta.url), 'utf8')],
    ],
  ]);
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
      const port = (server.address() as AddressInfo).port;
      if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(request.headers.host ?? ''))
        throw new HttpError(403, 'Local access only');
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
      if (
        request.method !== 'POST' ||
        !['/api/chat', '/api/reset', '/api/media', '/api/status'].includes(path ?? '')
      )
        throw new HttpError(404, 'Not found');
      if (request.headers['x-playground-token'] !== token)
        throw new HttpError(403, 'Refresh the playground');
      if (
        request.headers.origin &&
        ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(request.headers.origin)
      )
        throw new HttpError(403, 'Local access only');
      if (path === '/api/status') {
        response.setHeader('Content-Type', 'application/json');
        response.end(
          JSON.stringify({
            delivery: options.live ? 'capture' : 'sqlite',
            whatsapp: false,
            model: options.model,
            promptVersion: SALES_PROMPT_VERSION,
            media: !!options.chat.upload,
          }),
        );
        return;
      }
      const body = await jsonBody(request, path === '/api/media' ? 12 * 1024 * 1024 : 32768);
      if (
        typeof body.conversation !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,100}$/.test(body.conversation) ||
        !['me', 'teammate'].includes(String(body.sender)) ||
        typeof body.group !== 'boolean'
      )
        throw new HttpError(400, 'Invalid chat');
      // Reject actor/destination substitutions instead of silently accepting misleading fields.
      const allowed =
        path === '/api/chat'
          ? ['conversation', 'sender', 'group', 'text', 'messageId', 'forwarded', 'mediaIds']
          : path === '/api/media'
            ? ['conversation', 'sender', 'group', 'name', 'mime', 'data', 'sourceId']
            : ['conversation', 'sender', 'group'];
      if (Object.keys(body).some((key) => !allowed.includes(key)))
        throw new HttpError(400, 'Unsupported chat field');
      const identity = {
        conversation: body.conversation,
        sender: String(body.sender),
        group: body.group,
      };
      response.setHeader('Content-Type', 'application/json');
      if (path === '/api/media') {
        if (
          !options.chat.upload ||
          typeof body.name !== 'string' ||
          body.name.length > 256 ||
          typeof body.mime !== 'string' ||
          body.mime.length > 100 ||
          typeof body.sourceId !== 'string' ||
          typeof body.data !== 'string' ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(body.data)
        )
          throw new HttpError(400, 'Invalid attachment');
        const bytes = Buffer.from(body.data, 'base64');
        if (
          !bytes.length ||
          bytes.length > MAX_MEDIA_BYTES ||
          bytes.toString('base64') !== body.data
        )
          throw new HttpError(400, 'Attachment must be at most 8 MB');
        try {
          const id = await options.chat.upload(
            identity,
            { bytes, mime: body.mime, name: body.name },
            body.sourceId,
          );
          response.end(JSON.stringify({ id }));
        } catch {
          throw new HttpError(
            400,
            'Could not accept this attachment. Use an image, PDF or voice note of up to 8 MB.',
          );
        }
        return;
      }
      if (body.forwarded !== undefined && typeof body.forwarded !== 'boolean')
        throw new HttpError(400, 'Invalid forwarding flag');
      if (
        body.mediaIds !== undefined &&
        (!Array.isArray(body.mediaIds) ||
          body.mediaIds.length > 1 ||
          body.mediaIds.some(
            (id) =>
              typeof id !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id),
          ))
      )
        throw new HttpError(400, 'Invalid attachments');
      if (path === '/api/reset') {
        await options.chat.clear(identity);
        response.end('{"ok":true}');
        return;
      }
      if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 6000)
        throw new HttpError(400, 'Enter a message of up to 6000 characters');
      if (
        body.messageId !== undefined &&
        (typeof body.messageId !== 'string' ||
          !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(body.messageId))
      )
        throw new HttpError(400, 'Invalid request ID');
      const result = await options.chat.send(
        {
          ...identity,
          text: body.text,
          messageId: body.messageId as string | undefined,
          forwarded: body.forwarded as boolean | undefined,
          mediaIds: body.mediaIds as string[] | undefined,
        },
        abort.signal,
      );
      response.end(
        JSON.stringify({
          text: result.text,
          trace: result.trace,
          outcome: result.outcome,
          queueId: result.queueId,
          responseText: result.responseText,
          transcripts: result.transcripts,
        }),
      );
    })().catch((error: unknown) => {
      if (response.destroyed) return;
      response.writeHead(error instanceof HttpError ? error.status : 500, {
        'Content-Type': 'application/json',
      });
      response.end(
        JSON.stringify({
          error:
            error instanceof HttpError
              ? error.message
              : 'Could not process that message. Try again.',
        }),
      );
    });
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    port: (server.address() as AddressInfo).port,
    async close() {
      for (const abort of active) abort.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
