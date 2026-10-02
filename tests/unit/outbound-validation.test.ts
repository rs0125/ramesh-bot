import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../../src/config/env.js';
import {
  MAX_OUTBOUND_MEDIA_BYTES,
  OutboundValidationError,
  parseOutboundAutomationRequest as parse,
  validIdempotencyKey,
} from '../../src/modules/messaging/outbound-validation.js';

const to = '+919876543210';
const pdf = {
  mimeType: 'application/pdf',
  fileName: 'brochure.pdf',
  dataBase64: Buffer.from('%PDF-1.7\nsynthetic fixture').toString('base64'),
};
test('automation validates normalized text, attachment-only and bounded expiry', () => {
  assert.deepEqual(parse({ to, text: ' Reminder \n' }), {
    to,
    text: 'Reminder',
    expiresInSeconds: 900,
  });
  assert.deepEqual(parse({ to, media: pdf, expiresInSeconds: 86400 }), {
    to,
    text: '',
    media: pdf,
    expiresInSeconds: 86400,
  });
  for (const patch of [
    { to: '919876543210' },
    { to: '+0123456789' },
    { to: '123@s.whatsapp.net' },
    { to: '123@g.us' },
    { to: '+123' },
    { to: '+1234567890123456' },
    { text: '' },
    { text: 'x'.repeat(4001) },
    { text: '\u0000' },
    { expiresInSeconds: 29 },
    { expiresInSeconds: 86401 },
    { expiresInSeconds: 30.5 },
    { expiresInSeconds: '900' },
    { url: 'https://example.test/document.pdf' },
  ])
    assert.throws(() => parse({ to, text: 'Reminder', ...patch }), OutboundValidationError);
  assert.equal(validIdempotencyKey('crm:followup:123:2026-10-03'), true);
  for (const key of ['', 'a b', 'a\nb', 'x'.repeat(129), ['a'], '❌'])
    assert.equal(validIdempotencyKey(key), false);
});
test('media rejects URL fetching, traversal, MIME mismatches and noncanonical base64', () => {
  for (const patch of [
    { url: 'http://169.254.169.254/' },
    { fileName: '../secret.pdf' },
    { fileName: 'a\\b.pdf' },
    { fileName: '\u202Efdp.exe' },
    { fileName: 'a\nb.pdf' },
    { fileName: '' },
    { fileName: '.' },
    { mimeType: 'text/html' },
    { mimeType: ['application/pdf'] },
    { mimeType: {} },
    { mimeType: 'image/png' },
    { dataBase64: '!!!!' },
    { dataBase64: `${pdf.dataBase64}\n` },
    { dataBase64: 'data:application/pdf;base64,' + pdf.dataBase64 },
  ])
    assert.throws(() => parse({ to, media: { ...pdf, ...patch } }), OutboundValidationError);
  const oversize = Buffer.alloc(MAX_OUTBOUND_MEDIA_BYTES + 1, 1).toString('base64');
  assert.throws(
    () => parse({ to, media: { ...pdf, dataBase64: oversize } }),
    (error: unknown) => error instanceof OutboundValidationError && error.status === 413,
  );
  const png = {
    mimeType: 'image/png',
    fileName: 'plan.png',
    dataBase64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64'),
  };
  assert.equal(parse({ to, media: png, text: 'x'.repeat(1024) }).text.length, 1024);
  assert.throws(() => parse({ to, media: png, text: 'x'.repeat(1025) }), /captions/);
});
test('automation credential is opt-in, separate and requires durable Supabase storage', () => {
  const base = {
    DATABASE_URL: 'file:./test.db',
    AUTH_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64url'),
    WORKER_API_TOKEN: 'x'.repeat(32),
  };
  const key = Buffer.alloc(32, 2).toString('base64url');
  assert.equal(loadConfig(base).api.automationKey, undefined);
  assert.throws(() => loadConfig({ ...base, RAMESH_AUTOMATION_API_KEY: key }), /Supabase/);
  const db = {
    ...base,
    MESSAGE_DATABASE_URL: 'postgresql://ramesh_worker.project:secret@example.com/postgres',
  };
  assert.equal(loadConfig({ ...db, RAMESH_AUTOMATION_API_KEY: key }).api.automationKey, key);
  for (const invalid of ['short', key + '=', 'a'.repeat(43)])
    assert.throws(
      () => loadConfig({ ...db, RAMESH_AUTOMATION_API_KEY: invalid }),
      /32 random bytes/,
    );
  assert.throws(
    () => loadConfig({ ...db, WORKER_API_TOKEN: key, RAMESH_AUTOMATION_API_KEY: key }),
    /differ/,
  );
});
