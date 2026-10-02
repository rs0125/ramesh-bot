/** Operator-owned test scope. Production model settings never select an evaluation model. */
export const DEFAULT_EVAL_MODEL = 'gpt-6-luna';
export const evalPolicyOptions = {
  'max-trials': { type: 'string', default: '3' },
  'sol-approval': { type: 'string' },
} as const;

export function evalModel(explicit?: string, env: NodeJS.ProcessEnv = process.env) {
  return explicit ?? env.EVAL_MODEL ?? DEFAULT_EVAL_MODEL;
}

export function assertEvalRun(
  models: readonly string[],
  plannedTrials: number,
  options: { 'max-trials'?: string; 'sol-approval'?: string },
) {
  if (
    models.some((model) => /(?:^|[-_])sol(?:$|[-_])/i.test(model)) &&
    !options['sol-approval']?.trim()
  )
    throw new Error(
      'SOL_EVAL_APPROVAL_REQUIRED: ask the user for this run, then pass --sol-approval <reference>. This applies to agents and graders.',
    );
  const limit = Number(options['max-trials'] ?? '3');
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    !Number.isSafeInteger(plannedTrials) ||
    plannedTrials < 1
  )
    throw new Error('INVALID_EVAL_TRIAL_ALLOWANCE');
  if (plannedTrials > limit)
    throw new Error(
      `EVAL_TRIAL_ALLOWANCE_EXCEEDED: ${plannedTrials} planned, ${limit} allowed. Select fewer cases or explicitly set --max-trials for the agreed run.`,
    );
  return { plannedTrials, maxTrials: limit, solApproval: options['sol-approval']?.trim() ?? null };
}
