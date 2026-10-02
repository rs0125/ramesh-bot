/** Fake transport only; normal delivery must never become a read/played receipt. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DeliveryReceipts } from '../../src/infrastructure/whatsapp/delivery-receipts.js';

const message = (id: string) => ({ key: { remoteJid: '100@g.us', participant: '222@lid', id } });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('delivery acknowledgements preserve the trusted sender and never request a read receipt', async () => {
  const calls: unknown[] = [];
  const receipts = new DeliveryReceipts(
    async (...args) => {
      calls.push(args);
    },
    () => assert.fail(),
  );
  receipts.acknowledge(message('one'));
  receipts.acknowledge({ key: { ...message('self').key, fromMe: true } });
  receipts.acknowledge({ key: { remoteJid: '100@g.us' } });
  await receipts.close();
  receipts.acknowledge(message('closed'));
  assert.deepEqual(calls, [['100@g.us', '222@lid', ['one'], undefined]]);
});

test('stalled receipt writes are bounded and never block admission of the next message', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ids: string[] = [];
  let failures = 0;
  const receipts = new DeliveryReceipts(
    async (_jid, _participant, messages) => {
      ids.push(...messages);
      await held;
    },
    () => {
      failures++;
    },
    2,
    10,
  );
  receipts.acknowledge(message('one'));
  receipts.acknowledge(message('two'));
  receipts.acknowledge(message('full'));
  await tick();
  assert.deepEqual(ids, ['one', 'two']);
  await new Promise((resolve) => setTimeout(resolve, 20));
  receipts.acknowledge(message('still-full'));
  assert.equal(failures, 4);
  await receipts.close();
  release();
  await tick();
});

test('failed writes are observed and release capacity', async () => {
  let failures = 0;
  const receipts = new DeliveryReceipts(
    async () => {
      throw new Error('transport detail must stay private');
    },
    () => {
      failures++;
    },
    1,
  );
  receipts.acknowledge(message('one'));
  await tick();
  receipts.acknowledge(message('two'));
  await receipts.close();
  assert.equal(failures, 2);
});
