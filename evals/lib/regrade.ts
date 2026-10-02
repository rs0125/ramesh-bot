/** Regrading can change judge decisions, never recorded hard contract failures or agent answers. */
export function retainedHardChecks(checks: string[]) {
  return checks.filter(
    (c) => !/^(?:turn\d+:)?judge:(continuity|grounded|formatting|usefulness)$/.test(c),
  );
}
export function assertCompletePublicRun(report: any) {
  if (
    !report ||
    report.inputIntegrity !== true ||
    typeof report.syntheticClock !== 'string' ||
    !Array.isArray(report.scenarios) ||
    !report.scenarios.length ||
    !Number.isInteger(report.trials) ||
    report.trials < 1 ||
    !Array.isArray(report.results) ||
    report.total !== report.scenarios.length * report.trials ||
    report.results.length !== report.total
  )
    throw new Error('COMPLETE_SYNTHETIC_RUN_REQUIRED');
  const keys = new Set();
  for (const row of report.results) {
    const key = `${row.case}:${row.trial}`;
    if (
      !report.scenarios.includes(row.case) ||
      row.case.startsWith('private-') ||
      !Number.isInteger(row.trial) ||
      row.trial < 1 ||
      row.trial > report.trials ||
      keys.has(key) ||
      !Array.isArray(row.checks) ||
      !row.checks.every((c: unknown) => typeof c === 'string') ||
      !Array.isArray(row.turns)
    )
      throw new Error('INVALID_SYNTHETIC_TRIALS');
    keys.add(key);
  }
}
