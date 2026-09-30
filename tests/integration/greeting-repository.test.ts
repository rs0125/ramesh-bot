import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PrismaClient } from '@prisma/client';
import { GreetingService } from '../../src/modules/greetings/greeting.service.js';
import { PrismaGreetingRepository } from '../../src/infrastructure/database/greeting.repository.js';
import type { GreetingKey } from '../../src/modules/greetings/greeting.types.js';

test('Prisma deduplicates concurrent/replayed messages and retains uncertain sends', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'salesbot-test-'));
  const url = `file:${join(directory, 'test.db')}`;
  let db = new PrismaClient({ datasources: { db: { url } } });
  try {
    const migration = await readFile(
      new URL('../../prisma/migrations/20260930000000_initial/migration.sql', import.meta.url),
      'utf8',
    );
    await db.$executeRawUnsafe(migration);
    let service = new GreetingService(new PrismaGreetingRepository(db), 300_000);
    const greetOnce = async (key: GreetingKey, send: (to: string, text: string) => Promise<void>) =>
      (await service.handle(
        { ...key, fromMe: false, isGroup: false, mentionsBot: false, sentAtMs: Date.now() },
        (text) => send(key.chatId, text),
      )) === 'sent';
    const target = { chatId: '910000000002@s.whatsapp.net', messageId: 'same-message' };
    const sent: string[] = [];
    const send = async (to: string, text: string) => {
      sent.push(`${to}:${text}`);
    };
    const results = await Promise.all([greetOnce(target, send), greetOnce(target, send)]);
    assert.deepEqual(results.sort(), [false, true]);
    assert.deepEqual(sent, [`${target.chatId}:hello`]);

    await db.$disconnect();
    db = new PrismaClient({ datasources: { db: { url } } });
    service = new GreetingService(new PrismaGreetingRepository(db), 300_000);
    assert.equal(await greetOnce(target, send), false, 'claim survives a new connection/process');
    assert.equal(
      await greetOnce({ ...target, chatId: '120000000000@g.us' }, send),
      true,
      'same ID in another chat is independent',
    );

    const uncertain = { ...target, messageId: 'provider-timeout' };
    await assert.rejects(
      greetOnce(uncertain, async () => {
        throw new Error('timeout');
      }),
      /timeout/,
    );
    assert.equal(await greetOnce(uncertain, send), false, 'a timeout must not cause another send');
    assert.equal(
      (await db.greeting.findUniqueOrThrow({ where: { chatId_messageId: uncertain } })).status,
      'FAILED',
    );
    assert.equal(sent.length, 2);
  } finally {
    await db.$disconnect();
    await rm(directory, { recursive: true, force: true });
  }
});
