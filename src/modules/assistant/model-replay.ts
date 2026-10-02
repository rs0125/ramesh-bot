/** Request-local durable replay; completed responses bypass the provider and usage meter. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { AgentCheckpointSession } from './checkpoint.types.js';

const replay = new AsyncLocalStorage<{
  session: AgentCheckpointSession;
  sequence: number;
  busy: boolean;
  authority: unknown;
  reused: number;
}>();

export function withModelReplay<T>(session: AgentCheckpointSession | undefined, work: () => T): T {
  return session
    ? replay.run({ session, sequence: 0, busy: false, authority: 'uninitialized', reused: 0 }, work)
    : work();
}

/** Called after live discovery; a schema snapshot does not authorize a later source read. */
export function bindReplayAuthority(authority: unknown) {
  const state = replay.getStore();
  if (state) state.authority = structuredClone(authority);
}

export function replayedModelSteps() {
  return replay.getStore()?.reused ?? 0;
}

export function currentCheckpoint() {
  return replay.getStore()?.session;
}

export async function replayModelResponse<T>(
  request: unknown,
  generate: () => Promise<T>,
): Promise<{ response: T; replayed: boolean }> {
  const state = replay.getStore();
  if (!state) return { response: await generate(), replayed: false };
  if (state.busy) throw new Error('CONCURRENT_MODEL_STEP');
  state.busy = true;
  try {
    const sequence = state.sequence;
    const bound = structuredClone({ version: 1, authority: state.authority, request });
    const saved = await state.session.read<T>(sequence, bound);
    if (saved !== undefined) {
      state.sequence++;
      state.reused++;
      return { response: saved, replayed: true };
    }
    const response = await generate();
    // Commit before graph/model-session state advances. Fail closed on storage loss.
    await state.session.save(sequence, bound, response);
    state.sequence++;
    return { response, replayed: false };
  } finally {
    state.busy = false;
  }
}
