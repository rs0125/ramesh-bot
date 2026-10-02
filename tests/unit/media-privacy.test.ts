import test from 'node:test';
import assert from 'node:assert/strict';
import type { WAMessage } from '@whiskeysockets/baileys';
import { persistableMessageContent } from '../../src/infrastructure/whatsapp/media-privacy.js';
import {
  toGreetingCandidate,
  toInboxCandidate,
} from '../../src/infrastructure/whatsapp/message.mapper.js';

type Content = NonNullable<WAMessage['message']>;
const image: Content = {
  imageMessage: { caption: 'private fixture caption', mimetype: 'image/jpeg' },
};
const outer: WAMessage = {
  key: { remoteJid: '15555550100@s.whatsapp.net', id: 'fixture-message', fromMe: false },
  messageTimestamp: 1,
};

test('view-once privacy survives every supported outer wrapper before admission or download', () => {
  for (const viewOnce of [
    'viewOnceMessage',
    'viewOnceMessageV2',
    'viewOnceMessageV2Extension',
  ] as const) {
    const privateContent: Content = { [viewOnce]: { message: image } };
    const candidates: Content[] = [privateContent];
    for (const wrapper of [
      'ephemeralMessage',
      'documentWithCaptionMessage',
      'editedMessage',
      'associatedChildMessage',
      'groupStatusMessage',
      'groupStatusMessageV2',
    ] as const)
      candidates.push({ [wrapper]: { message: privateContent } });
    candidates.push({
      ephemeralMessage: { message: { documentWithCaptionMessage: { message: privateContent } } },
    });
    for (const message of candidates) {
      assert.throws(() => persistableMessageContent(message), /VIEW_ONCE_MEDIA_UNSUPPORTED/);
      assert.equal(toInboxCandidate({ ...outer, message }, []), null);
      assert.equal(toGreetingCandidate({ ...outer, message }, []), null);
    }
  }
});

test('ordinary ephemeral and forwarded media remain usable', () => {
  const forwarded: Content = {
    imageMessage: { ...image.imageMessage, contextInfo: { isForwarded: true, forwardingScore: 2 } },
  };
  const message: Content = {
    ephemeralMessage: { message: { documentWithCaptionMessage: { message: forwarded } } },
  };
  assert.deepEqual(persistableMessageContent(message), forwarded);
  const candidate = toInboxCandidate({ ...outer, message }, []);
  assert.equal(candidate?.kind, 'image');
  assert.equal(candidate?.forwarded, true);
  assert.equal(candidate?.text, 'private fixture caption');
});

test('content-level view-once flags are rejected even without a dedicated wrapper', () => {
  for (const kind of [
    'imageMessage',
    'audioMessage',
    'videoMessage',
    'extendedTextMessage',
  ] as const) {
    const content: Content = { [kind]: { viewOnce: true } };
    for (const message of [content, { ephemeralMessage: { message: content } }]) {
      assert.throws(() => persistableMessageContent(message), /VIEW_ONCE_MEDIA_UNSUPPORTED/);
      assert.equal(toInboxCandidate({ ...outer, message }, []), null);
    }
  }
});

test('malformed wrapper cycles are bounded and do not enter the queue', () => {
  const cycle: Content = {};
  cycle.ephemeralMessage = { message: cycle };
  assert.throws(() => persistableMessageContent(cycle), /MESSAGE_WRAPPER_DEPTH_EXCEEDED/);
  assert.equal(toInboxCandidate({ ...outer, message: cycle }, []), null);
  assert.equal(persistableMessageContent(undefined), undefined);
});
