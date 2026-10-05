/** Local-only persistence for development/evaluations. Never opens a business/message database. */
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { authCipher } from './auth-store.js';
import {
  contextStateSchema,
  type ContextStore,
  type ContextScope,
  type ContextState,
  type ContextSnapshot,
} from '../../modules/assistant/chat-context.js';

export class LocalChatContextStore implements ContextStore {
  private readonly cipher;
  // Serializes store instances in this process. Separate processes must use separate eval directories.
  private static pending: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly directory: string,
    encryptionKey: string,
  ) {
    this.cipher = authCipher(encryptionKey);
  }
  private path(scope: ContextScope) {
    if (!/^[a-f0-9]{64}$/.test(scope.key)) throw new Error('CONTEXT_SCOPE_INVALID');
    return join(this.directory, `${scope.key}.json.enc`);
  }
  async load(scope: ContextScope): Promise<ContextSnapshot | null> {
    let encrypted: string;
    try {
      encrypted = await readFile(this.path(scope), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const envelope = JSON.parse(encrypted) as { owner: string; encrypted: string };
    if (!/^[a-f0-9]{64}$/.test(envelope.owner) || typeof envelope.encrypted !== 'string')
      throw new Error('CONTEXT_ENVELOPE_INVALID');
    if (envelope.owner !== scope.owner) return null;
    const value = this.cipher.open(
      `local-chat-context:${scope.employeeId}:${scope.owner}`,
      scope.key,
      envelope.encrypted,
    ) as ContextSnapshot;
    if (!Number.isSafeInteger(value.revision) || value.revision < 1)
      throw new Error('CONTEXT_REVISION_INVALID');
    return { revision: value.revision, state: contextStateSchema.parse(value.state) };
  }
  save(scope: ContextScope, expectedRevision: number, state: ContextState): Promise<boolean> {
    const operation = LocalChatContextStore.pending.then(async () => {
      if (((await this.load(scope))?.revision ?? 0) !== expectedRevision) return false;
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const path = this.path(scope);
      const temporary = `${path}.${randomUUID()}.tmp`;
      const value = { revision: expectedRevision + 1, state: contextStateSchema.parse(state) };
      await writeFile(
        temporary,
        JSON.stringify({
          owner: scope.owner,
          encrypted: this.cipher.seal(
            `local-chat-context:${scope.employeeId}:${scope.owner}`,
            scope.key,
            value,
          ),
        }),
        { mode: 0o600, flag: 'wx' },
      );
      await rename(temporary, path);
      return true;
    });
    LocalChatContextStore.pending = operation.catch(() => {});
    return operation;
  }
}
