/** Employee-bound OAuth lifecycle. Unknown users still chat; only this resolver can supply business credentials. */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ContextEngineConfig } from '../../config/context-engine.js';
import { ContextCredentialStore } from '../../infrastructure/database/context-credentials.js';
import { cancellable } from '../../lib/cancellable.js';
import { EmployeeIdentityResolver, requireEmployeeEmail } from '../identity/employee-identity.js';
import {
  ContextEngineError,
  type ContextCredentialResolver,
  type ContextSender,
  type EmployeeContextGrant,
} from './context.types.js';
import {
  CONTEXT_OAUTH_SCOPES,
  type ContextOAuthScope,
  type ContextOAuthTransport,
  type StoredEmployeeGrant,
  type StoredGrant,
} from './oauth.types.js';

const secret = () => randomBytes(32).toString('base64url');
const matches = (left: string, right: string) =>
  /^[A-Za-z0-9_-]{43}$/.test(left) &&
  left.length === right.length &&
  timingSafeEqual(Buffer.from(left), Buffer.from(right));

export class EmployeeContextCredentials implements ContextCredentialResolver {
  constructor(
    private readonly config: ContextEngineConfig,
    private readonly employees: EmployeeIdentityResolver,
    private readonly store: ContextCredentialStore,
    private readonly oauth: ContextOAuthTransport,
    private readonly verify: (grant: StoredEmployeeGrant, signal: AbortSignal) => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {}

  private async run<T>(
    caller: AbortSignal | undefined,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.config.timeoutMs);
    const signal = caller ? AbortSignal.any([caller, deadline.signal]) : deadline.signal;
    try {
      return await cancellable(() => work(signal), signal);
    } catch (error) {
      if (caller?.aborted) throw new ContextEngineError('CANCELLED');
      if (deadline.signal.aborted) throw new ContextEngineError('TIMEOUT', true);
      if (error instanceof ContextEngineError) throw error;
      throw new ContextEngineError('UNAVAILABLE', true);
    } finally {
      clearTimeout(timer);
    }
  }

  private async bound(value: StoredEmployeeGrant, signal: AbortSignal) {
    const employee = await this.employees.resolveEmployee(value.employeeId, signal);
    return employee?.phoneE164 === value.phoneE164 && employee.email === value.email;
  }

