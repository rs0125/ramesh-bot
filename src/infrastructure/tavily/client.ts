/** Public search/extraction only. The worker contacts Tavily, never the supplied URL. */
import { isIP } from 'node:net';
import { z } from 'zod';
import { cancellable } from '../../lib/cancellable.js';

export class WebToolError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export function publicWebUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WebToolError('INVALID_PUBLIC_URL');
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (
    value.length > 2048 ||
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    isIP(host) ||
    !host.includes('.') ||
    !/^[a-z0-9.-]+$/.test(host) ||
    /(^|\.)(localhost|local|internal|lan|home|test|invalid|onion)$/.test(host) ||
    [...url.searchParams.keys()].some((key) =>
      /token|secret|password|signature|credential|api.?key|authorization/i.test(key),
    )
  )
    throw new WebToolError('INVALID_PUBLIC_URL');
  url.hash = '';
  return url.href;
}

export const webSearchInput = z
  .object({
    query: z.string().trim().min(1).max(300),
    max_results: z.number().int().min(1).max(5).optional(),
    topic: z.enum(['general', 'news']).optional(),
    time_range: z.enum(['day', 'week', 'month', 'year']).optional(),
  })
  .strict();
export const readWebpageInput = z
  .object({
    url: z.string().trim().min(1).max(2048),
    max_characters: z.number().int().min(1000).max(20000).optional(),
  })
  .strict();

const usage = z.object({ credits: z.number().finite().nonnegative() }).optional();
const searchResponse = z.object({
  results: z
    .array(
      z.object({
        title: z.string(),
        url: z.string(),
        content: z.string(),
        published_date: z.string().nullable().optional(),
      }),
    )
    .max(20),
  usage,
});
const extractResponse = z.object({
  results: z.array(z.object({ url: z.string(), raw_content: z.string() })).max(20),
  failed_results: z.array(z.object({ url: z.string() })).max(20),
  usage,
});
const MAX_RESPONSE_BYTES = 1024 * 1024;

export class TavilyClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now = Date.now,
  ) {}

  private async request(endpoint: 'search' | 'extract', body: object, signal: AbortSignal) {
    signal.throwIfAborted();
    const deadline = AbortSignal.timeout(15000);
    const combined = AbortSignal.any([signal, deadline]);
    try {
      const response = await cancellable(
        () =>
          this.fetcher(`https://api.tavily.com/${endpoint}`, {
            method: 'POST',
            redirect: 'error',
            signal: combined,
            headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }),
        combined,
      );
      combined.throwIfAborted();
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new WebToolError(
          [401, 403].includes(response.status)
            ? 'WEB_AUTH_FAILED'
            : [402, 432, 433].includes(response.status)
              ? 'WEB_QUOTA_EXCEEDED'
              : response.status === 429
                ? 'WEB_RATE_LIMITED'
                : 'WEB_UNAVAILABLE',
        );
      }
      if (!response.headers.get('content-type')?.includes('application/json') || !response.body) {
        void response.body?.cancel().catch(() => {});
        throw new WebToolError('INVALID_WEB_RESPONSE');
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          combined.throwIfAborted();
          const chunk = await cancellable(() => reader.read(), combined);
          combined.throwIfAborted();
          if (chunk.done) break;
          bytes += chunk.value.length;
          if (bytes > MAX_RESPONSE_BYTES) throw new WebToolError('WEB_RESPONSE_TOO_LARGE');
          chunks.push(chunk.value);
        }
      } finally {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch (error) {
      signal.throwIfAborted();
      if (deadline.aborted) throw new WebToolError('WEB_TIMEOUT');
      if (error instanceof WebToolError) throw error;
      // Never forward response bodies, headers or exception messages to the model/logs.
      throw new WebToolError('WEB_UNAVAILABLE');
    }
  }

  async search(args: z.infer<typeof webSearchInput>, signal: AbortSignal) {
    const raw = await this.request(
      'search',
      {
        query: args.query,
        max_results: args.max_results ?? 5,
        topic: args.topic ?? 'general',
        ...(args.time_range ? { time_range: args.time_range } : {}),
        search_depth: 'basic',
        auto_parameters: false,
        include_answer: false,
        include_raw_content: false,
        include_images: false,
        include_published_date: true,
        include_usage: true,
      },
      signal,
    );
    const parsed = searchResponse.safeParse(raw);
    if (!parsed.success) throw new WebToolError('INVALID_WEB_RESPONSE');
    const results = parsed.data.results.slice(0, args.max_results ?? 5).flatMap((item) => {
      try {
        return [
          {
            title: item.title.slice(0, 300),
            url: publicWebUrl(item.url),
            content: item.content.slice(0, 1800),
            content_truncated: item.content.length > 1800,
            ...(item.published_date ? { published_date: item.published_date.slice(0, 100) } : {}),
          },
        ];
      } catch {
        return [];
      }
    });
    return {
      provider: 'tavily',
      query: args.query,
      fetched_at: new Date(this.now()).toISOString(),
      results,
      omitted_results: parsed.data.results.length - results.length,
      credits_used: parsed.data.usage?.credits ?? null,
    };
  }

  async read(args: z.infer<typeof readWebpageInput>, signal: AbortSignal) {
    const url = publicWebUrl(args.url);
    const raw = await this.request(
      'extract',
      {
        urls: [url],
        extract_depth: 'basic',
        format: 'text',
        include_images: false,
        include_usage: true,
        timeout: 10,
      },
      signal,
    );
    const parsed = extractResponse.safeParse(raw);
    if (!parsed.success) throw new WebToolError('INVALID_WEB_RESPONSE');
    const matches = (candidate: string) => {
      try {
        return publicWebUrl(candidate) === url;
      } catch {
        return false;
      }
    };
    if (parsed.data.failed_results.some((item) => matches(item.url)))
      throw new WebToolError('PAGE_UNAVAILABLE');
    const item = parsed.data.results.find((item) => matches(item.url));
    if (!item?.raw_content.trim()) throw new WebToolError('PAGE_UNAVAILABLE');
    const max = args.max_characters ?? 12000;
    return {
      provider: 'tavily',
      url,
      fetched_at: new Date(this.now()).toISOString(),
      content: item.raw_content.slice(0, max),
      content_truncated: item.raw_content.length > max,
      credits_used: parsed.data.usage?.credits ?? null,
    };
  }
}
