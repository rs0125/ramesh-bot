/** Model-free scheduling outcome predicates shared by the scheduling runner and smoke suite. */

/** Committed rows read back from the disposable local database after one admitted turn. */
export interface PersistedPersonalState {
  tasks: number;
  /** Committed personal mutation receipts (`kind='mutation'`); list receipts are excluded. */
  commands: number;
  reminderDeliveries: number;
  reminders: Array<{ text: unknown; dueAt: string; state: string; owner: number }>;
}

/** States that conditional reminders are unsupported, without a workaround or a false schedule claim. */
export function truthfulConditionalLimitation(reply: string): boolean {
  return (
    // "at reminder time" and "when the reminder is due" state the same limitation (smoke run 3).
    /(conditional|condition.{0,70}reminder|reminder.{0,70}condition|due[- ]time|(?:scheduled|delivery|reminder) time|when (?:the |your )?reminder is due)/i.test(
      reply,
    ) &&
    /(can[’']t|cannot|couldn[’']t|not (?:yet|supported|available)|unable|unsupported|unavailable|don[’']t support)/i.test(
      reply,
    ) &&
    !/use (?:an?|another) account|(?:get|grant|obtain).{0,45}(?:permission|access)/i.test(reply) &&
    !/(?:saved reminder|i(?:'ll| will) remind you)/i.test(reply)
  );
}

/** Independent IST calendar arithmetic; never calls the implementation's schedule normalizer. */
export function istInstant(clockMs: number, dayOffset: number, time: string): string {
  const date = new Date(clockMs + 330 * 60000).toISOString().slice(0, 10);
  const day = new Date(Date.parse(`${date}T00:00:00Z`) + dayOffset * 86400000)
    .toISOString()
    .slice(0, 10);
  return new Date(`${day}T${time}:00+05:30`).toISOString();
}