  async beginEnrollment(
    employeeId: number,
    redirectUri: string,
    scopes: readonly ContextOAuthScope[] = ['crm:read'],
    caller?: AbortSignal,
  ) {
    return this.run(caller, async (signal) => {
      const url = new URL(redirectUri);
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (
        url.href !== redirectUri ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (url.protocol !== 'https:' &&
          !(local && url.protocol === 'http:' && this.config.endpoint.startsWith('http:'))) ||
        !scopes.length ||
        new Set(scopes).size !== scopes.length ||
        scopes.some((scope) => !CONTEXT_OAUTH_SCOPES.includes(scope))
      )
        throw new ContextEngineError('INVALID_ARGUMENTS');
      await this.store.cleanup(this.now());
      const employee = await this.employees.resolveEmployee(employeeId, signal);
      if (!employee) throw new ContextEngineError('AUTH_REQUIRED');
      const email = requireEmployeeEmail(employee);
      const existing = await this.store.read(employeeId);
      if (existing && existing.state !== 'REVOKED') throw new ContextEngineError('AUTH_REQUIRED');
      const clientId = await this.oauth.register(redirectUri, scopes, signal);
      signal.throwIfAborted();
      const verifier = secret(),
        state = secret();
      const enrollmentId = await this.store.begin({
        employeeId,
        phoneE164: employee.phoneE164,
        email,
        clientId,
        resource: this.config.endpoint,
        redirectUri,
        scopes: [...scopes],
        verifier,
        state,
        startedAtMs: this.now(),
      });
      const authorization = new URL('/oauth/authorize', this.config.endpoint);
      authorization.search = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        resource: this.config.endpoint,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
        scope: scopes.join(' '),
        state,
      }).toString();
      return { enrollmentId, authorizationUrl: authorization.href, expiresInSeconds: 600 };
    });
  }

  async completeEnrollment(enrollmentId: string, callbackUrl: string, caller?: AbortSignal) {
    return this.run(caller, async (signal) => {
      const enrollment = await this.store.enrollment(enrollmentId, this.now());
      if (callbackUrl.length > 4096) throw new ContextEngineError('INVALID_ARGUMENTS');
      const callback = new URL(callbackUrl),
        expected = new URL(enrollment.redirectUri);
      const params = callback.searchParams;
      if (
        callback.origin !== expected.origin ||
        callback.pathname !== expected.pathname ||
        callback.username ||
        callback.password ||
        callback.hash ||
        [...params.keys()].some(
          (key) =>
            !['state', 'code', 'error', 'error_description'].includes(key) ||
            params.getAll(key).length !== 1,
        ) ||
        !matches(params.get('state') ?? '', enrollment.state)
      )
        throw new ContextEngineError('AUTH_REQUIRED');
      if (params.has('error')) {
        await this.store.finishEnrollment(enrollmentId);
        throw new ContextEngineError('AUTH_REQUIRED');
      }
      const code = params.get('code') ?? '';
      if (!/^wog_mcp_code_[A-Za-z0-9_-]{43}$/.test(code))
        throw new ContextEngineError('AUTH_REQUIRED');
      const employee = await this.employees.resolveEmployee(enrollment.employeeId, signal);
      if (
        !employee ||
        employee.phoneE164 !== enrollment.phoneE164 ||
        employee.email !== enrollment.email
      )
        throw new ContextEngineError('AUTH_REQUIRED');
      if (!(await this.store.claimEnrollment(enrollmentId, this.now())))
        throw new ContextEngineError('AUTH_REQUIRED');
      let candidate: StoredEmployeeGrant | undefined;
      try {
        const tokens = await this.oauth.exchange(enrollment, code, signal);
        candidate = {
          ...tokens,
          employeeId: enrollment.employeeId,
          phoneE164: enrollment.phoneE164,
          email: enrollment.email,
          clientId: enrollment.clientId,
          resource: enrollment.resource,
          // Server may expire the grant earlier with its underlying key. This upper bound never extends at refresh.
          grantExpiresAtMs: enrollment.startedAtMs + 30 * 86_400_000,
        };
        if (
          tokens.accessExpiresAtMs <= this.now() + Math.max(60_000, this.config.timeoutMs + 5000) ||
          !(await this.bound(candidate, signal))
        )
          throw new ContextEngineError('AUTH_REQUIRED');
        await this.verify(candidate, signal);
        signal.throwIfAborted();
        if (!(await this.bound(candidate, signal))) throw new ContextEngineError('AUTH_REQUIRED');
        await this.store.install(enrollmentId, candidate, this.now());
        return {
          employeeId: candidate.employeeId,
          state: 'ACTIVE' as const,
          scopes: candidate.scopes,
        };
      } catch (error) {
        if (candidate) await this.store.queueRevocation(candidate);
        await this.store.finishEnrollment(enrollmentId);
        throw error;
      }
    });
  }

  async resolve(sender: ContextSender, caller: AbortSignal): Promise<EmployeeContextGrant | null> {
    if (sender.audience !== 'dm') return null;
    const phoneE164 = sender.phoneE164;
    return this.run(caller, async (signal) => {
      const employee = await this.employees.lookupPhone(phoneE164, signal);
      if (!employee) return null;
      for (;;) {
        signal.throwIfAborted();
        const row = await this.store.read(employee.employeeId);
        if (!row || row.state === 'REVOKED' || row.state === 'REVOKE_PENDING' || !row.value)
          return null;
        const value = row.value;
        if (
          !employee.active ||
          value.phoneE164 !== phoneE164 ||
          value.email !== employee.email ||
          value.grantExpiresAtMs <= this.now() ||
          !(await this.bound(value, signal))
        ) {
          if (await this.store.change(row, 'REVOKE_PENDING', value)) return null;
          continue;
        }
        if (row.state === 'REFRESHING') {
          if (!row.operationExpiresAtMs || row.operationExpiresAtMs <= this.now()) {
            // A previous process may have consumed this refresh token. Never replay it.
            if (await this.store.change(row, 'REVOKE_PENDING', value)) return null;
          } else await delay(50, undefined, { signal });
          continue;
        }
        if (
          value.accessExpiresAtMs <=
          this.now() + Math.max(60_000, this.config.timeoutMs + 5000)
        ) {
          await this.refresh(row, signal);
          continue;
        }
        signal.throwIfAborted();
        // Detect a concurrent local revocation while checking the roster.
        const latest = await this.store.read(employee.employeeId);
        if (latest?.version !== row.version || latest.state !== 'ACTIVE') continue;
        return {
          employeeId: value.employeeId,
          phoneE164,
          active: true,
          accessToken: value.accessToken,
          expiresAtMs: Math.min(value.accessExpiresAtMs, value.grantExpiresAtMs),
        };
      }
    });
  }

  private async refresh(row: StoredGrant, signal: AbortSignal) {
    const operation = randomUUID();
    if (
      !(await this.store.change(
        row,
        'REFRESHING',
        row.value,
        operation,
        this.now() + this.config.timeoutMs + 5000,
      ))
    )
      return;
    const claimed = await this.store.read(row.employeeId);
    if (!claimed?.value || claimed.operation !== operation || claimed.state !== 'REFRESHING')
      return;
    let refreshed: StoredEmployeeGrant | undefined;
    try {
      signal.throwIfAborted();
      const tokens = await this.oauth.refresh(claimed.value, signal);
      refreshed = { ...claimed.value, ...tokens };
      if (
        tokens.accessExpiresAtMs <= this.now() + Math.max(60_000, this.config.timeoutMs + 5000) ||
        !(await this.bound(refreshed, signal))
      )
        throw new ContextEngineError('AUTH_REQUIRED');
      signal.throwIfAborted();
      if (!(await this.store.change(claimed, 'ACTIVE', refreshed))) {
        await this.store.queueRevocation(refreshed);
        throw new ContextEngineError('AUTH_REQUIRED');
      }
    } catch (error) {
      // Even a timeout/5xx can follow a committed rotation. Only explicit enrollment can restore access.
      await this.store.change(claimed, 'REVOKE_PENDING', refreshed ?? claimed.value);
      throw error;
    }
  }

  /** Called after a 401 from MCP. An old failed call must not invalidate a newly rotated grant. */
  async invalidate(grant: EmployeeContextGrant) {
    const row = await this.store.read(grant.employeeId);
    if (
      row?.state === 'ACTIVE' &&
      row.value?.accessToken === grant.accessToken &&
      row.value.phoneE164 === grant.phoneE164
    )
      await this.store.change(row, 'REVOKE_PENDING', row.value);
  }

  async revoke(employeeId: number, caller?: AbortSignal) {
    return this.run(caller, async (signal) => {
      await this.store.closeEnrollments(employeeId);
      for (;;) {
        const row = await this.store.read(employeeId);
        if (!row || row.state === 'REVOKED') return { revoked: true };
        if (row.state !== 'REVOKE_PENDING') {
          if (!(await this.store.change(row, 'REVOKE_PENDING', row.value))) continue;
          continue;
        }
        // Local access has already stopped, even if remote revocation is unavailable.
        if (row.value) await this.oauth.revoke(row.value, signal);
        if (await this.store.change(row, 'REVOKED', null)) return { revoked: true };
      }
    });
  }

  async retryRevocations(caller?: AbortSignal) {
    return this.run(caller, async (signal) => {
      let completed = 0;
      for (const row of await this.store.pendingEmployees()) {
        await this.revoke(row.employeeId, signal);
        completed++;
      }
      for (const item of await this.store.revocations()) {
        await this.oauth.revoke(item.value, signal);
        await this.store.finishRevocation(item.id);
        completed++;
      }
      await this.store.cleanup(this.now());
      return { completed };
    });
  }

  async status(employeeId: number) {
    return this.run(undefined, async () => {
      const row = await this.store.read(employeeId);
      return {
        employeeId,
        state: row?.state ?? 'NOT_ENROLLED',
        ...(row?.value
          ? {
              accessExpiresAtMs: row.value.accessExpiresAtMs,
              grantExpiresAtMs: row.value.grantExpiresAtMs,
              scopes: row.value.scopes,
            }
          : {}),
      };
    });
  }
}
