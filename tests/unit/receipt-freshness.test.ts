/** Delivery deadlines use a fake clock and synthetic source reads. No providers or transport. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { BusinessReadService } from '../../src/modules/assistant/business-reads.js';
import { toolDelivery } from '../../src/modules/assistant/tool-evidence.js';
import { followupsDelivery, verifyFollowups } from '../../src/modules/assistant/followups.js';
import { followupEvidence } from '../../scripts/lib/followup-fixture.js';
import type { ContextEvidence } from '../../src/modules/context-engine/context.types.js';

const key = { remoteJid: '919000000023@s.whatsapp.net', fromMe: false };
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

for (const scenario of [
  { name: 'expiry', start: '2026-10-02T06:00:00Z', before: 299_000, during: 1_000, allowed: false },
  {
    name: 'India midnight',
    start: '2026-10-02T18:29:59Z',
    before: 0,
    during: 1_000,
    allowed: false,
  },
  {
    name: 'still fresh',
    start: '2026-10-02T06:00:00Z',
    before: 1_000,
    during: 1_000,
    allowed: true,
  },
]) {
  test(`general tool receipt is checked again after asynchronous reads: ${scenario.name}`, async () => {
    let now = Date.parse(scenario.start);
    const started = gate();
    const resume = gate();
    const evidence = (): ContextEvidence => ({
      source_path: '/api/v1/warehouses/filters',
      status: 200,
      meta: { requestId: 'fixture-request', generatedAt: new Date(now).toISOString() },
      data: { cities: ['Fixture City'] },
    });
    const receipt = toolDelivery(
      23,
      [
        {
          id: 'fixture-evidence',
          tool: 'warehouse_filters',
          arguments: {},
          result: evidence(),
        },
      ],
      now,
    );
    const service = new BusinessReadService(
      async () => ({
        employeeId: 23,
        search: async () => {
          throw new Error('Unexpected legacy read');
        },
        tools: {
          employeeId: 23,
          discover: async () => [],
          call: async () => {
            started.release();
            await resume.promise;
            // Identity and source data are unchanged; only the saved reply's clock expires.
            return evidence();
          },
        },
      }),
      'all',
      () => now,
      true,
    );
    now += scenario.before;
    const failures: string[] = [];
    const pending = service.canDeliver(key, receipt, new AbortController().signal, (reason) =>
      failures.push(reason),
    );
    await started.promise;
    now += scenario.during;
    resume.release();
    assert.equal(await pending, scenario.allowed);
    assert.deepEqual(failures, scenario.allowed ? [] : ['INVALID_OR_EXPIRED_RECEIPT']);
  });
}

for (const scenario of [
  { name: 'expiry', start: '2026-10-02T06:00:00Z', before: 299_000, during: 1_000 },
  { name: 'India midnight', start: '2026-10-02T18:29:59Z', before: 0, during: 1_000 },
]) {
  test(`legacy follow-up receipt is checked after the final identity read: ${scenario.name}`, async () => {
    let now = Date.parse(scenario.start);
    const receipt = followupsDelivery(23, verifyFollowups(followupEvidence(now), now), now);
    const started = gate();
    const resume = gate();
    let resolutions = 0;
    const service = new BusinessReadService(
      async () => {
        if (++resolutions === 2) {
          started.release();
          await resume.promise;
        }
        return { employeeId: 23, search: async () => followupEvidence(now) };
      },
      'all',
      () => now,
    );
    now += scenario.before;
    const failures: string[] = [];
    const pending = service.canDeliver(key, receipt, new AbortController().signal, (reason) =>
      failures.push(reason),
    );
    await started.promise;
    now += scenario.during;
    resume.release();
    assert.equal(await pending, false);
    assert.deepEqual(failures, ['INVALID_OR_EXPIRED_RECEIPT']);
  });
}
