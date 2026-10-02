/** Trusted server-side attribution, never part of the model's input or tool arguments. */
import { AsyncLocalStorage } from 'node:async_hooks';
export interface UsageScope {
  runId: string;
  subjectId?: string;
}
const scopes = new AsyncLocalStorage<{ scope: UsageScope; stage?: string }>();
export function currentUsageScope() {
  return scopes.getStore();
}
export function withUsageScope<T>(scope: UsageScope, work: () => Promise<T>): Promise<T> {
  // A copy prevents callers from changing a submitted request's attribution.
  return scopes.run({ scope: { ...scope } }, work);
}
export function withUsageStage<T>(stage: string, work: () => Promise<T>): Promise<T> {
  const current = scopes.getStore();
  return scopes.run({ scope: current?.scope ?? { runId: 'unscoped' }, stage }, work);
}
/** Called only after the application's live identity resolver has verified the employee. */
export function bindUsageEmployee(employeeId: number): void {
  if (!Number.isSafeInteger(employeeId) || employeeId <= 0)
    throw new Error('INVALID_USAGE_EMPLOYEE');
  const current = scopes.getStore();
  if (current) current.scope.subjectId = `employee:${employeeId}`;
}
