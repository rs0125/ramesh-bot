/** Real SQLite migrations/encryption/fencing with synthetic OAuth and the actual MCP client. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { employeeContextFixture, sender, callback, config } from '../fixtures/employee-context.js';
import { ContextCredentialStore } from '../../src/infrastructure/database/context-credentials.js';
import { authCipher } from '../../src/infrastructure/database/auth-store.js';

const signal = () => new AbortController().signal;
const message = (jid = '919876543210@s.whatsapp.net') => ({
  key: { remoteJid: jid, fromMe: false },
});

test('phone and LID identities use the actual transport sender and reciprocal encrypted SDK mappings', async () => {
  const f = await employeeContextFixture();
  try {
    assert.equal(
      (await f.app.whatsapp.resolve(message('919876543210:3@s.whatsapp.net'), signal()))?.employee
        .employeeId,
      23,
    );
    assert.equal(
      await f.app.whatsapp.resolve(message('919999999999@s.whatsapp.net'), signal()),
      null,
    );
    assert.equal(
      await f.app.whatsapp.resolve(
        { key: { remoteJid: '919876543210@s.whatsapp.net', fromMe: true } },
        signal(),
      ),
      null,
    );
    assert.equal(
      await f.app.whatsapp.resolve(
        {
          key: {
            remoteJid: '100@g.us',
            participant: '999@lid',
            participantAlt: '919876543210@s.whatsapp.net',
          },
        },
        signal(),
      ),
      null,
    );
    const cipher = authCipher(f.key);
    await f.db.whatsAppAuthEntry.create({
      data: {
        category: 'lid-mapping',
        keyId: '999_reverse',
        encrypted: cipher.seal('lid-mapping', '999_reverse', '919876543210'),
      },
    });
    assert.equal(await f.app.whatsapp.resolve(message('999@lid'), signal()), null);
    await f.db.whatsAppAuthEntry.create({
      data: {
        category: 'lid-mapping',
        keyId: '919876543210',
        encrypted: cipher.seal('lid-mapping', '919876543210', '999'),
      },
    });
    const resolved = await f.make(true).whatsapp.resolve(message('999:2@lid'), signal());
    assert.equal(resolved?.employee.employeeId, 23);
    const group = await f.app.whatsapp.resolve(
      { key: { remoteJid: '100@g.us', participant: '999@lid' } },
      signal(),
    );
    assert.equal(group?.sender.audience, 'group');
    assert.equal(
      await f.app.forMessage({ key: { remoteJid: '100@g.us', participant: '999@lid' } }),
      null,
    );
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

test('unknown, inactive, duplicate and un-enrolled employees have no business credential', async () => {
  const f = await employeeContextFixture();
  try {
    assert.equal(await f.app.credentials.resolve(sender, signal()), null);
    assert.equal(await f.app.forMessage(message('919999999999@s.whatsapp.net')), null);
    assert.equal(await f.app.credentials.resolve({ ...sender, audience: 'group' }, signal()), null);
    f.rows[0]!.is_active = false;
    assert.equal(await f.app.whatsapp.resolve(message(), signal()), null);
    f.rows[0]!.is_active = true;
    f.rows.push({ ...f.rows[0]!, id: 24 });
    assert.equal(await f.app.credentials.resolve(sender, signal()), null);
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

test('PKCE enrollment verifies remote employee identity, encrypts credentials, and consumes the callback once', async () => {
  const f = await employeeContextFixture();
  try {
    const begun = await f.start(),
      url = new URL(begun.authorizationUrl);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('scope'), 'crm:read');
    const bad = new URL(f.callbackFor(begun));
    bad.searchParams.set('state', 'x'.repeat(43));
    await assert.rejects(
      f.app.credentials.completeEnrollment(begun.enrollmentId, bad.href),
      /AUTH_REQUIRED/,
    );
    assert.equal(f.state.exchanges, 0);
    await f.app.credentials.completeEnrollment(begun.enrollmentId, f.callbackFor(begun));
    const grant = await f.app.credentials.resolve(sender, signal());
    assert.equal(grant?.employeeId, 23);
    const raw = JSON.stringify(await f.db.contextOAuthGrant.findMany());
    const saved = (await f.store.read(23))!.value!;
    for (const secret of [saved.accessToken, saved.refreshToken, saved.email, saved.phoneE164])
      assert.ok(!raw.includes(secret));
    assert.equal(
      (await f.db.contextOAuthEnrollment.findUnique({ where: { id: begun.enrollmentId } }))
        ?.encrypted,
      null,
    );
    await assert.rejects(
      f.app.credentials.completeEnrollment(begun.enrollmentId, f.callbackFor(begun)),
      /AUTH_REQUIRED/,
    );
    assert.equal(f.state.exchanges, 1);
    assert.equal(
      (await f.make(true).credentials.resolve(sender, signal()))?.accessToken,
      grant!.accessToken,
    );
  } finally {
    await f.close();
  }
});

test('wrong callback origin, repeated params, stale enrollment and wrong employee grant fail closed', async () => {
  const f = await employeeContextFixture();
  try {
    const begun = await f.start(),
      valid = f.callbackFor(begun);
    await assert.rejects(
      f.app.credentials.completeEnrollment(
        begun.enrollmentId,
        valid.replace('ramesh.example', 'evil.example'),
      ),
      /AUTH_REQUIRED/,
    );
    await assert.rejects(
      f.app.credentials.completeEnrollment(begun.enrollmentId, valid + '&code=second'),
      /AUTH_REQUIRED/,
    );
    f.state.employeeId = 99;
    await assert.rejects(
      f.app.credentials.completeEnrollment(begun.enrollmentId, valid),
      /ACCESS_DENIED/,
    );
    assert.equal(await f.app.credentials.resolve(sender, signal()), null);
    assert.equal(await f.db.contextOAuthRevocation.count(), 1);
    await f.app.credentials.retryRevocations();
    assert.equal(f.state.revokes, 1);
    assert.equal(await f.db.contextOAuthRevocation.count(), 0);
    const expired = await f.start();
    await f.db.contextOAuthEnrollment.update({
      where: { id: expired.enrollmentId },
      data: { expiresAt: new Date(0) },
    });
    await assert.rejects(
      f.app.credentials.completeEnrollment(expired.enrollmentId, f.callbackFor(expired)),
      /AUTH_REQUIRED/,
    );
    assert.equal(f.state.exchanges, 1);
  } finally {
    await f.close();
  }
});

test('concurrent resolvers rotate once across independent SQLite connections and never extend grant lifetime', async () => {
  const f = await employeeContextFixture();
  try {
    await f.enroll();
    await f.expireAccess();
    const before = (await f.store.read(23))!.value!;
    const other = f.make(true);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        (i % 2 ? other : f.app).credentials.resolve(sender, signal()),
      ),
    );
    assert.equal(f.state.refreshes, 1);
    assert.ok(results.every((result) => result?.accessToken === results[0]!.accessToken));
    const after = (await f.store.read(23))!.value!;
    assert.notEqual(after.refreshToken, before.refreshToken);
    assert.equal(after.grantExpiresAtMs, before.grantExpiresAtMs);
    assert.equal(
      (await f.make(true).credentials.resolve(sender, signal()))?.accessToken,
      after.accessToken,
    );
  } finally {
    await f.close();
  }
});

test('interrupted refreshes and ambiguous HTTP failures require reconnecting instead of replaying tokens', async () => {
  const f = await employeeContextFixture();
  try {
    await f.enroll();
    await f.expireAccess();
    f.state.failRefresh = true;
    await assert.rejects(
      f.app.credentials.resolve(sender, signal()),
      (error: Error) => error.message === 'Context Engine: UNAVAILABLE',
    );
    assert.equal((await f.app.credentials.status(23)).state, 'REVOKE_PENDING');
    f.state.failRefresh = false;
    assert.equal(await f.make(true).credentials.resolve(sender, signal()), null);
    assert.equal(f.state.refreshes, 1);
    await f.app.credentials.revoke(23);
    await f.enroll();
    const row = (await f.store.read(23))!;
    await f.store.change(row, 'REFRESHING', row.value, 'interrupted-operation', Date.now() - 1);
    assert.equal(await f.make(true).credentials.resolve(sender, signal()), null);
    assert.equal(f.state.refreshes, 1);
  } finally {
    await f.close();
  }
});

test('local revocation stops access before remote success and persists retryable revocation across restart', async () => {
  const f = await employeeContextFixture();
  try {
    await f.enroll();
    f.state.failRevoke = true;
    await assert.rejects(f.app.credentials.revoke(23), /UNAVAILABLE/);
    assert.equal(await f.app.credentials.resolve(sender, signal()), null);
    assert.equal((await f.app.credentials.status(23)).state, 'REVOKE_PENDING');
    f.state.failRevoke = false;
    await f.make(true).credentials.retryRevocations();
    assert.equal((await f.store.read(23))!.value, null);
    assert.equal((await f.app.credentials.status(23)).state, 'REVOKED');
    await f.app.credentials.revoke(23);
  } finally {
    await f.close();
  }
});

test('a concurrent revocation cannot be undone by a late refresh result', async () => {
  const f = await employeeContextFixture();
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await f.enroll();
    await f.expireAccess();
    f.state.afterRefresh = async () => {
      entered();
      await hold;
    };
    const refreshing = f.app.credentials.resolve(sender, signal());
    const rejected = assert.rejects(refreshing, /AUTH_REQUIRED/);
    await ready;
    await f.make(true).credentials.revoke(23);
    release();
    await rejected;
    assert.equal(await f.app.credentials.resolve(sender, signal()), null);
    assert.equal((await f.app.credentials.status(23)).state, 'REVOKED');
    await f.app.credentials.retryRevocations();
  } finally {
    release?.();
    await f.close();
  }
});

test('inactive employees, changed email/phone, reassigned numbers and expired grants cannot inherit access', async () => {
  for (const change of ['inactive', 'email', 'phone', 'reassigned', 'expiry']) {
    const f = await employeeContextFixture();
    try {
      await f.enroll();
      if (change === 'inactive') f.rows[0]!.is_active = false;
      if (change === 'email') f.rows[0]!.email = 'replacement@wareongo.com';
      if (change === 'phone') f.rows[0]!.phone_number = '919876543211';
      if (change === 'reassigned') f.rows[0]!.id = 99;
      if (change === 'expiry') {
        const row = (await f.store.read(23))!;
        await f.store.change(row, 'ACTIVE', { ...row.value!, grantExpiresAtMs: Date.now() - 1 });
      }
      assert.equal(await f.app.credentials.resolve(sender, signal()), null, change);
      if (change === 'phone')
        assert.equal(
          await f.app.credentials.resolve({ ...sender, phoneE164: '+919876543211' }, signal()),
          null,
        );
      assert.equal(f.state.refreshes, 0);
    } finally {
      await f.close();
    }
  }
});

test('revoking an in-flight enrollment prevents its late callback from restoring access', async () => {
  const f = await employeeContextFixture();
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const begun = await f.start();
    f.state.afterExchange = async () => {
      entered();
      await hold;
    };
    const completing = f.app.credentials.completeEnrollment(
      begun.enrollmentId,
      f.callbackFor(begun),
    );
    const rejected = assert.rejects(completing, /AUTH_REQUIRED/);
    await ready;
    await f.make(true).credentials.revoke(23);
    release();
    await rejected;
    assert.equal(await f.app.credentials.resolve(sender, signal()), null);
    assert.equal(await f.db.contextOAuthRevocation.count(), 1);
    await f.app.credentials.retryRevocations();
    assert.equal(f.state.revokes, 1);
  } finally {
    release?.();
    await f.close();
  }
});

test('MCP 401 invalidates the matching local grant; stale failures cannot revoke a newer rotation', async () => {
  const f = await employeeContextFixture();
  try {
    await f.enroll();
    const old = (await f.app.credentials.resolve(sender, signal()))!;
    await f.expireAccess();
    const current = await f.app.credentials.resolve(sender, signal());
    await f.app.credentials.invalidate(old);
    assert.equal(
      (await f.app.credentials.resolve(sender, signal()))?.accessToken,
      current!.accessToken,
    );
    const services = (await f.app.forMessage(message()))!;
    f.state.denyMcp = true;
    await assert.rejects(services.context(), /AUTH_REQUIRED/);
    assert.equal((await f.app.credentials.status(23)).state, 'REVOKE_PENDING');
  } finally {
    await f.close();
  }
});

test('wrong encryption keys, swapped ciphertext, cross-account attempts and aborted calls fail closed', async () => {
  const f = await employeeContextFixture();
  try {
    const started = await f.enroll();
    const wrong = new ContextCredentialStore(
      f.db,
      randomBytes(32).toString('base64url'),
      'primary',
      config.endpoint,
    );
    await assert.rejects(wrong.read(23), /AUTH_REQUIRED/);
    const foreign = new ContextCredentialStore(f.db, f.key, 'another-account', config.endpoint);
    assert.equal(await foreign.read(23), null);
    await assert.rejects(foreign.enrollment(started.enrollmentId, Date.now()), /AUTH_REQUIRED/);
    const encrypted = (await f.db.contextOAuthGrant.findUnique({
      where: { id: f.store.grantId(23) },
    }))!;
    await f.db.contextOAuthGrant.create({
      data: { ...encrypted, id: f.store.grantId(24), employeeId: 24 },
    });
    await assert.rejects(f.store.read(24), /AUTH_REQUIRED/);
    const controller = new AbortController();
    controller.abort();
    const before = f.calls.length;
    await assert.rejects(f.app.credentials.resolve(sender, controller.signal), /CANCELLED/);
    assert.equal(f.calls.length, before);
    await assert.rejects(f.app.credentials.beginEnrollment(23, callback), /AUTH_REQUIRED/);
  } finally {
    await f.close();
  }
});
