/** Classifies session failures and calculates bounded backoff without opening sockets. */
import { DisconnectReason } from '@whiskeysockets/baileys';

const terminalCodes: ReadonlySet<number> = new Set([
  DisconnectReason.loggedOut,
  DisconnectReason.badSession,
  DisconnectReason.connectionReplaced,
  DisconnectReason.forbidden,
]);

export function disconnectCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('output' in error)) return undefined;
  const output = error.output;
  if (!output || typeof output !== 'object' || !('statusCode' in output)) return undefined;
  return typeof output.statusCode === 'number' ? output.statusCode : undefined;
}

/** null means operator action is needed; retrying a revoked session cannot repair it. */
export function reconnectDelay(code: number | undefined, attempt: number): number | null {
  if (code !== undefined && terminalCodes.has(code)) return null;
  if (code === DisconnectReason.restartRequired) return 500;
  return Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
}
