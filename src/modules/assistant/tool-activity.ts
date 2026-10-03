/** Transport-owned work notification; feedback failure cannot change planning or execution. */
export function notifyToolActivity(callback?: () => void): void {
  try {
    // Async callbacks can satisfy a void signature; handle rejection without awaiting transport.
    void Promise.resolve(callback?.()).catch(() => {});
  } catch {
    // Status presentation is best effort and carries no tool arguments or results.
  }
}
