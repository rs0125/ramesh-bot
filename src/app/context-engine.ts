/** Explicit composition point for future workers; creating services opens no connection. */
import type { ContextEngineConfig } from '../config/context-engine.js';
import { ContextEngineMcpClient } from '../infrastructure/context-engine/mcp-client.js';
import { ContextEngineServices } from '../modules/context-engine/context.service.js';
import {
  disconnectedContextCredentials,
  type ContextCredentialResolver,
} from '../modules/context-engine/context.types.js';
import type { PrismaClient } from '@prisma/client';
import type { WAMessage } from '@whiskeysockets/baileys';
import { ContextCredentialStore } from '../infrastructure/database/context-credentials.js';
import { ContextOAuthClient } from '../infrastructure/context-engine/oauth-client.js';
import { WhatsAppEmployeeResolver } from '../infrastructure/whatsapp/employee-sender.js';
import {
  EmployeeIdentityResolver,
  type EmployeeRoster,
} from '../modules/identity/employee-identity.js';
import { EmployeeContextCredentials } from '../modules/context-engine/employee-credentials.js';

export function createContextEngineServices(
  config: ContextEngineConfig | undefined,
  credentials: ContextCredentialResolver = disconnectedContextCredentials,
) {
  return config
    ? new ContextEngineServices(new ContextEngineMcpClient(config, credentials))
    : undefined;
}

/** Concrete identity/credential composition. No business tools are added to the conversational graph. */
export function createEmployeeContextAccess(
  config: ContextEngineConfig,
  dependencies: {
    db: PrismaClient;
    encryptionKey: string;
    accountId: string;
    roster: EmployeeRoster;
    fetcher?: typeof fetch;
  },
) {
  const identities = new EmployeeIdentityResolver(dependencies.roster);
  const store = new ContextCredentialStore(
    dependencies.db,
    dependencies.encryptionKey,
    dependencies.accountId,
    config.endpoint,
  );
  const credentials = new EmployeeContextCredentials(
    config,
    identities,
    store,
    new ContextOAuthClient(config, dependencies.fetcher),
    async (value, signal) => {
      const verifier = new ContextEngineMcpClient(
        config,
        {
          async resolve() {
            return {
              employeeId: value.employeeId,
              phoneE164: value.phoneE164,
              active: true,
              accessToken: value.accessToken,
              expiresAtMs: value.accessExpiresAtMs,
            };
          },
        },
        dependencies.fetcher,
      );
      await verifier.call(
        { phoneE164: value.phoneE164, audience: 'dm' },
        'get_context',
        {},
        signal,
      );
    },
  );
  const whatsapp = new WhatsAppEmployeeResolver(
    dependencies.db,
    dependencies.encryptionKey,
    identities,
  );
  const services = new ContextEngineServices(
    new ContextEngineMcpClient(config, credentials, dependencies.fetcher),
  );
  return {
    identities,
    credentials,
    whatsapp,
    async forMessage(
      message: Pick<WAMessage, 'key'>,
      signal = AbortSignal.timeout(config.timeoutMs),
    ) {
      const resolved = await whatsapp.resolve(message, signal);
      return resolved?.sender.audience === 'dm' ? services.forSender(resolved.sender) : null;
    },
  };
}
