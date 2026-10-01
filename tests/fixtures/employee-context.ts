/** Synthetic OAuth/MCP transport plus real encrypted SQLite. No real roster, credentials, model, or WhatsApp connection. */
import { createHash, randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { temporaryDatabase } from './database.js';
import { createEmployeeContextAccess } from '../../src/app/context-engine.js';
import { ContextCredentialStore } from '../../src/infrastructure/database/context-credentials.js';
import type {
  EmployeeRoster,
  RosterEmployee,
} from '../../src/modules/identity/employee-identity.js';

export const phone = '+919876543210';
export const sender = { phoneE164: phone, audience: 'dm' as const };
export const config = {
  endpoint: 'https://context.example/mcp',
  timeoutMs: 5000,
  maxResponseBytes: 16384,
};
export const callback = 'https://ramesh.example/oauth/callback';
export const fakeToken = (prefix: string, seed = 'initial') =>
  prefix + createHash('sha256').update(seed).digest('base64url');
export async function employeeContextFixture() {
  const database = await temporaryDatabase();
  const key = randomBytes(32).toString('base64url');
  const extraClients: PrismaClient[] = [];
  const rows: RosterEmployee[] = [
    { id: 23, phone_number: phone.slice(1), email: 'employee@wareongo.com', is_active: true },
  ];
  const roster: EmployeeRoster = {
    async byPhone(value) {
      return rows.filter((row) => row.phone_number.replace(/^\+/, '') === value.slice(1));
    },
    async byId(value) {
      return rows.filter((row) => row.id === value);
    },
  };
  const state = {
    employeeId: 23,
    refreshes: 0,
    exchanges: 0,
    revokes: 0,
    failRefresh: false,
    failRevoke: false,
    denyMcp: false,
    afterRefresh: undefined as (() => Promise<void>) | undefined,
    afterExchange: undefined as (() => Promise<void>) | undefined,
  };
  let sequence = 0;
  type Grant = { employeeId: number; active: boolean; client: string; scopes: string };
  const access = new Map<string, Grant>(),
    refresh = new Map<string, { grant: Grant; used: boolean }>();
  const issue = (grant: Grant) => {
    const n = String(++sequence),
      accessToken = fakeToken('wog_mcp_at_', n),
      refreshToken = fakeToken('wog_mcp_rt_', n);
    access.set(accessToken, grant);
    refresh.set(refreshToken, { grant, used: false });
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: 900,
      resource: config.endpoint,
      scope: grant.scopes,
    };
  };
  const calls: { path: string; body: unknown }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init),
      path = new URL(request.url).pathname;
    if (request.redirect !== 'error') throw new Error('Redirects must be denied');
    if (path.startsWith('/oauth/')) {
      const json = path === '/oauth/register';
      const body = json
        ? ((await request.json()) as Record<string, unknown>)
        : Object.fromEntries(new URLSearchParams(await request.text()));
      calls.push({ path, body });
      if (request.headers.has('authorization'))
        throw new Error('Public OAuth client must not send bearer credentials');
      if (json)
        return Response.json(
          {
            client_id: fakeToken('wog_client_', String(++sequence)),
            redirect_uris: body.redirect_uris,
            token_endpoint_auth_method: 'none',
          },
          { status: 201 },
        );
      if (path === '/oauth/revoke') {
        state.revokes++;
        if (state.failRevoke)
          return Response.json({ error_description: 'secret-fixture-error' }, { status: 503 });
        const existing = refresh.get(String(body.token));
        if (existing) existing.grant.active = false;
        return Response.json({});
      }
      if (body.grant_type === 'authorization_code') {
        state.exchanges++;
        const tokens = issue({
          employeeId: state.employeeId,
          active: true,
          client: String(body.client_id),
          scopes: 'crm:read',
        });
        await state.afterExchange?.();
        return Response.json(tokens);
      }
      state.refreshes++;
      if (state.failRefresh)
        return Response.json({ error_description: 'secret-fixture-error' }, { status: 500 });
      const found = refresh.get(String(body.refresh_token));
      if (!found || found.used || !found.grant.active || found.grant.client !== body.client_id) {
        if (found) found.grant.active = false;
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      found.used = true;
      const tokens = issue(found.grant);
      await state.afterRefresh?.();
      return Response.json(tokens);
    }
    const grant = access.get((request.headers.get('authorization') ?? '').replace(/^Bearer /, ''));
    if (!grant?.active || state.denyMcp)
      return Response.json({ error: 'fixture' }, { status: 401 });
    if (request.method === 'GET') return new Response(null, { status: 405 });
    const rpc = (await request.json()) as {
      method: string;
      id?: string;
      params?: Record<string, unknown>;
    };
    calls.push({ path, body: rpc });
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    let result: unknown;
    if (rpc.method === 'initialize')
      result = {
        protocolVersion: rpc.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'fixture', version: '1' },
      };
    else if (rpc.method === 'tools/list')
      result = {
        tools: ['get_context', 'search_crm_leads'].map((name) => ({
          name,
          inputSchema: { type: 'object' },
          annotations: { readOnlyHint: true },
        })),
      };
    else
      result = {
        content: [],
        structuredContent: {
          source_path: '/api/v1/context',
          status: 200,
          data: { employee_id: grant.employeeId, scopes: grant.scopes.split(' '), read_only: true },
          meta: { requestId: 'fixture', generatedAt: new Date().toISOString() },
        },
      };
    return Response.json({ jsonrpc: '2.0', id: rpc.id, result });
  };
  const make = (fresh = false) => {
    const db = fresh
      ? new PrismaClient({ datasources: { db: { url: `file:${database.path}` } } })
      : database.db;
    if (fresh) extraClients.push(db);
    return createEmployeeContextAccess(config, {
      db,
      encryptionKey: key,
      accountId: 'primary',
      roster,
      fetcher,
    });
  };
  const app = make();
  const store = new ContextCredentialStore(database.db, key, 'primary', config.endpoint);
  const start = () => app.credentials.beginEnrollment(23, callback);
  const callbackFor = (started: { authorizationUrl: string }) => {
    const url = new URL(callback);
    url.search = new URLSearchParams({
      state: new URL(started.authorizationUrl).searchParams.get('state')!,
      code: fakeToken('wog_mcp_code_'),
    }).toString();
    return url.href;
  };
  const enroll = async () => {
    const begun = await start();
    await app.credentials.completeEnrollment(begun.enrollmentId, callbackFor(begun));
    return begun;
  };
  const expireAccess = async () => {
    const row = (await store.read(23))!;
    await store.change(row, 'ACTIVE', { ...row.value!, accessExpiresAtMs: Date.now() - 1000 });
  };
  return {
    ...database,
    key,
    rows,
    state,
    calls,
    fetcher,
    roster,
    app,
    store,
    make,
    start,
    callbackFor,
    enroll,
    expireAccess,
    async close() {
      await Promise.all(extraClients.map((client) => client.$disconnect()));
      await database.close();
    },
  };
}
