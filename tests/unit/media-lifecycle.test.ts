import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { MediaService } from '../../src/modules/media/media.service.js';
import type {
  MediaStore,
  MediaRecord,
  MediaExtraction,
  MediaUpload,
} from '../../src/modules/media/media.types.js';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const upload: MediaUpload = {
  bytes: Buffer.from('OggS synthetic'),
  mime: 'audio/ogg',
  name: 'fixture.ogg',
};
class MemoryMedia implements MediaStore {
  readonly rows = new Map<string, MediaRecord>();
  readonly claims = new Map<string, number>();
  async put(owner: string, source: string, input: MediaUpload) {
    const id = randomUUID();
    this.rows.set(id, {
      id,
      owner,
      source,
      state: 'pending',
      upload: input,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 86400000),
    });
    return id;
  }
  async get(owner: string, ids?: string[]) {
    return [...this.rows.values()]
      .filter((row) => row.owner === owner && (!ids || ids.includes(row.id)))
      .map((row) => ({ ...row }));
  }
  async claim(owner: string, id: string) {
    const row = this.rows.get(id);
    if (!row || row.owner !== owner || row.state !== 'pending') return null;
    row.state = 'processing';
    row.token = randomUUID();
    this.claims.set(id, (this.claims.get(id) ?? 0) + 1);
    return { ...row };
  }
  async finish(owner: string, id: string, token: string, result: MediaExtraction) {
    const row = this.rows.get(id);
    if (!row || row.owner !== owner || row.token !== token) return;
    row.state = 'text' in result ? 'ready' : 'failed';
    Object.assign(row, result);
    delete row.token;
  }
  async clear(owner: string) {
    for (const row of this.rows.values()) if (row.owner === owner) this.rows.delete(row.id);
  }
  async clean() {}
}

test('CRM dates, notes and summaries do not select unrelated historical attachments', async () => {
  const store = new MemoryMedia();
  const media = new MediaService(store, {
    async extract() {
      return 'What is a CMS schema?';
    },
  });
  await media.ingest('owner', 'earlier-audio', upload);
  await media.drain();
  for (const request of [
    'CRM entries of yesterday',
    'Summarize these deals',
    'show the earlier notes',
    'Retry',
  ])
    assert.equal(await media.context('owner', [], request, AbortSignal.timeout(1000)), '', request);
  await media.stop();
});

test('an explicit singular voice reference selects the latest matching attachment only', async () => {
  const store = new MemoryMedia();
  const media = new MediaService(store, {
    async extract() {
      return 'Latest warehouse brief';
    },
  });
  const old = await media.ingest('owner', 'old-audio', upload);
  const current = await media.ingest('owner', 'new-audio', upload);
  await media.drain();
  store.rows.get(old)!.createdAt = new Date(Date.now() - 60000);
  const result = JSON.parse(
    await media.context('owner', [], 'use my previous voice note', AbortSignal.timeout(1000)),
  );
  assert.deepEqual(
    result.attachments.map((item: { attachment: string }) => item.attachment),
    [current],
  );
  assert.equal(
    await media.context('another-owner', [], 'use my voice note', AbortSignal.timeout(1000)),
    '',
  );
  const second = await media.ingest('owner', 'second-in-burst', upload);
  await media.drain();
  store.rows.get(old)!.createdAt = new Date(Date.now() - 3600000);
  store.rows.get(current)!.createdAt = new Date(Date.now() - 1000);
  const ordinal = JSON.parse(
    await media.context('owner', [], 'the second voice note', AbortSignal.timeout(1000)),
  );
  assert.deepEqual(
    ordinal.attachments.map((item: { attachment: string }) => item.attachment),
    [second],
  );
  await media.stop();
});

