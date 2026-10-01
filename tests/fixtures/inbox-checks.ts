/** Inbox assertions share the queue suite's isolated PostgreSQL database and restricted runtime role. */
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { WAMessage } from '@whiskeysockets/baileys';
import type { temporaryMessageDatabase } from './message-database.js';
import { InboxRepository } from '../../src/infrastructure/database/inbox.repository.js';
import { MessageQueueRepository } from '../../src/infrastructure/database/message-queue.repository.js';
import { DurableMessages } from '../../src/infrastructure/whatsapp/durable-messages.js';
import { toInboxCandidate } from '../../src/infrastructure/whatsapp/message.mapper.js';
import { AssistantService } from '../../src/modules/assistant/assistant.service.js';
import type { ModelRequest } from '../../src/modules/assistant/assistant.types.js';
import type { WhatsAppSession } from '../../src/infrastructure/whatsapp/baileys-session.js';
import { selectGreetingTarget } from '../../src/modules/greetings/greeting.policy.js';

const botJids = ['10000000000@s.whatsapp.net'];
const group = '123456@g.us';
function message(text: string, sender = 'alice', mentioned = false, chatId = group): WAMessage {
  return {
    key: { id: randomUUID(), remoteJid: chatId, participant: `${sender}@lid` },
    pushName: sender,
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: {
      extendedTextMessage: { text, contextInfo: { mentionedJid: mentioned ? botJids : [] } },
    },
  };
}
const candidate = (value: WAMessage) => ({
  ...toInboxCandidate(value, botJids)!,
  chatName: 'Site visits',
});
function session(send: (text: string, chatId: string) => Promise<void>): WhatsAppSession {
  return {
    botJids,
    on: () => () => {},
    async close() {},
    async saveCredentials() {},
    reply: (original, text) => send(text, original.key.remoteJid!),
    sendText: (chatId, text) => send(text, chatId),
  };
}

