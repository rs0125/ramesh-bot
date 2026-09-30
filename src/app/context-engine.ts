/** Explicit composition point for future workers; creating services opens no connection. */
import type { ContextEngineConfig } from '../config/context-engine.js';
import { ContextEngineMcpClient } from '../infrastructure/context-engine/mcp-client.js';
import { ContextEngineServices } from '../modules/context-engine/context.service.js';
import {
  disconnectedContextCredentials,
  type ContextCredentialResolver,
} from '../modules/context-engine/context.types.js';

export function createContextEngineServices(
  config: ContextEngineConfig | undefined,
  credentials: ContextCredentialResolver = disconnectedContextCredentials,
) {
  return config
    ? new ContextEngineServices(new ContextEngineMcpClient(config, credentials))
    : undefined;
}
