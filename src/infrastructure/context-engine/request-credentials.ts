/** Employee-scoped first-party requests. No per-employee OAuth enrollment, storage or refresh. */
import { createHash, randomUUID } from 'node:crypto';
import { importJWK, SignJWT } from 'jose';
import { z } from 'zod';
import type { ContextEngineConfig } from '../../config/context-engine.js';
import { EmployeeIdentityResolver } from '../../modules/identity/employee-identity.js';
import {
  ContextEngineError,
  type ContextCredentialResolver,
  type ContextSender,
  type EmployeeRequestGrant,
} from '../../modules/context-engine/context.types.js';
import { cancellable } from '../../lib/cancellable.js';

const scopes = z
  .array(z.string().regex(/^[a-z][a-z0-9_.-]{0,63}:(?:read|write)$/))
  .min(1)
  .max(32)
  .refine((v) => new Set(v).size === v.length);
const signing = z
  .object({
    kid: z.string().regex(/^[A-Za-z0-9_-]{1,48}$/),
    privateKey: z
      .object({
        kty: z.literal('OKP'),
        crv: z.literal('Ed25519'),
        x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        d: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      })
      .strict(),
    scopes,
  })
  .strict();
export type ContextSigningConfig = z.infer<typeof signing>;

export function loadContextSigningConfig(
  env: NodeJS.ProcessEnv = process.env,
): ContextSigningConfig | undefined {
  if (!env.CONTEXT_RAMESH_SIGNING_KEY_JSON?.trim()) return undefined;
  try {
    return signing.parse(JSON.parse(env.CONTEXT_RAMESH_SIGNING_KEY_JSON));
  } catch {
    throw new ContextEngineError('NOT_CONFIGURED');
  }
}

export class SignedEmployeeCredentials implements ContextCredentialResolver {
  private readonly config: ContextSigningConfig;
  constructor(
    private readonly context: ContextEngineConfig,
    private readonly employees: EmployeeIdentityResolver,
    config: ContextSigningConfig,
  ) {
    try {
      this.config = signing.parse(config);
    } catch {
      throw new ContextEngineError('NOT_CONFIGURED');
    }
    if (!context.endpoint.endsWith('/mcp/ramesh')) throw new ContextEngineError('NOT_CONFIGURED');
  }

  async resolve(sender: ContextSender, caller: AbortSignal): Promise<EmployeeRequestGrant | null> {
    if (sender.audience !== 'dm') return null;
    const signal = AbortSignal.any([caller, AbortSignal.timeout(this.context.timeoutMs)]);
    try {
      return await cancellable(async () => {
        const employee = await this.employees.resolvePhone(sender.phoneE164, signal);
        if (!employee) return null;
        const key = await importJWK(this.config.privateKey, 'EdDSA');
        signal.throwIfAborted();
        const expiresAtMs = Date.now() + this.context.timeoutMs + 5000;
        return {
          kind: 'signed-request',
          employeeId: employee.employeeId,
          phoneE164: employee.phoneE164,
          active: true,
          expiresAtMs,
          authorize: async (request, requestSignal) => {
            requestSignal.throwIfAborted();
            if (
              request.method !== 'POST' ||
              request.url !== this.context.endpoint ||
              request.headers.has('origin') ||
              Date.now() >= expiresAtMs
            )
              throw new ContextEngineError('ACCESS_DENIED');
            const current = await this.employees.resolveEmployee(
              employee.employeeId,
              requestSignal,
            );
            if (
              !current ||
              current.phoneE164 !== employee.phoneE164 ||
              current.email !== employee.email
            )
              throw new ContextEngineError('AUTH_REQUIRED');
            const body = Buffer.from(await request.clone().arrayBuffer());
            if (body.length > 32768) throw new ContextEngineError('INVALID_ARGUMENTS');
            const now = Math.floor(Date.now() / 1000);
            const token = await new SignJWT({
              phone: employee.phoneE164,
              chat_type: 'dm',
              htm: 'POST',
              htu: this.context.endpoint,
              body_sha256: createHash('sha256').update(body).digest('base64url'),
              scopes: [...this.config.scopes],
            })
              .setProtectedHeader({ alg: 'EdDSA', typ: 'ramesh-request+jwt', kid: this.config.kid })
              .setIssuer('wareongo:ramesh')
              .setAudience(this.context.endpoint)
              .setSubject(String(employee.employeeId))
              .setIssuedAt(now)
              .setExpirationTime(now + 60)
              .setJti(randomUUID())
              .sign(key);
            requestSignal.throwIfAborted();
            const headers = new Headers(request.headers);
            headers.set('Authorization', `Ramesh ${token}`);
            return new Request(request, { headers });
          },
        };
      }, signal);
    } catch (error) {
      if (caller.aborted) throw new ContextEngineError('CANCELLED');
      if (signal.aborted) throw new ContextEngineError('TIMEOUT', true);
      if (error instanceof ContextEngineError) throw error;
      throw new ContextEngineError('UNAVAILABLE', true);
    }
  }
}
