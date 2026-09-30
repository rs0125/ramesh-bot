/** Spaces replies with bounded jitter; cancellation never leaves a shutdown waiting on a timer. */
import { setTimeout as sleep } from 'node:timers/promises';
import type { BeforeReply } from '../modules/greetings/greeting.types.js';

export interface ReplyDelayOptions {
  readonly minMs: number;
  readonly maxMs: number;
}

export function createReplyDelay(
  options: ReplyDelayOptions,
  random: () => number = Math.random,
  wait: (ms: number, signal?: AbortSignal) => Promise<void> = (ms, signal) =>
    sleep(ms, undefined, { signal }),
): BeforeReply {
  return async (signal) => {
    if (signal?.aborted) return false;
    const delay = options.minMs + Math.floor(random() * (options.maxMs - options.minMs + 1));
    try {
      await wait(delay, signal);
      return !signal?.aborted;
    } catch (error) {
      if (signal?.aborted && error instanceof Error && error.name === 'AbortError') return false;
      throw error;
    }
  };
}
