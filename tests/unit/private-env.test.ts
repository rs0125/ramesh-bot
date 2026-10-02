import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'dotenv';
import { privateEnvironment } from '../../scripts/lib/private-env.js';

test('private configuration preserves JSON keys, literal escapes and multiline certificates', () => {
  const values = {
    SIGNING_KEY_JSON: JSON.stringify({ kid: 'fixture', privateKey: { x: 'fixture-only' } }),
    CERTIFICATE: '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n',
    LABEL: 'Raghav\'s "test" #1',
    ESCAPED: 'literal\\nnot-a-newline',
    DATABASE_URL: 'postgresql://fixture:unused@localhost/db?x=1#fragment',
    EMPTY: '',
  };
  assert.deepEqual(parse(privateEnvironment(values)), values);
  assert.throws(() => privateEnvironment({ 'INVALID\nNAME': 'fixture' }), /INVALID_ENVIRONMENT/);
});
