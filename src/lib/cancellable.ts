/** Bounds asynchronous adapters even when a test double or dependency ignores its AbortSignal. */
import { ContextEngineError } from '../modules/context-engine/context.types.js';

export async function cancellable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new ContextEngineError('CANCELLED');
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new ContextEngineError('CANCELLED'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(work), cancelled]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
