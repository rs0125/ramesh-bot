/* Browser-only fake chat. Text is rendered with textContent, never model-generated HTML. */
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
let busy = false;
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
    text.textContent = message.text;
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
  busy = value;
  sendButton.disabled = value;
  reset.disabled = value;
  sender.disabled = value;
  audience.disabled = value;
  input.disabled = value;
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
async function send() {
  const text = input.value.trim();
  if (!text || busy) return;
  history().push({ role: 'user', text, time: time() });
  input.value = '';
  input.style.height = '';
  setBusy(true);
  info.textContent = 'Converser → formatter';
  render();
  try {
    const result = await api('/api/chat', { ...identity(), text });
    history().push({ role: 'assistant', text: result.text, time: time() });
    const stages = result.trace.stages
      .map((stage) => `${stage.stage} ${(stage.durationMs / 1000).toFixed(1)}s`)
      .join(' · ');
    info.textContent =
      result.trace.outcome === 'completed'
        ? `${stages} · SQLite claim saved`
        : 'The model could not complete this reply. Try again shortly.';
  } catch (error) {
    history().push({ role: 'error', text: error.message, time: time() });
    info.textContent = 'Message failed';
  } finally {
    setBusy(false);
    render();
    input.focus();
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
