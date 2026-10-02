import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadAssistantConfig } from '../../src/config/assistant.js';
import { OpenAIMediaProcessor } from '../../src/infrastructure/openai/media-processor.js';
import { renderVoiceReply } from '../../src/modules/media/voice-reply.js';
import { decodeReply, encodeReply } from '../../src/modules/messaging/reply-payload.js';
import { mediaOwner } from '../../src/modules/media/media.service.js';
import type { MediaRecord, MediaStore } from '../../src/modules/media/media.types.js';
const owner = mediaOwner('account', 'chat', 'sender');
const ids = [randomUUID(), randomUUID(), randomUUID()];
function store(texts: Array<string | undefined>, states: MediaRecord['state'][] = []): MediaStore {
  return {
    async get(boundOwner, wanted) {
      if (boundOwner !== owner) return [];
      return ids
        .map(
          (id, index): MediaRecord => ({
            id,
            owner,
            source: `voice-${index}`,
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 10000),
            state: states[index] ?? 'ready',
            kind: 'audio',
            text: texts[index],
          }),
        )
        .filter((r) => wanted?.includes(r.id))
        .reverse();
    },
  } as MediaStore;
}
test('voice quotes preserve STT text exactly, with one response after ordered transcripts', async () => {
  const texts = [
    'Kal 3 baje call karna. “Sure?”',
    'Keep _literal_ words, <script>bad()</script> and an em dash — here.',
    'Final note.\nSecond line.',
  ];
  const answer = 'The common response.';
  const result = await renderVoiceReply(answer, { owner, ids }, store(texts));
  assert.deepEqual(
    result.transcripts.map((t) => t.text),
    texts,
  );
  assert.equal(result.responseText, answer);
  assert.equal(
    result.text,
    texts.map((t, i) => `Voice note ${i + 1}\n_"${t}"_`).join('\n\n') + '\n\n' + answer,
  );
});
test('single audio is italic and quoted; ordinary and follow-up messages do not repeat it', async () => {
  assert.equal(
    (await renderVoiceReply('Done.', { owner, ids: [ids[0]!] }, store(['Original.']))).text,
    '_"Original."_\n\nDone.',
  );
  assert.deepEqual(await renderVoiceReply('Next reply.', undefined, store(['Original.'])), {
    text: 'Next reply.',
    responseText: 'Next reply.',
    transcripts: [],
  });
});
test('failed, expired and wrong-owner audio cannot yield a fabricated or leaked quote', async () => {
  const wrong = mediaOwner('account', 'chat', 'someone-else');
  const result = await renderVoiceReply(
    'Only available content was summarized.',
    { owner, ids },
    store(['one', undefined, 'not ready'], ['ready', 'failed', 'processing']),
  );
  assert.deepEqual(result.transcripts, [{ text: 'one' }, {}, {}]);
  assert.match(result.text, /unavailable or expired/);
  assert.doesNotMatch(
    (await renderVoiceReply('Reply', { owner: wrong, ids }, store(['private']))).text,
    /private/,
  );
  await assert.rejects(renderVoiceReply('Reply', { owner: '', ids }, store([])), /INVALID_VOICE/);
  await assert.rejects(
    renderVoiceReply('Reply', { owner, ids: [ids[0]!, ids[0]!] }, store([])),
    /INVALID_VOICE/,
  );
});
test('long transcripts are explicitly excerpts and preserve the delivery length bound', async () => {
  const result = await renderVoiceReply(
    'Shared answer.',
    { owner, ids },
    store(Array(3).fill('😊'.repeat(11000))),
  );
  assert.ok(result.text.length <= 16000);
  assert.ok(result.transcripts.every((t) => t.excerpt && !/[\uD800-\uDBFF]$/.test(t.text!)));
  assert.equal(result.responseText, 'Shared answer.');
  assert.match(result.text, /Transcript excerpt/);
});
test('voice payload persists references and response, decodes old records and rejects downgraded private replies', () => {
  const ref = { owner, ids };
  assert.deepEqual(decodeReply(encodeReply('answer', false, ref), 'conversation'), {
    text: 'answer',
    voice: ref,
  });
  assert.deepEqual(decodeReply(encodeReply('private', true, ref), 'business'), {
    text: 'private',
    voice: ref,
  });
  assert.equal(decodeReply('ordinary', 'conversation').text, 'ordinary');
  assert.equal(decodeReply({ version: 1, kind: 'business', text: 'old' }, 'business').text, 'old');
  assert.throws(() => decodeReply('private', 'business'));
  assert.throws(() => decodeReply(encodeReply('private', true, ref), 'conversation'));
  assert.throws(() =>
    decodeReply(
      { version: 2, kind: 'conversation', text: 'x', voice: { owner, ids: [] } },
      'conversation',
    ),
  );
});
test('STT configuration has an independent key and validates the transcription model', () => {
  const config = loadAssistantConfig({
    OPENAI_API_KEY: 'responses-test',
    OPENAI_STT_API_KEY: 'stt-test',
    OPENAI_TRANSCRIBE_MODEL: 'gpt-4o-transcribe',
  })!;
  assert.equal(config.apiKey, 'responses-test');
  assert.equal(config.sttApiKey, 'stt-test');
  assert.equal(config.transcriptionModel, 'gpt-4o-transcribe');
  assert.equal(loadAssistantConfig({ OPENAI_API_KEY: 'fallback' })?.sttApiKey, 'fallback');
  assert.throws(() =>
    loadAssistantConfig({ OPENAI_API_KEY: 'fake', OPENAI_TRANSCRIBE_MODEL: 'bad model\n' }),
  );
});
function wav() {
  const bytes = Buffer.alloc(44 + 3200);
  bytes.write('RIFF');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24);
  bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(3200, 40);
  return bytes;
}
test('real SDK routes audio to the STT key/model and PDF to the Responses key without provider storage', async () => {
  const calls: string[] = [];
  const uploads = [
    { bytes: wav(), mime: 'audio/wav', extension: 'wav' },
    {
      bytes: Buffer.from('OggS synthetic SDK transport fixture'),
      mime: 'audio/ogg',
      extension: 'ogg',
    },
    {
      bytes: Buffer.from('ID3 synthetic SDK transport fixture'),
      mime: 'audio/mpeg',
      extension: 'mp3',
    },
    {
      bytes: Buffer.from('synthetic MP4 SDK transport fixture'),
      mime: 'audio/mp4',
      extension: 'mp4',
    },
    {
      bytes: Buffer.from('synthetic WebM SDK transport fixture'),
      mime: 'audio/webm',
      extension: 'webm',
    },
  ];
  let audioIndex = 0;
  const config = loadAssistantConfig({
    OPENAI_API_KEY: 'responses-test',
    OPENAI_STT_API_KEY: 'stt-test',
    OPENAI_TRANSCRIBE_MODEL: 'gpt-4o-transcribe',
  })!;
  const processor = new OpenAIMediaProcessor(config, undefined, async (url, init) => {
    const path = String(url);
    if (path === 'data:,') return new Response('');
    calls.push(path);
    if (path.endsWith('/audio/transcriptions')) {
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer stt-test');
      const form = init!.body as FormData;
      assert.equal(form.get('model'), 'gpt-4o-transcribe');
      assert.equal(form.get('response_format'), 'json');
      const file = form.get('file') as File;
      const original = uploads[audioIndex++]!;
      assert.equal(file.name, `voice.${original.extension}`);
      assert.equal(file.type, original.mime);
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), original.bytes);
      return Response.json({ text: 'Verbatim transcript.' });
    }
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer responses-test');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.store, false);
    return Response.json({
      id: 'r',
      object: 'response',
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'PDF content.' }],
        },
      ],
    });
  });
  for (const upload of uploads)
    assert.equal(
      await processor.extract(
        { ...upload, name: '../../untrusted-file-name' },
        AbortSignal.timeout(5000),
      ),
      'Verbatim transcript.',
    );
  assert.equal(
    await processor.extract(
      { bytes: Buffer.from('%PDF-1.7'), mime: 'application/pdf', name: 'a.pdf' },
      AbortSignal.timeout(5000),
    ),
    'PDF content.',
  );
  assert.equal(audioIndex, uploads.length);
  assert.equal(calls.length, uploads.length + 1);
});

