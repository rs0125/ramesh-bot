import test from 'node:test';
import assert from 'node:assert/strict';
import { generateWAMessageContent } from '@whiskeysockets/baileys';
import { plainTextMessage } from '../../src/infrastructure/whatsapp/baileys-session.js';

test('outgoing text preserves URL text without invoking the SDK preview fetcher', async () => {
  const text = 'Source label: https://example.invalid/private-reference?fixture=private';
  let previews = 0;
  const getUrlInfo = async () => {
    previews++;
    return undefined;
  };
  const upload = async () => assert.fail('Plain text must not upload media');
  // Confirm that this installed SDK would otherwise enter its automatic preview path.
  await generateWAMessageContent({ text }, { getUrlInfo, upload });
  assert.equal(previews, 1);
  previews = 0;
  const payload = plainTextMessage(text);
  assert.equal(payload.text, text);
  assert.equal(payload.linkPreview, null);
  const message = await generateWAMessageContent(payload, { getUrlInfo, upload });
  assert.equal(previews, 0);
  assert.equal(message.extendedTextMessage?.text, text);
  assert.equal(message.extendedTextMessage?.jpegThumbnail, undefined);
});