test('reader abort returns promptly without cancelling another reader or duplicating shared extraction', async () => {
  const store = new MemoryMedia();
  const started = gate(),
    finish = gate();
  let providerSignal: AbortSignal | undefined;
  const media = new MediaService(store, {
    async extract(_upload, signal) {
      providerSignal = signal;
      started.resolve();
      await finish.promise;
      return 'synthetic transcript';
    },
  });
  const id = await media.ingest('owner', 'source', upload);
  await started.promise;
  const cancelled = new AbortController();
  const first = media.context('owner', [id], 'summarize', cancelled.signal);
  const second = media.context('owner', [id], 'summarize', AbortSignal.timeout(1000));
  cancelled.abort();
  await assert.rejects(first, { name: 'AbortError' });
  assert.equal(providerSignal?.aborted, false);
  assert.equal(store.rows.get(id)?.state, 'processing');
  finish.resolve();
  assert.match(await second, /synthetic transcript/);
  assert.equal(store.claims.get(id), 1);
  await media.stop();
});

test('context deadline does not enqueue pending extraction behind occupied slots', async () => {
  const store = new MemoryMedia();
  const finish = gate();
  let calls = 0;
  const media = new MediaService(
    store,
    {
      async extract() {
        calls++;
        await finish.promise;
        return 'synthetic';
      },
    },
    20,
  );
  for (let index = 0; index < 3; index++) await media.ingest('owner', `active-${index}`, upload);
  const pending = await store.put('owner', 'not-yet-started', upload);
  const result = JSON.parse(
    await media.context('owner', [pending], 'summarize', AbortSignal.timeout(1000)),
  );
  assert.equal(result.attachments[0].status, 'pending');
  assert.equal(calls, 3);
  assert.equal(store.claims.has(pending), false);
  finish.resolve();
  await media.drain();
  await delay(10);
  assert.equal(store.claims.has(pending), false);
  await media.stop();
});

test('stop aborts active extraction, drains its settled state and never claims queued work', async () => {
  const store = new MemoryMedia();
  const media = new MediaService(store, {
    async extract(_upload, signal) {
      await delay(60000, undefined, { signal });
      return 'unreachable';
    },
  });
  const ids: string[] = [];
  for (let index = 0; index < 4; index++)
    ids.push(await media.ingest('owner', `source-${index}`, upload));
  const reader = media.context('owner', ids, 'summarize', new AbortController().signal);
  const rejected = assert.rejects(reader, { name: 'AbortError' });
  await media.stop();
  await rejected;
  assert.deepEqual(
    ids.map((id) => store.rows.get(id)?.state),
    ['failed', 'failed', 'failed', 'pending'],
  );
  assert.equal(store.claims.has(ids[3]!), false);
  assert.ok(ids.slice(0, 3).every((id) => !store.rows.get(id)?.token));
  await assert.rejects(media.ingest('owner', 'new', upload), { name: 'AbortError' });
  // An unclaimed pending row is still available to a new service after a restart.
  const restarted = new MediaService(store, {
    async extract() {
      return 'recovered queued media';
    },
  });
  assert.match(
    await restarted.context('owner', [ids[3]!], 'summarize', AbortSignal.timeout(1000)),
    /recovered queued media/,
  );
  await restarted.stop();
});

test('a claim completing during stop is settled without starting extraction', async () => {
  const claiming = gate();
  const finishClaim = gate();
  class DelayedClaimMedia extends MemoryMedia {
    override async claim(owner: string, id: string) {
      const row = await super.claim(owner, id);
      claiming.resolve();
      await finishClaim.promise;
      return row;
    }
  }
  const store = new DelayedClaimMedia();
  let calls = 0;
  const media = new MediaService(store, {
    async extract() {
      calls++;
      return 'must not start';
    },
  });
  const id = await media.ingest('owner', 'source', upload);
  await claiming.promise;
  const stopped = media.stop();
  finishClaim.resolve();
  await stopped;
  assert.equal(calls, 0);
  assert.equal(store.rows.get(id)?.state, 'failed');
  assert.equal(store.rows.get(id)?.token, undefined);
});