test('direct STT rejects unsafe inputs before network access and preserves provider failures', async () => {
  const config = loadAssistantConfig({
    OPENAI_API_KEY: 'responses-test',
    OPENAI_STT_API_KEY: 'stt-test',
  })!;
  let calls = 0;
  const processor = new OpenAIMediaProcessor(config, undefined, async (url) => {
    if (String(url) === 'data:,') return new Response('');
    calls++;
    return Response.json(
      { error: { message: 'Unsupported audio fixture', type: 'invalid_request_error' } },
      { status: 400 },
    );
  });
  const signal = AbortSignal.timeout(5000);
  await assert.rejects(
    processor.extract({ bytes: Buffer.from('x'), mime: 'audio/unknown', name: 'a' }, signal),
    /UNSUPPORTED_AUDIO/,
  );
  await assert.rejects(
    processor.extract({ bytes: Buffer.alloc(0), mime: 'audio/ogg', name: 'a' }, signal),
    /INVALID_AUDIO_SIZE/,
  );
  await assert.rejects(
    processor.extract(
      { bytes: Buffer.alloc(8 * 1024 * 1024 + 1), mime: 'audio/ogg', name: 'a' },
      signal,
    ),
    /INVALID_AUDIO_SIZE/,
  );
  await assert.rejects(
    processor.extract({ bytes: wav(), mime: 'audio/wav', name: 'a' }, AbortSignal.abort()),
  );
  assert.equal(calls, 0);
  await assert.rejects(processor.extract({ bytes: wav(), mime: 'audio/wav', name: 'a' }, signal), {
    status: 400,
  });
  assert.equal(calls, 1);
});
