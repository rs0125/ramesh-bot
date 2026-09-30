/** Central logging policy. Callers create child loggers for their own module. */
import pino, { type LevelWithSilent, type Logger } from 'pino';

export function createLogger(level: LevelWithSilent): Logger {
  return pino({
    level,
    base: { service: 'sales-whatsapp-bot' },
    // Message bodies and pairing QR values should never be passed to the logger.
    redact: {
      paths: ['auth', 'creds', 'token', 'password', 'apiKey', '*.authorization'],
      remove: true,
    },
  });
}
