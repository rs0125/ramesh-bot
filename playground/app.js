/* Browser-only fake chat. Build text/emphasis nodes, never interpret model-generated HTML. */
const token = document.querySelector('meta[name="playground-token"]').content;
const session = crypto.randomUUID();
const sender = document.querySelector('#sender');
const audience = document.querySelector('#audience');
const messages = document.querySelector('#messages');
const empty = document.querySelector('#empty');
const input = document.querySelector('#message');
const sendButton = document.querySelector('#send');
const reset = document.querySelector('#reset');
const info = document.querySelector('#run-info');
const histories = new Map();
let busy = 0;
const renderedReplies = new Set();
const key = () => `${sender.value}-${audience.value}`;
const identity = () => ({
  conversation: `${session}-${key()}`,
  sender: sender.value,
  group: audience.value === 'group',
});
const history = () => {
  if (!histories.has(key())) histories.set(key(), []);
  return histories.get(key());
};

function renderMessageText(node, source) {
  let offset = 0;
  for (const match of source.matchAll(/\*\*([^*\n]+)\*\*|\*([^*\n]+)\*/g)) {
    const end = match.index + match[0].length;
    // Do not reinterpret multiplication or asterisks inside identifiers as markup.
    if (/\w/.test(source[match.index - 1] || '') || /\w/.test(source[end] || '')) continue;
    node.append(document.createTextNode(source.slice(offset, match.index)));
    const emphasis = document.createElement('strong');
    emphasis.textContent = match[1] || match[2];
    node.append(emphasis);
    offset = end;
  }
  node.append(document.createTextNode(source.slice(offset)));
}

function render() {
  messages.replaceChildren();
  if (!history().length) messages.append(empty);
  for (const message of history()) {
    const row = document.createElement('div');
    row.className = `message-row ${message.role}`;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    const text = document.createElement('div');
    text.className = 'message-text';
    if (message.transcripts?.length) {
      for (const [index, transcript] of message.transcripts.entries()) {
        if (message.transcripts.length > 1)
          text.append(document.createTextNode(`Voice note ${index + 1}\n`));
        if (transcript.text === undefined)
          text.append(document.createTextNode('Voice transcript unavailable or expired.'));
        else {
          if (transcript.excerpt)
            text.append(document.createTextNode('Transcript excerpt (message limit):\n'));
          const quote = document.createElement('em');
          quote.textContent = `"${transcript.text}"`;
          text.append(quote);
        }
        text.append(document.createTextNode('\n\n'));
      }
      renderMessageText(text, message.responseText);
    } else renderMessageText(text, message.text);
    const time = document.createElement('small');
    time.textContent = message.time;
    bubble.append(text, time);
    row.append(bubble);
    messages.append(row);
  }
  if (busy) {
    const typing = document.createElement('div');
    typing.className = 'typing';
    typing.textContent = 'Ramesh is typing…';
    messages.append(typing);
  }
  messages.scrollTop = messages.scrollHeight;
}
const time = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
function setBusy(value) {
  busy = Math.max(0, busy + (value ? 1 : -1));
  sendButton.disabled = false;
  reset.disabled = !!busy;
  sender.disabled = !!busy;
  audience.disabled = !!busy;
  input.disabled = false;
}
async function api(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Playground-Token': token },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Something went wrong.');
  return result;
}
async function send(textOverride, mediaIds = [], forwardedOverride) {
  const text = textOverride ?? input.value.trim();
  if (!text) return;
  const forwarded = forwardedOverride ?? document.querySelector('#forwarded').checked;
  history().push({ role: 'user', text: (forwarded ? '↪ Forwarded\n' : '') + text, time: time() });
  input.value = '';
  input.style.height = '';
  setBusy(true);
  info.textContent = 'Preparing a reply…';
  render();
  try {
    const result = await api('/api/chat', {
      ...identity(),
      text,
      messageId: crypto.randomUUID(),
      forwarded,
      mediaIds,
    });
    if (!result.queueId || !renderedReplies.has(result.queueId)) {
      history().push({
        role: 'assistant',
        text: result.text,
        responseText: result.responseText,
        transcripts: result.transcripts,
        time: time(),
      });
      if (result.queueId) renderedReplies.add(result.queueId);
    }
    const stages = result.trace.stages
      .map((stage) => `${stage.stage} ${(stage.durationMs / 1000).toFixed(1)}s`)
      .join(' · ');
    info.textContent =
      result.outcome === 'suppressed'
        ? 'Saved result suppressed after an access or freshness change'
        : result.trace.outcome === 'completed'
          ? `${stages} · ${result.outcome === 'captured' ? 'Captured in Supabase test queue' : 'SQLite claim saved'}`
          : 'The request could not complete. Try again shortly.';
  } catch (error) {
    history().push({ role: 'error', text: error.message, time: time() });
    info.textContent = 'Message failed';
  } finally {
    setBusy(false);
    render();
    input.focus({ preventScroll: true });
  }
}
document.querySelector('#composer').addEventListener('submit', (event) => {
  event.preventDefault();
  void send();
});
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void send();
  }
});
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 144)}px`;
});
document.querySelectorAll('[data-message]').forEach((button) =>
  button.addEventListener('click', () => {
    input.value = button.dataset.message;
    void send();
  }),
);
for (const select of [sender, audience])
  select.addEventListener('change', () => {
    info.textContent = 'Separate chat context selected';
    render();
    input.focus();
  });
reset.addEventListener('click', async () => {
  if (busy) return;
  setBusy(true);
  try {
    await api('/api/reset', identity());
    histories.set(key(), []);
    info.textContent = 'Fresh conversation started';
  } catch (error) {
    info.textContent = error.message;
  } finally {
    setBusy(false);
    render();
    input.focus();
  }
});

document.querySelector('#attachment').addEventListener('change', async (event) => {
  const files = [...event.target.files];
  event.target.value = '';
  await Promise.all(
    files.slice(0, 8).map(async (file) => {
      try {
        if (file.size > 8 * 1024 * 1024) throw new Error('Attachments must be at most 8 MB each.');
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1]);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        const result = await api('/api/media', {
          ...identity(),
          name: file.name,
          mime: file.type,
          data,
          sourceId: crypto.randomUUID(),
        });
        await send(
          `[Attachment: ${file.name}]`,
          [result.id],
          document.querySelector('#forwarded').checked,
        );
      } catch (error) {
        history().push({ role: 'error', text: error.message, time: time() });
        render();
      }
    }),
  );
});
