/** Third-party transport logs never receive permission to publish protocol objects or message text. */
import type { Logger } from 'pino';

const methods = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
const safeCodes = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

function errorCode(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const candidate of [record, record.err, record.error]) {
    if (!candidate || typeof candidate !== 'object') continue;
    const code = (candidate as Record<string, unknown>).code;
    if (typeof code === 'string' && safeCodes.has(code)) return code;
  }
  return undefined;
}

/** Retain Pino's level/introspection interface; child bindings and SDK text are discarded. */
export function privateTransportLogger(sink: Logger): Logger {
  const wrapped: Logger = new Proxy(sink, {
    get(target, property) {
      if (typeof property === 'string' && methods.has(property))
        return (...args: unknown[]) => {
          const code = errorCode(args[0]);
          const method = property as 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
          target[method](
            { event: 'whatsapp_transport_log', ...(code ? { code } : {}) },
            'WhatsApp transport event',
          );
        };
      // Baileys uses children to attach class/node context. That context can contain identities.
      if (property === 'child') return () => wrapped;
      if (property === 'setBindings') return () => undefined;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return wrapped;
}
