/** Shared employee-pinned CRM reader. Contains no delivery or device-state dependency. */
import type { ContextEngineConfig } from '../config/context-engine.js';
import type { EmployeeIdentity } from '../modules/identity/employee-identity.js';
import type {
  ContextCredentialResolver,
  ContextSender,
} from '../modules/context-engine/context.types.js';
import type { BoundCrmReader } from '../modules/assistant/business-reads.js';
import { ContextEngineMcpClient } from '../infrastructure/context-engine/mcp-client.js';
import { ContextEngineServices } from '../modules/context-engine/context.service.js';

export function scopedCrmReader(
  config: ContextEngineConfig,
  credentials: ContextCredentialResolver,
  employee: EmployeeIdentity,
  sender: ContextSender,
): BoundCrmReader {
  const services = new ContextEngineServices(
    new ContextEngineMcpClient(config, {
      async resolve(actor, signal) {
        const grant = await credentials.resolve(actor, signal);
        return grant?.employeeId === employee.employeeId ? grant : null;
      },
    }),
  ).forSender(sender);
  return {
    employeeId: employee.employeeId,
    search: (args, signal) => services.crm.search(args, signal),
    ...(services.writes ? { writes: { employeeId: employee.employeeId, ...services.writes } } : {}),
    tools: {
      employeeId: employee.employeeId,
      discover: (signal) => services.discover(signal),
      describe: (signal) => services.describe(signal),
      call: (name, args, signal) => services.call(name, args, signal),
    },
  };
}
