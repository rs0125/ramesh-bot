/** Deployment ordering, independent of AWS/systemd so failure paths can be exercised locally. */
export interface ReleaseSteps {
  prepare(): Promise<void>;
  assertCurrent(): Promise<void>;
  stop(): Promise<void>;
  backup(): Promise<void>;
  migrate(): Promise<void>;
  activate(): Promise<void>;
  start(): Promise<void>;
  verify(): Promise<void>;
  restoreDatabase(): Promise<void>;
  rollbackCode(): Promise<void>;
  recordSuccess(): Promise<void>;
}

export async function release(steps: ReleaseSteps): Promise<void> {
  // Installation/build failures leave the running service untouched.
  await steps.prepare();
  await steps.assertCurrent();
  let stopped = false;
  let snapshot = false;
  let candidateStarted = false;
  try {
    stopped = true;
    await steps.stop();
    await steps.backup();
    snapshot = true;
    await steps.migrate();
    await steps.activate();
    // Treat even a partially failed start as live: Signal keys may already have advanced.
    candidateStarted = true;
    await steps.start();
    await steps.verify();
    await steps.recordSuccess();
  } catch (error) {
    if (stopped) {
      await steps.stop();
      if (snapshot && !candidateStarted) await steps.restoreDatabase();
      await steps.rollbackCode();
    }
    throw error;
  }
}

export function commitSha(value: string): string {
  if (!/^[a-f0-9]{40}$/.test(value)) throw new Error('Expected a full lowercase commit SHA');
  return value;
}

/** Automatic rollback requires immutable migration history and backward-compatible additions. */
export function checkMigrations(previous: Map<string, string>, next: Map<string, string>): void {
  for (const [name, sql] of previous) {
    if (next.get(name) !== sql) throw new Error(`Migration history changed: ${name}`);
  }
  const last = [...previous.keys()].sort().at(-1) ?? '';
  for (const [name, sql] of next) {
    if (previous.has(name)) continue;
    if (name <= last) throw new Error('New migrations must follow existing history');
    const statements = sql
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/--[^\r\n]*/g, '')
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean);
    if (!statements.length) throw new Error('Empty migration');
    for (const statement of statements) {
      // Deliberately conservative; triggers, table rebuilds, data rewrites, and new unique
      // indexes require an operator-led migration with an explicit compatibility plan.
      const create = /^CREATE\s+(?:TABLE|INDEX)\s+"[A-Za-z0-9_]+"\s/i.test(statement);
      const column =
        /^ALTER\s+TABLE\s+"[A-Za-z0-9_]+"\s+ADD\s+COLUMN\s+"[A-Za-z0-9_]+"\s/i.test(statement) &&
        !/\b(?:NOT\s+NULL|UNIQUE|PRIMARY|REFERENCES)\b/i.test(statement);
      if (
        (!create && !column) ||
        /\b(?:DROP|DELETE|UPDATE|INSERT|ATTACH|DETACH|TRIGGER|REPLACE|PRAGMA|REFERENCES|CHECK|GENERATED)\b/i.test(
          statement,
        )
      )
        throw new Error(`Migration ${name} needs a reviewed maintenance deployment`);
    }
  }
}

export function healthyRelease(data: unknown, sha: string): boolean {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as Record<string, unknown>).status === 'ok' &&
    (data as Record<string, unknown>).release === commitSha(sha)
  );
}
