/** Bounded read executor. Authority comes from the trusted message, never from model arguments. */
import type { TrustedReplyContext } from '../greetings/greeting.types.js';
import { ContextEngineError, type ContextEvidence } from '../context-engine/context.types.js';
import {
  FOLLOWUPS_QUERY,
  verifyFollowups,
  followupsDelivery,
  followupsDeliverySchema,
  followupsFingerprint,
  indiaDate,
  type FollowupsFacts,
  type FollowupsDelivery,
} from './followups.js';
import { ContextToolRun, type BoundContextReader } from './tool-executor.js';
import {
  toolDeliverySchema,
  verifyToolEvidence,
  toolEvidenceFingerprint,
} from './tool-evidence.js';

export interface BoundCrmReader {
  employeeId: number;
  search(args: typeof FOLLOWUPS_QUERY, signal: AbortSignal): Promise<ContextEvidence>;
  tools?: BoundContextReader;
}
export type BusinessAccessResolver = (
  key: TrustedReplyContext['key'],
  signal: AbortSignal,
) => Promise<BoundCrmReader | null>;
export type BusinessReadResult =
  | { outcome: 'verified'; facts: FollowupsFacts; delivery: FollowupsDelivery }
  | { outcome: 'denied' | 'unavailable' };

export class BusinessReadService {
  private readonly employees: ReadonlySet<number> | null;
  constructor(
    private readonly resolve: BusinessAccessResolver,
    employeeIds: readonly number[] | 'all',
    private readonly now = Date.now,
    readonly toolLoop = false,
  ) {
    if (
      employeeIds !== 'all' &&
      (!employeeIds.length || employeeIds.some((id) => !Number.isSafeInteger(id) || id < 1))
    )
      throw new Error('A business-read pilot employee list is required');
    this.employees = employeeIds === 'all' ? null : new Set(employeeIds);
  }

  private permits(employeeId: number) {
    return (
      Number.isSafeInteger(employeeId) &&
      employeeId > 0 &&
      (this.employees === null || this.employees.has(employeeId))
    );
  }

  async openTools(
    trusted: TrustedReplyContext | undefined,
    signal: AbortSignal,
  ): Promise<{
    status: 'available' | 'denied' | 'unavailable';
    run?: ContextToolRun;
  }> {
    if (
      !this.toolLoop ||
      !trusted ||
      trusted.key.fromMe ||
      !trusted.key.remoteJid ||
      !/@(s\.whatsapp\.net|lid)$/.test(trusted.key.remoteJid)
    )
      return { status: 'denied' };
    try {
      const run = await ContextToolRun.open(
        async (currentSignal) => {
          const reader = await this.resolve(trusted.key, currentSignal);
          return reader &&
            this.permits(reader.employeeId) &&
            reader.tools?.employeeId === reader.employeeId
            ? reader.tools
            : null;
        },
        trusted.record,
        signal,
        this.now,
      );
      return run ? { status: 'available', run } : { status: 'denied' };
    } catch (error) {
      signal.throwIfAborted();
      return {
        status:
          error instanceof ContextEngineError &&
          ['AUTH_REQUIRED', 'ACCESS_DENIED'].includes(error.code)
            ? 'denied'
            : 'unavailable',
      };
    }
  }

  async read(
    trusted: TrustedReplyContext | undefined,
    signal: AbortSignal,
  ): Promise<BusinessReadResult> {
    if (
      !trusted ||
      trusted.key.fromMe ||
      !trusted.key.remoteJid ||
      !/@(s\.whatsapp\.net|lid)$/.test(trusted.key.remoteJid)
    )
      return { outcome: 'denied' };
    try {
      signal.throwIfAborted();
      const reader = await this.resolve(trusted.key, signal);
      if (!reader || !this.permits(reader.employeeId)) return { outcome: 'denied' };
      await trusted.record?.('tool_started', {
        version: 1,
        tool: 'search_crm_leads',
        employeeId: reader.employeeId,
        arguments: FOLLOWUPS_QUERY,
      });
      const evidence = await reader.search(FOLLOWUPS_QUERY, signal);
      signal.throwIfAborted();
      const facts = verifyFollowups(evidence, this.now());
      // A changed roster binding must not transfer an in-flight answer to a different employee.
      const current = await this.resolve(trusted.key, signal);
      if (!current || current.employeeId !== reader.employeeId)
        throw new ContextEngineError('AUTH_REQUIRED');
      await trusted.record?.('tool_succeeded', {
        version: 1,
        tool: 'search_crm_leads',
        employeeId: reader.employeeId,
        sourcePath: facts.sourcePath,
        requestId: facts.requestId,
        facts,
      });
      signal.throwIfAborted();
      return {
        outcome: 'verified',
        facts,
        delivery: followupsDelivery(reader.employeeId, facts, this.now()),
      };
    } catch (error) {
      signal.throwIfAborted();
      const code = error instanceof ContextEngineError ? error.code : 'UNAVAILABLE';
      await trusted.record?.('tool_failed', { version: 1, tool: 'search_crm_leads', code });
      return {
        outcome: ['AUTH_REQUIRED', 'ACCESS_DENIED'].includes(code) ? 'denied' : 'unavailable',
      };
    }
  }

