/** Encrypted SQLite grant/PKCE storage with durable compare-and-swap fencing. Network calls never run in a DB transaction. */
import { createHash, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { authCipher } from './auth-store.js';
import { oauthScopesSchema, oauthTokensSchema } from '../context-engine/oauth-client.js';
import { ContextEngineError } from '../../modules/context-engine/context.types.js';
import type {
  GrantState,
  OAuthEnrollment,
  StoredEmployeeGrant,
  StoredGrant,
} from '../../modules/context-engine/oauth.types.js';

const binding = z.object({
  employeeId: z.number().int().positive(),
  phoneE164: z.string().regex(/^\+[1-9]\d{7,14}$/),
  email: z.string().email(),
  clientId: z.string().regex(/^wog_client_[A-Za-z0-9_-]{43}$/),
  resource: z.string().url(),
});
const grantSchema = binding.extend({
  ...oauthTokensSchema.shape,
  grantExpiresAtMs: z.number().int().positive(),
});
const enrollmentSchema = binding.extend({
  redirectUri: z.string().url(),
  verifier: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  scopes: oauthScopesSchema,
  startedAtMs: z.number().int().positive(),
});
const states = new Set(['ACTIVE', 'REFRESHING', 'REVOKE_PENDING', 'REVOKED']);

export class ContextCredentialStore {
  private readonly cipher: ReturnType<typeof authCipher>;
  readonly namespace: string;
  constructor(
    private readonly db: PrismaClient,
    encryptionKey: string,
    readonly accountId: string,
    readonly resource: string,
  ) {
    this.cipher = authCipher(encryptionKey);
    this.namespace = createHash('sha256')
      .update(JSON.stringify([accountId, resource]))
      .digest('hex');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(accountId)) throw new ContextEngineError('NOT_CONFIGURED');
  }
  grantId(employeeId: number) {
    return createHash('sha256')
      .update(JSON.stringify([this.accountId, this.resource, employeeId]))
      .digest('hex');
  }
  private open<T>(category: string, id: string, encrypted: string, schema: z.ZodType<T>): T {
    try {
      return schema.parse(
        this.cipher.open(category, `${this.accountId}|${this.resource}|${id}`, encrypted),
      );
    } catch {
      throw new ContextEngineError('AUTH_REQUIRED');
    }
  }
  private seal(category: string, id: string, value: unknown) {
    return this.cipher.seal(category, `${this.accountId}|${this.resource}|${id}`, value);
  }

  async read(employeeId: number): Promise<StoredGrant | null> {
    const id = this.grantId(employeeId);
    const row = await this.db.contextOAuthGrant.findUnique({ where: { id } });
    if (!row) return null;
    if (row.namespace !== this.namespace || row.employeeId !== employeeId || !states.has(row.state))
      throw new ContextEngineError('AUTH_REQUIRED');
    const value = row.encrypted
      ? this.open('context-grant', `${id}:${row.version}`, row.encrypted, grantSchema)
      : null;
    if (value && (value.employeeId !== employeeId || value.resource !== this.resource))
      throw new ContextEngineError('AUTH_REQUIRED');
    return {
      id,
      employeeId,
      state: row.state as GrantState,
      version: row.version,
      value,
      operation: row.operation,
      operationExpiresAtMs: row.operationExpiresAt?.getTime() ?? null,
    };
  }

  /** A new version authenticates the ciphertext too; stale readers cannot restore an old token. */
  async change(
    row: StoredGrant,
    state: GrantState,
    value: StoredEmployeeGrant | null,
    operation: string | null = null,
    operationExpiresAtMs: number | null = null,
  ) {
    if (value) grantSchema.parse(value);
    const version = row.version + 1;
    const result = await this.db.contextOAuthGrant.updateMany({
      where: { id: row.id, version: row.version, state: row.state },
      data: {
        state,
        version,
        encrypted: value ? this.seal('context-grant', `${row.id}:${version}`, value) : null,
        operation,
        operationExpiresAt: operationExpiresAtMs === null ? null : new Date(operationExpiresAtMs),
      },
    });
    return result.count === 1;
  }

  async begin(value: OAuthEnrollment) {
    enrollmentSchema.parse(value);
    const id = randomUUID();
    await this.db.contextOAuthEnrollment.create({
      data: {
        id,
        namespace: this.namespace,
        employeeId: value.employeeId,
        state: 'PENDING',
        encrypted: this.seal('context-enrollment', id, value),
        expiresAt: new Date(value.startedAtMs + 600_000),
      },
    });
    return id;
  }
  async enrollment(id: string, now: number) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new ContextEngineError('AUTH_REQUIRED');
    const row = await this.db.contextOAuthEnrollment.findUnique({ where: { id } });
    if (
      !row ||
      row.namespace !== this.namespace ||
      row.state !== 'PENDING' ||
      row.expiresAt.getTime() <= now ||
      !row.encrypted
    )
      throw new ContextEngineError('AUTH_REQUIRED');
    const value = this.open('context-enrollment', id, row.encrypted, enrollmentSchema);
    if (value.employeeId !== row.employeeId || value.resource !== this.resource)
      throw new ContextEngineError('AUTH_REQUIRED');
    return value;
  }
  async claimEnrollment(id: string, now: number) {
    return (
      (
        await this.db.contextOAuthEnrollment.updateMany({
          where: {
            id,
            namespace: this.namespace,
            state: 'PENDING',
            expiresAt: { gt: new Date(now) },
          },
          data: { state: 'EXCHANGING' },
        })
      ).count === 1
    );
  }
  async finishEnrollment(id: string) {
    await this.db.contextOAuthEnrollment.updateMany({
      where: { id, namespace: this.namespace },
      data: { state: 'CLOSED', encrypted: null },
    });
  }
  async closeEnrollments(employeeId: number) {
    await this.db.contextOAuthEnrollment.updateMany({
      where: { employeeId, namespace: this.namespace, state: { in: ['PENDING', 'EXCHANGING'] } },
      data: { state: 'CLOSED', encrypted: null },
    });
  }

  async install(enrollmentId: string, value: StoredEmployeeGrant, now: number) {
    grantSchema.parse(value);
    await this.db.$transaction(async (db) => {
      const consumed = await db.contextOAuthEnrollment.updateMany({
        where: {
          id: enrollmentId,
          namespace: this.namespace,
          employeeId: value.employeeId,
          state: 'EXCHANGING',
          expiresAt: { gt: new Date(now) },
        },
        data: { state: 'CLOSED', encrypted: null },
      });
      if (consumed.count !== 1) throw new ContextEngineError('AUTH_REQUIRED');
      const id = this.grantId(value.employeeId);
      const prior = await db.contextOAuthGrant.findUnique({ where: { id } });
      if (prior && prior.state !== 'REVOKED') throw new ContextEngineError('AUTH_REQUIRED');
      const version = (prior?.version ?? -1) + 1;
      const data = {
        namespace: this.namespace,
        employeeId: value.employeeId,
        state: 'ACTIVE',
        version,
        encrypted: this.seal('context-grant', `${id}:${version}`, value),
        operation: null,
        operationExpiresAt: null,
      };
      await db.contextOAuthGrant.upsert({ where: { id }, create: { id, ...data }, update: data });
    });
  }

  /** Expired/interrupted authorization codes are never retried; clear their PKCE secrets. */
  async cleanup(now: number) {
    await this.db.contextOAuthEnrollment.updateMany({
      where: {
        namespace: this.namespace,
        expiresAt: { lte: new Date(now) },
        encrypted: { not: null },
      },
      data: { state: 'CLOSED', encrypted: null },
    });
    await this.db.contextOAuthEnrollment.deleteMany({
      where: {
        namespace: this.namespace,
        state: 'CLOSED',
        expiresAt: { lt: new Date(now - 86_400_000) },
      },
    });
  }

  async queueRevocation(value: StoredEmployeeGrant) {
    grantSchema.parse(value);
    const id = randomUUID();
    await this.db.contextOAuthRevocation.create({
      data: {
        id,
        namespace: this.namespace,
        encrypted: this.seal('context-revocation', id, value),
      },
    });
    return id;
  }
  async revocations() {
    const rows = await this.db.contextOAuthRevocation.findMany({
      where: { namespace: this.namespace },
      orderBy: { createdAt: 'asc' },
      take: 10,
    });
    return rows.map((row) => ({
      id: row.id,
      value: this.open('context-revocation', row.id, row.encrypted, grantSchema),
    }));
  }
  async finishRevocation(id: string) {
    await this.db.contextOAuthRevocation.deleteMany({ where: { id, namespace: this.namespace } });
  }
  async pendingEmployees() {
    return this.db.contextOAuthGrant.findMany({
      where: { namespace: this.namespace, state: 'REVOKE_PENDING' },
      select: { employeeId: true },
      take: 10,
    });
  }
}
