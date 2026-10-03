/** Fixed-origin Context Engine OAuth. No consent automation, redirects, credential logging or token-request retries. */
import { z } from 'zod';
import { loadContextEngineConfig, type ContextEngineConfig } from '../../config/context-engine.js';
import { cancellable } from '../../lib/cancellable.js';
import { ContextEngineError } from '../../modules/context-engine/context.types.js';
import {
  CONTEXT_OAUTH_SCOPES,
  type ContextOAuthScope,
  type ContextOAuthTransport,
  type OAuthEnrollment,
  type OAuthTokens,
  type StoredEmployeeGrant,
} from '../../modules/context-engine/oauth.types.js';

export const oauthScopesSchema = z
  .array(z.enum(CONTEXT_OAUTH_SCOPES))
  .min(1)
  .max(CONTEXT_OAUTH_SCOPES.length)
  .refine((scopes) => new Set(scopes).size === scopes.length);
export const oauthTokensSchema = z.object({
  accessToken: z.string().regex(/^wog_mcp_at_[A-Za-z0-9_-]{43}$/),
  refreshToken: z.string().regex(/^wog_mcp_rt_[A-Za-z0-9_-]{43}$/),
  accessExpiresAtMs: z.number().int().positive(),
  scopes: oauthScopesSchema,
});

export class ContextOAuthClient implements ContextOAuthTransport {
  private readonly config: ContextEngineConfig;
  constructor(
    config: ContextEngineConfig,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    this.config = loadContextEngineConfig({
      CONTEXT_MCP_URL: config.endpoint,
      CONTEXT_MCP_TIMEOUT_MS: String(config.timeoutMs),
      CONTEXT_MCP_MAX_RESPONSE_BYTES: String(config.maxResponseBytes),
    })!;
  }

  private async request(
    action: 'register' | 'token' | 'revoke',
    body: Record<string, unknown> | URLSearchParams,
    caller: AbortSignal,
  ): Promise<unknown> {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), Math.min(this.config.timeoutMs, 15_000));
    const signal = AbortSignal.any([caller, deadline.signal]);
    try {
      return await cancellable(async () => {
        const form = body instanceof URLSearchParams;
        const response = await this.fetcher(new URL(`/oauth/${action}`, this.config.endpoint), {
          method: 'POST',
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
          signal,
          headers: {
            'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json',
            Accept: 'application/json',
          },
          body: form ? body.toString() : JSON.stringify(body),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new ContextEngineError(
            response.status === 429
              ? 'RATE_LIMITED'
              : response.status >= 500
                ? 'UNAVAILABLE'
                : 'AUTH_REQUIRED',
            response.status >= 500 || response.status === 429,
          );
        }
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          if (reader)
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              bytes += value.byteLength;
              if (bytes > 16_384) {
                await reader.cancel();
                throw new ContextEngineError('RESPONSE_TOO_LARGE');
              }
              chunks.push(value);
            }
        } finally {
          reader?.releaseLock();
        }
        if (action === 'revoke' && bytes === 0) return {};
        if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
          throw new ContextEngineError('INVALID_RESPONSE');
        try {
          return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
        } catch {
          throw new ContextEngineError('INVALID_RESPONSE');
        }
      }, signal);
    } catch (error) {
      if (caller.aborted) throw new ContextEngineError('CANCELLED');
      if (deadline.signal.aborted) throw new ContextEngineError('TIMEOUT', true);
      if (error instanceof ContextEngineError) throw error;
      throw new ContextEngineError('UNAVAILABLE', true);
    } finally {
      clearTimeout(timer);
    }
  }

  async register(redirectUri: string, scopes: readonly ContextOAuthScope[], signal: AbortSignal) {
    const result = z
      .object({
        client_id: z.string().regex(/^wog_client_[A-Za-z0-9_-]{43}$/),
        redirect_uris: z.array(z.string()),
        token_endpoint_auth_method: z.literal('none'),
      })
      .safeParse(
        await this.request(
          'register',
          {
            client_name: 'Ramesh employee context',
            redirect_uris: [redirectUri],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
            scope: scopes.join(' '),
          },
          signal,
        ),
      );
    if (
      !result.success ||
      result.data.redirect_uris.length !== 1 ||
      result.data.redirect_uris[0] !== redirectUri
    )
      throw new ContextEngineError('INVALID_RESPONSE');
    return result.data.client_id;
  }

  private async tokens(
    body: URLSearchParams,
    permitted: readonly ContextOAuthScope[],
    signal: AbortSignal,
  ): Promise<OAuthTokens> {
    const startedAt = this.now();
    const parsed = z
      .object({
        access_token: z.string(),
        refresh_token: z.string(),
        token_type: z.literal('Bearer'),
        expires_in: z.number().int().positive().max(900),
        scope: z.string().max(100),
        resource: z.literal(this.config.endpoint),
      })
      .safeParse(await this.request('token', body, signal));
    if (!parsed.success) throw new ContextEngineError('INVALID_RESPONSE');
    const value = oauthTokensSchema.safeParse({
      accessToken: parsed.data.access_token,
      refreshToken: parsed.data.refresh_token,
      accessExpiresAtMs: startedAt + parsed.data.expires_in * 1000,
      scopes: parsed.data.scope.split(' '),
    });
    if (!value.success || value.data.scopes.some((scope) => !permitted.includes(scope)))
      throw new ContextEngineError('INVALID_RESPONSE');
    return value.data;
  }

  exchange(enrollment: OAuthEnrollment, code: string, signal: AbortSignal) {
    return this.tokens(
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: enrollment.clientId,
        resource: this.config.endpoint,
        code,
        redirect_uri: enrollment.redirectUri,
        code_verifier: enrollment.verifier,
      }),
      enrollment.scopes,
      signal,
    );
  }

  async refresh(grant: StoredEmployeeGrant, signal: AbortSignal) {
    const value = await this.tokens(
      new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: grant.clientId,
        resource: this.config.endpoint,
        refresh_token: grant.refreshToken,
        scope: grant.scopes.join(' '),
      }),
      grant.scopes,
      signal,
    );
    if (value.refreshToken === grant.refreshToken) throw new ContextEngineError('INVALID_RESPONSE');
    return value;
  }

  async revoke(grant: StoredEmployeeGrant, signal: AbortSignal) {
    await this.request(
      'revoke',
      new URLSearchParams({
        token: grant.refreshToken,
        token_type_hint: 'refresh_token',
        client_id: grant.clientId,
      }),
      signal,
    );
  }
}
