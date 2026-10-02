/** Text-only regressions. No models, source reads, or WhatsApp transport. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { finishReply, whatsappBold } from '../../src/modules/assistant/style.js';
import { renderVoiceReply } from '../../src/modules/media/voice-reply.js';
import type { MediaStore } from '../../src/modules/media/media.types.js';

test('converts Markdown bold in a fictional business reply to WhatsApp bold', () => {
  const input =
    '**Recorded brief**\n- **40,000 sq ft in Example City**, nearby areas acceptable.\n- **Created: 20 Sept 2026 · Last updated: 21 Sept 2026 (IST).**';
  assert.equal(
    finishReply(input),
    '*Recorded brief*\n- *40,000 sq ft in Example City*, nearby areas acceptable.\n- *Created: 20 Sept 2026 · Last updated: 21 Sept 2026 (IST).*',
  );
  assert.equal(
    whatsappBold('Compare **A** and **B**. (**हिंदी**)'),
    'Compare *A* and *B*. (*हिंदी*)',
  );
});

test('native formatting and repeated cleanup preserve content', () => {
  const text = '*Brief*\n- _Tentative_ visit at 10 am\n1. ~Old date~\n> Quoted line';
  assert.equal(whatsappBold(text), text);
  assert.equal(finishReply(finishReply('**Ready** — 9–10 am.')), '*Ready*, 9-10 am.');
});

test('does not rewrite code, URLs, arithmetic, escaped or incomplete markers', () => {
  const unchanged = [
    '`**literal**` and `2**3**2`',
    '``**literal**`` and ``a`**literal**`b``',
    '```text\n**literal**\n```',
    '```\n**unfinished code**',
    'https://example.test/?q=**literal**',
    'www.example.test/**literal**',
    '2**3**2 and 2 ** 3 ** 4',
    String.raw`\**literal**`,
    String.raw`**literal\**`,
    '**unfinished and ** spaced **',
    '**Across\nlines**',
    '***nested*** and ****',
    'file**name**.txt',
  ];
  for (const text of unchanged) assert.equal(whatsappBold(text), text);
  assert.equal(whatsappBold('`**literal**` then **Ready**'), '`**literal**` then *Ready*');
});

test('answer normalization does not alter exact quoted voice transcripts', async () => {
  const transcript = '**Exact spoken symbols** and _underscores_';
  const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
  const store = {
    async get() {
      return [{ id, kind: 'audio', state: 'ready', text: transcript }];
    },
  } as unknown as MediaStore;
  const result = await renderVoiceReply(
    finishReply('**Understood**'),
    { owner: 'a'.repeat(64), ids: [id] },
    store,
  );
  assert.equal(result.text, `_"${transcript}"_\n\n*Understood*`);
  assert.equal(result.transcripts[0]?.text, transcript);
});
