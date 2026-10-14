/** Real local queue, retained media, source reader, journal and graph; scripted model and CRM. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { proto, type WAMessage } from '@whiskeysockets/baileys';
import { temporaryMessageDatabase, postgresTestsEnabled } from '../fixtures/message-database.js';
import { authCipher } from '../../src/infrastructure/database/auth-store.js';
import { MessageQueueRepository } from '../../src/infrastructure/database/message-queue.repository.js';
import { MediaRepository } from '../../src/infrastructure/database/media.repository.js';
import { InboxRepository } from '../../src/infrastructure/database/inbox.repository.js';
import { WriteRepository } from '../../src/infrastructure/database/write.repository.js';
import { ChatContextRepository } from '../../src/infrastructure/database/chat-context.repository.js';
import { ChatContext, contextScope } from '../../src/modules/assistant/chat-context.js';
import type { WriteSourceBinding } from '../../src/modules/writes/write-source-bindings.js';
import { toInboxCandidate } from '../../src/infrastructure/whatsapp/message.mapper.js';
import { MediaService, mediaOwner } from '../../src/modules/media/media.service.js';
import { BusinessWriteService } from '../../src/modules/writes/write-tools.js';
import { buildSalesGraph } from '../../src/modules/assistant/sales.graph.js';
import { argumentsSha256 } from '../../src/modules/context-engine/read-contract.js';
import { encodeReply } from '../../src/modules/messaging/reply-payload.js';
import type {
  BoundContextWriter,
  ContextToolDefinition,
} from '../../src/modules/context-engine/context.types.js';
import type { TextModel } from '../../src/modules/assistant/assistant.types.js';
import type { TrustedReplyContext } from '../../src/modules/greetings/greeting.types.js';
import type { WriteCommandContext } from '../../src/modules/writes/write.types.js';

const actor = { employeeId: 23, phoneE164: '+919000000023', chatId: '919000000023@s.whatsapp.net' };
const caption =
  'Read the attached requirement image and tell me the client, size and location. Do not save it yet.';
const brief =
  '  Fixture Orchid Foods\n16,000–18,000 sq ft in Tumakuru.\nFire documentation; parking for two trucks.\n';
const definitions = (
  JSON.parse(
    readFileSync(new URL('../fixtures/transcript-tool-catalogue.json', import.meta.url), 'utf8'),
  ) as ContextToolDefinition[]
).filter((tool) => tool.name === 'create_crm_rfq');
const signal = () => AbortSignal.timeout(15000);

test(
  'attachment-backed writes preserve exact source data before dispatch',
  { skip: !postgresTestsEnabled },
  async (t) => {
    const db = await temporaryMessageDatabase();
    const key = randomBytes(32).toString('base64url'),
      cipher = authCipher(key);
    const mediaServices: MediaService[] = [];
    function fixture(text = brief) {
      const account = randomUUID();
      const queue = new MessageQueueRepository(db.runtime, account);
      const media = new MediaRepository(db.runtime, account, key, 'production');
      const processor = new MediaService(media, { extract: async () => text });
      mediaServices.push(processor);
      const repository = new WriteRepository(db.runtime, account, key);
      const inbox = new InboxRepository(db.runtime, account, key);
      const calls: Array<{ operationId: string; description: string }> = [];
      const writer: BoundContextWriter = {
        employeeId: actor.employeeId,
        discover: async () => structuredClone(definitions),
        describe: async () => ({ tools: structuredClone(definitions), context: {} }),
        call: async (name, args, operationId) => {
          calls.push({ operationId, description: args.raw_text as string });
          const id = randomUUID();
          return {
            operation_id: operationId,
            outcome: 'created',
            code: 'OK',
            message: 'Synthetic saved record.',
            data: {
              id,
              name: 'Fixture Orchid Foods',
              url: `https://crm.wareongo.com/object/opportunity/${id}`,
            },
            meta: {
              employeeId: actor.employeeId,
              toolName: name,
              argumentsSha256: argumentsSha256(args),
            },
          };
        },
      };
      const writes = new BusinessWriteService(repository, async () => ({ actor, writer }));
      async function enqueue(body: WAMessage['message'], eligible: boolean) {
        const id = randomUUID(),
          whatsappId = randomUUID();
        const message: WAMessage = {
          key: { id: whatsappId, remoteJid: actor.chatId, fromMe: false },
          messageTimestamp: Math.floor(Date.now() / 1000),
          message: body,
        };
        const candidate = toInboxCandidate(message, [])!;
        assert.ok(candidate);
        await queue.enqueue(
          id,
          candidate,
          cipher.seal('message', id, Buffer.from(proto.WebMessageInfo.encode(message).finish())),
          300000,
          100,
          {
            replyEligible: eligible,
            content: cipher.seal('inbox', id, {
              text: candidate.text ?? '',
              kind: candidate.kind,
              senderId: actor.chatId,
              senderName: 'Synthetic',
              chatName: null,
              forwarded: candidate.forwarded === true,
            }),
          },
        );
        return { id, whatsappId, candidate };
      }
      async function attachment(kind: 'image' | 'document', text = caption) {
        const source = await enqueue(
          kind === 'image'
            ? { imageMessage: { caption: text, mimetype: 'image/png' } }
            : {
                documentMessage: {
                  caption: text,
                  mimetype: 'application/pdf',
                  fileName: 'brief.pdf',
                },
              },
          false,
        );
        const mediaId = await processor.ingest(
          mediaOwner(account, actor.chatId, actor.chatId),
          source.whatsappId,
          {
            bytes:
              kind === 'image'
                ? Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
                : Buffer.from('%PDF-1.7\nsynthetic'),
            mime: kind === 'image' ? 'image/png' : 'application/pdf',
            name: kind === 'image' ? 'brief.png' : 'brief.pdf',
          },
        );
        await processor.drain();
        return { ...source, mediaId };
      }
      async function command(text = 'Save that full brief as a new RFQ.', quoted?: string) {
        const input = await enqueue(
          quoted
            ? {
                extendedTextMessage: {
                  text,
                  contextInfo: {
                    stanzaId: quoted,
                    participant: actor.chatId,
                    quotedMessage: { imageMessage: { caption } },
                  },
                },
              }
            : { conversation: text },
          true,
        );
        const job = await queue.claimInbound(60000);
        assert.equal(job?.id, input.id);
        assert.equal(await queue.beginAgentRun(job!), true);
        const ctx: WriteCommandContext = {
          ...actor,
          runId: job!.id,
          sourceMessageId: job!.id,
          leaseToken: job!.token,
          requestTimeMs: Date.now(),
          ...(quoted ? { quotedWhatsappId: quoted } : {}),
        };
        const trusted: TrustedReplyContext = {
          runId: job!.id,
          key: { remoteJid: actor.chatId },
          checkpointLease: { leaseToken: job!.token },
          commandMessages: [
            {
              id: job!.id,
              text,
              receivedAtMs: Date.now(),
              forwarded: false,
              ...(quoted ? { quotedUserMessageId: quoted } : {}),
            },
          ],
        };
        return { ...input, ctx, trusted, job: job! };
      }
      return {
        account,
        queue,
        media,
        processor,
        repository,
        inbox,
        writes,
        calls,
        enqueue,
        attachment,
        command,
        finishTurn: async (current: Awaited<ReturnType<typeof command>>) => {
          assert.equal(
            await queue.handoff(
              current.job,
              cipher.seal(
                'outbound-reply',
                current.id,
                encodeReply('Waiting for your next instruction.', false),
              ),
            ),
            true,
          );
          const outbound = (await queue.claimOutbound(60000))!;
          assert.equal(await queue.beginSend(outbound), true);
          assert.equal(await queue.complete(outbound, 'SENT'), true);
        },
        context: () =>
          new ChatContext({
            store: new ChatContextRepository(db.runtime, account, key),
            source: inbox,
            model: {
              complete: async () => {
                throw new Error('UNEXPECTED_SUMMARY');
              },
            },
            resolve: async () => contextScope(account, actor.chatId, actor),
          }),
      };
    }

    try {
      await t.test(
        'an explicitly quoted older brief stays readable through its prepared binding',
        async () => {
          const f = fixture(),
            source = await f.enqueue({ conversation: brief }, false);
          await db.admin.query(
            'UPDATE public."ramesh-messages" SET created_at=clock_timestamp()-interval \'20 days\' WHERE id=$1',
            [source.id],
          );
          const first = await f.command('Prepare this brief and wait.', source.whatsappId);
          const memory = await f.context().prepare(first.candidate, first.trusted, signal());
          const run = (await f.writes.open(first.trusted, signal(), memory!.writeSources))!;
          const prepared = (await run.execute(
            'write_prepare',
            JSON.stringify({
              tool_name: 'create_crm_rfq',
              label: 'Quoted RFQ',
              source_message_ids: [source.id],
            }),
            signal(),
          )) as { binding: WriteSourceBinding };
          assert.ok(prepared.binding);
          await f.finishTurn(first);
          const second = await f.command('Yes, save it.');
          const restarted = await f.context().prepare(second.candidate, second.trusted, signal());
          const resumed = (await f.writes.open(second.trusted, signal(), restarted!.writeSources))!;
          await resumed.execute(
            'create_crm_rfq',
            JSON.stringify({ _source_binding_id: prepared.binding.id }),
            signal(),
          );
          assert.equal(f.calls.length, 1);
          assert.equal(f.calls[0]!.description, brief);
        },
      );

      await t.test(
        'a prepared image selection survives a database-backed context restart and saves on yes',
        async () => {
          const f = fixture(),
            source = await f.attachment('image');
          const first = await f.command('Prepare that RFQ; wait for my confirmation.');
          const memory = await f.context().prepare(first.candidate, first.trusted, signal());
          const run = (await f.writes.open(first.trusted, signal(), memory!.writeSources))!;
          const model: TextModel = {
            async complete(request) {
              const value =
                request.stage === 'converser'
                  ? {
                      route: 'work',
                      objective: 'Prepare Orchid RFQ',
                      reply: '',
                      workflow: 'general',
                      lookupTools: [],
                    }
                  : request.stage === 'planner'
                    ? {
                        objective: 'Prepare Orchid RFQ',
                        successCriteria: ['Wait for the user confirmation.'],
                        clarification: {
                          question: 'Should I save this RFQ now?',
                          missingDecision: 'The user requested confirmation first.',
                          writeSources: {
                            tool_name: 'create_crm_rfq',
                            source_message_ids: [source.id],
                          },
                        },
                        steps: [],
                      }
                    : { supported: true, feedback: '', repair: 'none' };
              return { text: JSON.stringify(value), inputTokens: 0, outputTokens: 0 };
            },
            startToolSession() {
              throw new Error('CLARIFICATION_MUST_NOT_START_WORKER');
            },
          };
          const question = await buildSalesGraph(model, async () => ({ status: 'denied' }), {
            writes: run,
          }).invoke({ input: first.candidate.text!, history: memory!.history, audience: 'dm' });
          assert.equal(question.reply, 'Should I save this RFQ now?');
          const selection = { binding: memory!.writeSources!.list()[0]! };
          assert.ok(selection.binding);
          assert.equal(f.calls.length, 0);
          assert.equal(await f.repository.findByRun(first.ctx), null);
          await f.finishTurn(first);
          const second = await f.command('Yes, save it.');
          const restarted = await f.context().prepare(second.candidate, second.trusted, signal());
          assert.equal(restarted!.writeSources!.list()[0]!.id, selection.binding.id);
          const resumed = (await f.writes.open(second.trusted, signal(), restarted!.writeSources))!;
          await resumed.execute(
            'create_crm_rfq',
            JSON.stringify({ _source_binding_id: selection.binding.id }),
            signal(),
          );
          assert.equal(f.calls.length, 1);
          assert.equal(f.calls[0]!.description, `${caption}\n\n${brief}`);
          assert.equal((await f.repository.findByRun(second.ctx))!.state, 'SUCCEEDED');
        },
      );

      await t.test(
        'a later full replacement removes a failed attachment from the remembered scope',
        async () => {
          const f = fixture(brief + 'x'.repeat(21000)),
            source = await f.attachment('document');
          const first = await f.command('Save the full brief.');
          const memory = await f.context().prepare(first.candidate, first.trusted, signal());
          const run = (await f.writes.open(first.trusted, signal(), memory!.writeSources))!;
          const failed = (await run.execute(
            'create_crm_rfq',
            JSON.stringify({ _source_message_ids: [source.id] }),
            signal(),
          )) as { source_binding: WriteSourceBinding };
          assert.match(run.sourceNeededReply!, /32,000 characters of text in total/);
          await f.finishTurn(first);
          const second = await f.command(`Complete replacement: ${brief} Save this instead.`);
          const restarted = await f.context().prepare(second.candidate, second.trusted, signal());
          const resumed = (await f.writes.open(second.trusted, signal(), restarted!.writeSources))!;
          const replacement = (await resumed.execute(
            'write_prepare',
            JSON.stringify({
              tool_name: 'create_crm_rfq',
              label: 'Replacement RFQ',
              source_message_ids: [second.id],
              replaces_binding_id: failed.source_binding.id,
            }),
            signal(),
          )) as { binding: WriteSourceBinding };
          await resumed.execute(
            'create_crm_rfq',
            JSON.stringify({ _source_binding_id: replacement.binding.id }),
            signal(),
          );
          assert.equal(f.calls.length, 1);
          assert.equal(f.calls[0]!.description, second.candidate.text);
        },
      );

      await t.test(
        'a follow-up confirmation needs an explicit brief selection before dispatch',
        async () => {
          const f = fixture(),
            source = await f.attachment('image'),
            current = await f.command('Yes, save that requirement in CRM.');
          const run = (await f.writes.open(current.trusted, signal()))!;
          for (const args of [{}, { _source_message_ids: [] }, { _source_message_ids: null }]) {
            const result = (await run.execute(
              'create_crm_rfq',
              JSON.stringify(args),
              signal(),
            )) as { code: string };
            assert.equal(
              result.code,
              '_source_message_ids' in args
                ? 'WRITE_ARGUMENTS_INVALID'
                : 'WRITE_SOURCE_SELECTION_REQUIRED',
            );
            assert.equal(f.calls.length, 0);
            assert.equal(await f.repository.findByRun(current.ctx), null);
          }
          const listing = (await run.execute('write_sources', '{}', signal())) as {
            sources: Array<{ id: string; attachment?: { text: string } }>;
          };
          assert.equal(
            listing.sources.find((item) => item.id === source.id)?.attachment?.text,
            brief,
          );
          await run.execute(
            'create_crm_rfq',
            JSON.stringify({ _source_message_ids: [source.id] }),
            signal(),
          );
          assert.equal(f.calls.length, 1);
          assert.equal(f.calls[0]!.description, `${caption}\n\n${brief}`);
          assert.equal((await f.repository.findByRun(current.ctx))?.state, 'SUCCEEDED');
        },
      );

      for (const state of ['unavailable', 'truncated'] as const)
        await t.test(
          `${state}: failed full capture cannot retry through a partial selector`,
          async () => {
            const f = fixture(state === 'truncated' ? brief + 'x'.repeat(21000) : brief),
              source = await f.attachment('image');
            if (state === 'unavailable')
              await f.media.clear(mediaOwner(f.account, actor.chatId, actor.chatId));
            const current = await f.command();
            const run = (await f.writes.open(current.trusted, signal()))!;
            const first = (await run.execute(
              'create_crm_rfq',
              JSON.stringify({ _source_message_ids: [source.id] }),
              signal(),
            )) as { code: string };
            assert.equal(
              first.code,
              state === 'truncated'
                ? 'WRITE_ATTACHMENT_INCOMPLETE'
                : 'WRITE_ATTACHMENT_UNAVAILABLE',
            );
            for (const part of ['text', 'attachment']) {
              const retry = (await run.execute(
                'create_crm_rfq',
                JSON.stringify({ _source_message_ids: [`${source.id}:${part}`] }),
                signal(),
              )) as { code: string };
              assert.equal(retry.code, 'WRITE_SOURCE_SELECTION_CHANGED');
            }
            assert.equal(f.calls.length, 0);
            assert.equal(await f.repository.findByRun(current.ctx), null);
          },
        );

      await t.test(
        'a complete replacement brief is independently saveable without the truncated attachment',
        async () => {
          const f = fixture(brief + 'x'.repeat(21000));
          await f.attachment('document');
          const current = await f.command(
            `Here is the complete replacement brief. Save this instead:\n${brief}`,
          );
          const run = (await f.writes.open(current.trusted, signal()))!;
          await run.execute(
            'create_crm_rfq',
            JSON.stringify({ _source_message_ids: [current.id] }),
            signal(),
          );
          assert.equal(f.calls.length, 1);
          assert.equal(f.calls[0]!.description, current.candidate.text);
        },
      );

      await t.test(
        'multiple complete files and a correction preserve all selected content in order',
        async () => {
          const f = fixture('  First page: client and size.\n'),
            first = await f.attachment('document', 'Part one');
          const second = await f.enqueue(
            { imageMessage: { caption: 'Part two', mimetype: 'image/png' } },
            false,
          );
          const owner = mediaOwner(f.account, actor.chatId, actor.chatId);
          const id = await f.media.put(owner, second.whatsappId, {
            bytes: Buffer.from('synthetic'),
            mime: 'image/png',
            name: 'second.png',
          });
          const claim = await f.media.claim(owner, id);
          await f.media.finish(owner, id, claim!.token!, {
            kind: 'image',
            text: '  Second page: power and fire documents.\n',
          });
          const current = await f.command(
            'Correction: 25,000 sqft. Save both pages with this correction.',
          );
          const run = (await f.writes.open(current.trusted, signal()))!;
          await run.execute(
            'create_crm_rfq',
            JSON.stringify({ _source_message_ids: [first.id, second.id, current.id] }),
            signal(),
          );
          assert.equal(f.calls.length, 1);
          assert.equal(
            f.calls[0]!.description,
            'Part one\n\n  First page: client and size.\n\n\nPart two\n\n  Second page: power and fire documents.\n\n\n' +
              current.candidate.text,
          );
        },
      );

      for (const kind of ['image', 'document'] as const) {
        await t.test(
          `${kind}: the original failure saves the complete extraction even when reply review rejects`,
          async () => {
            const f = fixture(),
              source = await f.attachment(kind),
              current = await f.command();
            const history = await f.inbox.context(current.candidate);
            assert.ok(
              history.some((entry) =>
                entry.content.includes('Fire documentation; parking for two trucks.'),
              ),
            );
            const page = await f.inbox.page(
              current.candidate,
              '',
              (await f.inbox.anchor(current.candidate)).before,
            );
            assert.ok(page.entries.some((entry) => entry.transientContent?.text.includes(brief)));
            const writes = (await f.writes.open(current.trusted, signal()))!;
            let called = false,
              reviews = 0;
            const output = (text: string) => ({ text, inputTokens: 0, outputTokens: 0 });
            const model: TextModel = {
              async complete(request) {
                if (request.stage === 'converser')
                  return output(
                    JSON.stringify({
                      route: 'work',
                      workflow: 'general',
                      objective: current.candidate.text,
                      reply: '',
                    }),
                  );
                if (request.stage === 'planner')
                  return output(
                    JSON.stringify({
                      objective: current.candidate.text,
                      successCriteria: ['Save the original complete requirement.'],
                      responseMode: 'answer',
                      steps: [
                        {
                          id: 'save',
                          goal: 'Save the brief',
                          dependsOn: [],
                          toolNames: ['create_crm_rfq'],
                        },
                      ],
                    }),
                  );
                if (request.stage === 'verifier') {
                  reviews++;
                  return output(
                    JSON.stringify({
                      supported: false,
                      feedback: 'The extra explanation needs correction.',
                      repair: 'format',
                    }),
                  );
                }
                return output(request.jsonSchema ? JSON.stringify({ additional_reply: '' }) : '');
              },
              startToolSession() {
                return {
                  async next() {
                    const calls = called
                      ? []
                      : [
                          {
                            id: 'save-source',
                            name: 'create_crm_rfq',
                            arguments: JSON.stringify({ _source_message_ids: [source.id] }),
                          },
                        ];
                    called = true;
                    return { ...output(''), calls };
                  },
                  accept() {},
                  revise() {},
                };
              },
            };
            const result = await buildSalesGraph(model, async () => ({ status: 'denied' }), {
              writes,
            }).invoke({ input: current.candidate.text!, history, audience: 'dm' });
            assert.ok(reviews > 0);
            assert.equal(f.calls.length, 1);
            assert.equal(f.calls[0]!.description, `${caption}\n\n${brief}`);
            assert.match(result.reply, /Saved RFQ: Fixture Orchid Foods/);
            assert.doesNotMatch(result.reply, /Full brief saved/);
            const recorded = await f.repository.findByRun(current.ctx);
            assert.equal(recorded?.state, 'SUCCEEDED');
            assert.equal(recorded?.payload.arguments.raw_text, f.calls[0]!.description);
            await f.media.clear(mediaOwner(f.account, actor.chatId, actor.chatId));
            const recovered = await new BusinessWriteService(
              new WriteRepository(db.runtime, f.account, key),
              async () => ({
                actor,
                writer: {
                  employeeId: actor.employeeId,
                  discover: async () => definitions,
                  describe: async () => ({ tools: definitions, context: {} }),
                  call: async () => assert.fail('Receipt recovery cannot redispatch or re-extract'),
                },
              }),
            ).recover(current.trusted, signal());
            assert.match(recovered!.text, /operation completed/);
            assert.doesNotMatch(recovered!.text, /Fixture Orchid Foods|Full brief saved/);
            assert.equal(
              (await f.repository.receiptLookup(actor, recorded!.operationId))!.payload.arguments
                .raw_text,
              `${caption}\n\n${brief}`,
            );
          },
        );
      }

      await t.test(
        'source discovery identifies a quoted attachment for explicit selection',
        async () => {
          const f = fixture(),
            source = await f.attachment('image'),
            current = await f.command('Add this to CRM', source.whatsappId);
          const run = (await f.writes.open(current.trusted, signal()))!;
          const listing = (await run.execute('write_sources', '{}', signal())) as {
            sources: Array<{ id: string; quoted?: boolean }>;
          };
          assert.equal(listing.sources.find((item) => item.quoted)?.id, source.id);
          await run.execute(
            'create_crm_rfq',
            JSON.stringify({ _source_message_ids: [source.id, current.id] }),
            signal(),
          );
          assert.equal(f.calls[0]!.description, `${caption}\n\n${brief}\n\nAdd this to CRM`);
        },
      );

      await t.test(
        'long retained text is not replaced with shortened conversation context',
        async () => {
          const long = `${brief}${'Important details.\n'.repeat(900)}FINAL SOURCE DETAIL`;
          const f = fixture(long),
            source = await f.attachment('document'),
            current = await f.command();
          const history = await f.inbox.context(current.candidate);
          assert.ok(!history.some((entry) => entry.content.includes('FINAL SOURCE DETAIL')));
          const run = (await f.writes.open(current.trusted, signal()))!;
          await run.execute(
            'create_crm_rfq',
            JSON.stringify({ _source_message_ids: [source.id] }),
            signal(),
          );
          assert.equal(f.calls[0]!.description, `${caption}\n\n${long}`);
        },
      );

      await t.test(
        'a current image caption authorizes capture while its extraction supplies only data',
        async () => {
          const f = fixture();
          const input = await f.enqueue(
            {
              imageMessage: { caption: 'Save this requirement as an RFQ.', mimetype: 'image/png' },
            },
            true,
          );
          const owner = mediaOwner(f.account, actor.chatId, actor.chatId);
          await f.processor.ingest(owner, input.whatsappId, {
            bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
            mime: 'image/png',
            name: 'brief.png',
          });
          await f.processor.drain();
          const job = (await f.queue.claimInbound(60000))!;
          assert.equal(await f.queue.beginAgentRun(job), true);
          const trusted: TrustedReplyContext = {
            runId: job.id,
            key: { remoteJid: actor.chatId },
            checkpointLease: { leaseToken: job.token },
            commandMessages: [
              {
                id: job.id,
                text: input.candidate.text!,
                receivedAtMs: Date.now(),
                forwarded: false,
              },
            ],
          };
          const run = (await f.writes.open(trusted, signal()))!;
          await run.execute(
            'create_crm_rfq',
            JSON.stringify({ _source_message_ids: [input.id] }),
            signal(),
          );
          assert.equal(f.calls[0]!.description, `${input.candidate.text}\n\n${brief}`);
          const operation = await f.repository.findByRun({
            ...actor,
            runId: job.id,
            sourceMessageId: job.id,
            leaseToken: job.token,
            requestTimeMs: Date.now(),
          });
          assert.equal(
            (operation!.payload.source as { instruction: { text: string } }).instruction.text,
            input.candidate.text,
          );
        },
      );

      await t.test('an explicit caption-only request needs no expired attachment', async () => {
        const f = fixture(),
          source = await f.attachment('image', 'Client Cedar: details later.');
        await f.media.clear(mediaOwner(f.account, actor.chatId, actor.chatId));
        const current = await f.command('Save only the caption as an RFQ; ignore the attachment.');
        const run = (await f.writes.open(current.trusted, signal()))!;
        const result = (await run.execute(
          'create_crm_rfq',
          JSON.stringify({ _source_message_ids: [`${source.id}:text`] }),
          signal(),
        )) as { ok: boolean };
        assert.equal(result.ok, true);
        assert.equal(f.calls.length, 1);
        assert.equal(f.calls[0]!.description, 'Client Cedar: details later.');
        assert.equal((await f.repository.findByRun(current.ctx))?.state, 'SUCCEEDED');
      });

      await t.test(
        'explicit source lookup reaches an attachment outside the recent-media window',
        async () => {
          const f = fixture(),
            source = await f.attachment('image');
          for (let i = 0; i < 9; i++) await f.attachment('document', `Unrelated file ${i}`);
          const owner = mediaOwner(f.account, actor.chatId, actor.chatId);
          assert.ok(!(await f.media.get(owner)).some((record) => record.id === source.mediaId));
          const current = await f.command();
          const run = (await f.writes.open(current.trusted, signal()))!;
          await run.execute(
            'create_crm_rfq',
            JSON.stringify({ _source_message_ids: [source.id] }),
            signal(),
          );
          assert.equal(f.calls[0]!.description, `${caption}\n\n${brief}`);
        },
      );

      for (const mode of ['expired', 'truncated', 'missing'] as const) {
        await t.test(
          `${mode} extraction prevents dispatch without creating an operation`,
          async () => {
            const f = fixture(mode === 'truncated' ? brief + 'x'.repeat(21000) : brief);
            const source = await f.attachment(
              'document',
              'Fixture Cedar needs a warehouse. Details later.',
            );
            if (mode === 'expired')
              await db.admin.query(
                'UPDATE public."ramesh-media" SET expires_at=clock_timestamp()-interval \'1 second\' WHERE id=$1',
                [source.mediaId],
              );
            if (mode === 'missing')
              await f.media.clear(mediaOwner(f.account, actor.chatId, actor.chatId));
            const current = await f.command();
            const run = (await f.writes.open(current.trusted, signal()))!;
            const result = (await run.execute(
              'create_crm_rfq',
              JSON.stringify({ _source_message_ids: [source.id] }),
              signal(),
            )) as { code: string };
            assert.equal(
              result.code,
              mode === 'truncated' ? 'WRITE_ATTACHMENT_INCOMPLETE' : 'WRITE_ATTACHMENT_UNAVAILABLE',
            );
            assert.deepEqual(f.calls, []);
            assert.equal(await f.repository.findByRun(current.ctx), null);
            assert.match(run.sourceNeededReply!, /nothing was saved/i);
          },
        );
      }

      await t.test(
        'attachment text cannot be imported from another account or sender',
        async () => {
          const f = fixture(),
            source = await f.attachment('image'),
            current = await f.command();
          await f.media.clear(mediaOwner(f.account, actor.chatId, actor.chatId));
          for (const [account, sender] of [
            [randomUUID(), actor.chatId],
            [f.account, '919000000099@s.whatsapp.net'],
          ]) {
            const media = new MediaRepository(db.runtime, account!, key, 'production');
            const owner = mediaOwner(account!, actor.chatId, sender!);
            const id = await media.put(owner, source.whatsappId, {
              bytes: Buffer.from('private'),
              mime: 'image/png',
              name: 'private.png',
            });
            const claim = await media.claim(owner, id);
            await media.finish(owner, id, claim!.token!, {
              kind: 'image',
              text: 'OTHER OWNER SECRET',
            });
          }
          const sources = await f.repository.readSources(current.ctx, [source.id]);
          assert.equal(sources[0]!.attachment!.state, 'unavailable');
          assert.doesNotMatch(JSON.stringify(sources), /OTHER OWNER SECRET/);
        },
      );
    } finally {
      await Promise.all(mediaServices.map((service) => service.stop()));
      await db.close();
    }
  },
);