  /** Recheck the same scoped page before sending. Changed/revoked results are suppressed, never regenerated. */
  async canDeliver(
    key: TrustedReplyContext['key'],
    stored: unknown,
    signal: AbortSignal,
    onFailure?: (reason: string, tool?: string) => void,
  ): Promise<boolean> {
    const deny = (reason: string, tool?: string) => {
      onFailure?.(reason, tool);
      return false;
    };
    const general = toolDeliverySchema.safeParse(stored);
    if (general.success) {
      const receipt = general.data;
      const now = this.now();
      if (
        !this.toolLoop ||
        !key.remoteJid ||
        key.fromMe ||
        !/@(s\.whatsapp\.net|lid)$/.test(key.remoteJid) ||
        !this.permits(receipt.employeeId) ||
        receipt.localDate !== indiaDate(now) ||
        Date.parse(receipt.expiresAt) <= now ||
        Date.parse(receipt.preparedAt) > now + 60000 ||
        now - Date.parse(receipt.preparedAt) > 300000
      )
        return deny('INVALID_OR_EXPIRED_RECEIPT');
      try {
        const pending = [...receipt.checks];
        const verify = async (check: (typeof receipt.checks)[number]) => {
          const reader = await this.resolve(key, signal);
          if (
            !reader?.tools ||
            reader.employeeId !== receipt.employeeId ||
            reader.tools.employeeId !== receipt.employeeId
          )
            return deny('IDENTITY_CHANGED', check.tool);
          const result = await reader.tools.call(check.tool, check.arguments, signal);
          signal.throwIfAborted();
          verifyToolEvidence(check.tool, check.arguments, result, this.now());
          const current = await this.resolve(key, signal);
          if (current?.employeeId !== receipt.employeeId)
            return deny('IDENTITY_CHANGED', check.tool);
          if (toolEvidenceFingerprint(result) !== check.fingerprint)
            return deny('SOURCE_CHANGED', check.tool);
          return true;
        };
        const workers = await Promise.all(
          Array.from({ length: Math.min(3, pending.length) }, async () => {
            for (;;) {
              const check = pending.shift();
              if (!check) return true;
              if (!(await verify(check))) return false;
            }
          }),
        );
        return workers.every(Boolean) && !signal.aborted;
      } catch (error) {
        return deny(
          signal.aborted
            ? 'CANCELLED'
            : error instanceof ContextEngineError
              ? error.code
              : 'UNAVAILABLE',
        );
      }
    }
    const parsed = followupsDeliverySchema.safeParse(stored);
    if (!parsed.success) return deny('INVALID_RECEIPT');
    const receipt = parsed.data;
    const now = this.now();
    if (
      Date.parse(receipt.expiresAt) <= now ||
      Date.parse(receipt.preparedAt) > now + 60_000 ||
      now - Date.parse(receipt.preparedAt) > 300_000 ||
      receipt.localDate !== indiaDate(now) ||
      !this.permits(receipt.employeeId)
    )
      return false;
    const result = await this.read({ key, runId: 'delivery-preflight' }, signal);
    return (
      result.outcome === 'verified' &&
      result.delivery.employeeId === receipt.employeeId &&
      followupsFingerprint(result.facts) === receipt.fingerprint
    );
  }
}