export async function checkInbox(
  t: TestContext,
  db: Awaited<ReturnType<typeof temporaryMessageDatabase>>,
  key: string,
) {
  const setup = (account: string) => {
    const repository = new MessageQueueRepository(db.runtime, account);
    const inbox = new InboxRepository(db.runtime, account, key);
    const queue = new DurableMessages(repository, {
      encryptionKey: key,
      maxAgeMs: 300000,
      capacity: 100,
      leaseMs: 45000,
      pollMs: 5,
      waitBeforeReply: async () => true,
    });
    return { repository, inbox, queue };
  };

  await t.test(
    'all group messages are encrypted and readable, but untagged messages never enter the reply queue',
    async () => {
      const { repository, inbox, queue } = setup('inbox-observe');
      const original = message('The site visit is tomorrow at 10.');
      assert.equal(await queue.enqueue(original, candidate(original)), 'observed');
      assert.equal(await queue.enqueue(original, candidate(original)), 'duplicate');
      assert.equal(await repository.claimInbound(45000), null);
      assert.equal(await repository.claimOutbound(45000), null);
      assert.equal(selectGreetingTarget(candidate(original), Date.now(), 300000), null);
      assert.ok(
        selectGreetingTarget(candidate(original), Date.now(), 300000, false),
        'hardcoded policy can allow all group replies',
      );
      const page = await inbox.messages(group);
      assert.equal(page.messages[0]!.text, 'The site visit is tomorrow at 10.');
      assert.equal(page.messages[0]!.mentionsBot, false);
      assert.equal(page.messages[0]!.senderName, 'alice');
      const chats = await inbox.conversations();
      assert.equal(chats.conversations[0]!.name, 'Site visits');
      assert.equal(chats.groupRepliesRequireMention, true);
      const rows = (
        await db.admin.query('SELECT * FROM public."ramesh-messages" WHERE account_id=$1', [
          'inbox-observe',
        ])
      ).rows;
      assert.ok(!JSON.stringify(rows).includes('The site visit'));
      assert.equal(rows[0].payload_encrypted, null);
      const media = { ...message(''), message: { imageMessage: {} } };
      assert.equal(await queue.enqueue(media, candidate(media)), 'observed');
      assert.ok(
        (await inbox.messages(group)).messages.some(
          (item) => item.kind === 'image' && item.text === '[Image message]',
        ),
      );
    },
  );

  await t.test(
    'fresh assistant loads multi-sender context from Supabase, with no DMs, other groups, future messages, or other accounts',
    async () => {
      const { repository, inbox, queue } = setup('inbox-context');
      const alice = message('The visit is at 10.');
      const bob = message('Use the north gate.', 'bob');
      for (const original of [
        alice,
        bob,
        message('Other group secret', 'eve', false, 'other@g.us'),
      ])
        await queue.enqueue(original, candidate(original));
      const other = setup('inbox-other-account');
      const secret = message('Other account secret');
      await other.queue.enqueue(secret, candidate(secret));
      const dm = message('Private DM secret', 'alice', false, 'alice@lid');
      await repository.enqueue(randomUUID(), candidate(dm), 'unused', 300000, 100, {
        content: 'not-decrypted-because-another-chat',
        replyEligible: false,
      });
      const trigger = message('What time and where?', 'charlie', true);
      await queue.enqueue(trigger, candidate(trigger));
      const future = message('Future message');
      await queue.enqueue(future, candidate(future));
      const calls: ModelRequest[] = [];
      const restartedInbox = new InboxRepository(db.runtime, 'inbox-context', key);
      const assistant = new AssistantService(
        { model: 'test', timeoutMs: 2000 },
        {
          async complete(request) {
            calls.push(request);
            return { text: 'At 10, at the north gate.', inputTokens: 1, outputTokens: 1 };
          },
        },
        undefined,
        undefined,
        (input) => restartedInbox.context(input),
      );
      const consumer = new DurableMessages(repository, {
        encryptionKey: key,
        maxAgeMs: 300000,
        capacity: 100,
        leaseMs: 45000,
        pollMs: 5,
        waitBeforeReply: async () => true,
        prepareReply: assistant.prepare.bind(assistant),
      });
      const stop = new AbortController();
      await consumer.consume(
        session(async (text, chat) => {
          assert.equal(chat, group);
          assert.match(text, /north gate/);
        }),
        stop.signal,
        (outcome) => {
          assert.equal(outcome, 'sent');
          stop.abort();
        },
      );
      const history = calls[0]!.messages;
      assert.equal(history.length, 3);
      assert.equal(JSON.parse(history[0]!.content).senderId, 'alice@lid');
      assert.equal(JSON.parse(history[1]!.content).senderId, 'bob@lid');
      assert.equal(JSON.parse(history[2]!.content).senderId, 'charlie@lid');
      assert.ok(!JSON.stringify(history).includes('secret'));
      assert.ok(!JSON.stringify(history).includes('Future message'));
      const archived = (await inbox.messages(group)).messages;
      assert.ok(archived.some((item) => item.direction === 'outbound' && item.status === 'SENT'));
      const row = (
        await db.admin.query(
          'SELECT payload_encrypted,reply_encrypted FROM public."ramesh-messages" WHERE account_id=$1 AND whatsapp_message_id=$2',
          ['inbox-context', trigger.key.id],
        )
      ).rows[0];
      assert.equal(row.payload_encrypted, null);
      assert.ok(row.reply_encrypted);
    },
  );

  await t.test(
    'operator sends are durable, idempotent, chat-bound and included in context only after successful sending',
    async () => {
      const { repository, inbox, queue } = setup('inbox-admin');
      const original = message('Hi team');
      await queue.enqueue(original, candidate(original));
      const id = randomUUID();
      assert.equal(await queue.sendAsAdmin(randomUUID(), 'stranger@lid', 'hello'), 'unknown_chat');
      const outcomes = await Promise.all(
        Array.from({ length: 4 }, () => queue.sendAsAdmin(id, group, 'I will join the visit.')),
      );
      assert.equal(outcomes.filter((item) => item === 'queued').length, 1);
      assert.equal(outcomes.filter((item) => item === 'duplicate').length, 3);
      assert.equal(await queue.sendAsAdmin(id, group, 'Different text'), 'conflict');
      assert.equal(await repository.claimInbound(45000), null);
      const before = message('Before sending');
      await queue.enqueue(before, candidate(before));
      assert.ok(
        !(await inbox.context(candidate(before))).some((item) => item.role === 'assistant'),
      );
      const stop = new AbortController();
      let sends = 0;
      await queue.consume(
        session(async (text, chat) => {
          sends++;
          assert.equal(text, 'I will join the visit.');
          assert.equal(chat, group);
        }),
        stop.signal,
        () => stop.abort(),
      );
      assert.equal(sends, 1);
      assert.equal(await queue.sendAsAdmin(id, group, 'I will join the visit.'), 'duplicate');
      const after = message('After sending');
      await queue.enqueue(after, candidate(after));
      assert.ok(
        (await inbox.context(candidate(after))).some(
          (item) => item.role === 'assistant' && item.content === 'I will join the visit.',
        ),
      );
      assert.ok(
        !(await inbox.context(candidate(before))).some((item) => item.role === 'assistant'),
        'later sent replies cannot leak into an earlier trigger',
      );
      const uncertain = randomUUID();
      await queue.sendAsAdmin(uncertain, group, 'Uncertain reply');
      const abort = new AbortController();
      await queue.consume(
        session(async () => {
          throw new Error('SDK outcome unknown');
        }),
        abort.signal,
        () => abort.abort(),
      );
      assert.equal(await repository.claimOutbound(45000), null);
      const later = message('After uncertainty');
      await queue.enqueue(later, candidate(later));
      assert.ok(
        !(await inbox.context(candidate(later))).some((item) => item.content === 'Uncertain reply'),
      );
      assert.ok(
        (await inbox.messages(group)).messages.some(
          (item) => item.id === `${uncertain}:reply` && item.status === 'UNCERTAIN',
        ),
      );
    },
  );

  await t.test(
    'inbox pagination preserves sub-millisecond rows and retention removes observed content',
    async () => {
      const { inbox, queue, repository } = setup('inbox-pages');
      for (let i = 0; i < 53; i++) {
        const original = message(`row ${i}`);
        await queue.enqueue(original, candidate(original));
      }
      await db.admin.query(`WITH ranked AS (
      SELECT id,row_number() OVER (ORDER BY created_at,id) AS n FROM public."ramesh-messages" WHERE account_id='inbox-pages'
    ) UPDATE public."ramesh-messages" m SET created_at='2026-01-01T00:00:00Z'::timestamptz + n*interval '1 microsecond'
      FROM ranked r WHERE m.id=r.id`);
      let cursor: string | null = null;
      const ids: string[] = [];
      do {
        const page = await inbox.messages(group, cursor);
        ids.push(...page.messages.map((item) => item.id));
        cursor = page.nextCursor;
      } while (cursor);
      assert.equal(ids.length, 53);
      assert.equal(new Set(ids).size, 53);
      await db.admin.query(
        `UPDATE public."ramesh-messages" SET finished_at=clock_timestamp()-interval '31 days' WHERE account_id='inbox-pages'`,
      );
      await repository.clean();
      assert.equal((await inbox.messages(group)).messages.length, 0);
    },
  );
}
