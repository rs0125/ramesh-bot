/** Real PostgreSQL verifies canonical roster matching and the exact column-level grant, with no production access. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { postgresTestsEnabled, temporaryMessageDatabase } from '../fixtures/message-database.js';
import { grantIdentityRosterRead } from '../../scripts/identity-roster.js';
import { PostgresEmployeeRoster } from '../../src/infrastructure/database/employee-roster.js';
import { EmployeeIdentityResolver } from '../../src/modules/identity/employee-identity.js';

test(
  'live RLS roster lookup requires one active canonical phone and only four SELECT column privileges',
  { skip: !postgresTestsEnabled },
  async () => {
    const f = await temporaryMessageDatabase();
    try {
      await f.admin
        .query(`CREATE TABLE public."VerifiedNumber" (id integer PRIMARY KEY, phone_number text UNIQUE,
      email text, is_active boolean, "adminAccess" boolean DEFAULT false)`);
      await f.admin.query('ALTER TABLE public."VerifiedNumber" ENABLE ROW LEVEL SECURITY');
      await f.admin.query(`INSERT INTO public."VerifiedNumber" (id,phone_number,email,is_active)
      VALUES (23,'919876543210','Employee@wareongo.com',true)`);
      const resolver = new EmployeeIdentityResolver(new PostgresEmployeeRoster(f.runtime));
      const signal = new AbortController().signal;
      await assert.rejects(resolver.resolvePhone('+919876543210', signal), /UNAVAILABLE/);
      const admin = await f.admin.connect();
      try {
        await grantIdentityRosterRead(admin);
        await grantIdentityRosterRead(admin); // Repeat provisioning must preserve the same policy.
      } finally {
        admin.release();
      }
      assert.deepEqual(await resolver.resolvePhone('+919876543210', signal), {
        employeeId: 23,
        phoneE164: '+919876543210',
        email: 'employee@wareongo.com',
        active: true,
      });
      await assert.rejects(
        f.runtime.query('SELECT * FROM public."VerifiedNumber"'),
        /permission denied/,
      );
      await assert.rejects(
        f.runtime.query('UPDATE public."VerifiedNumber" SET is_active=false'),
        /permission denied/,
      );
      for (const phone of ['+91 98765-43210', '9876543210', '09876543210']) {
        await f.admin.query('UPDATE public."VerifiedNumber" SET phone_number=$1 WHERE id=23', [
          phone,
        ]);
        assert.equal((await resolver.resolvePhone('+919876543210', signal))?.employeeId, 23);
      }
      await f.admin.query(`INSERT INTO public."VerifiedNumber" (id,phone_number,email,is_active)
      VALUES (24,'+919876543210','duplicate@wareongo.com',false)`);
      assert.equal(await resolver.resolvePhone('+919876543210', signal), null);
      assert.equal(await resolver.resolveEmployee(23, signal), null);
      await f.admin.query('DELETE FROM public."VerifiedNumber" WHERE id=24');
      await f.admin.query('UPDATE public."VerifiedNumber" SET is_active=false WHERE id=23');
      assert.equal(await resolver.resolvePhone('+919876543210', signal), null);
      await f.admin.query(
        `UPDATE public."VerifiedNumber" SET phone_number='919876543211',is_active=true WHERE id=23`,
      );
      assert.equal(await resolver.resolvePhone('+919876543210', signal), null);
      assert.equal((await resolver.resolvePhone('+919876543211', signal))?.employeeId, 23);
      assert.equal(await resolver.resolvePhone("+919876543210' OR true --", signal), null);
    } finally {
      await f.close();
    }
  },
);
