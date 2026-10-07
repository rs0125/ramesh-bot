/** Typed outcome contract shared by planner, worker and verifier. Never an authorization grant. */
import { z } from 'zod';
export const routeSchema = z
  .object({
    route: z.enum(['direct', 'work']),
    // Routing label only. Never forward a router paraphrase as a requirements brief.
    objective: z.string().min(1).max(2000),
    reply: z.string().max(12000),
    workflow: z.enum(['general', 'personal', 'lookup']).default('general'),
    lookupTools: z.array(z.string().min(1).max(100)).max(3).default([]),
  })
  .strict();
export const taskPlanSchema = z
  .object({
    objective: z.string().min(1).max(2000),
    successCriteria: z.array(z.string().min(1).max(600)).min(1).max(8),
    clarification: z
      .object({
        question: z.string().trim().min(1).max(600),
        missingDecision: z.string().trim().min(1).max(600),
      })
      .strict()
      .nullable()
      .default(null),
    steps: z
      .array(
        z
          .object({
            id: z.string().min(1).max(40),
            goal: z.string().min(1).max(800),
            dependsOn: z.array(z.string()).max(8),
            toolNames: z.array(z.string()).max(12),
          })
          .strict(),
      )
      .max(8),
  })
  .strict();
export type TaskPlan = z.infer<typeof taskPlanSchema>;
/** A routing hint can skip planning only for names in the authenticated read catalogue. */
export function lookupPlan(
  objective: string,
  names: readonly string[],
  readTools: readonly { name: string }[],
): TaskPlan | undefined {
  if (
    !names.length ||
    names.length > 3 ||
    new Set(names).size !== names.length ||
    names.some((name) => !readTools.some((tool) => tool.name === name))
  )
    return undefined;
  return validateTaskPlan(
    {
      objective,
      successCriteria: [
        'Answer the entire explicit request using current authorized evidence; preserve scope, units and dates. Clarify ambiguity and state missing evidence instead of guessing.',
      ],
      steps: [{ id: 'lookup', goal: objective, dependsOn: [], toolNames: [...names] }],
    },
    readTools,
  );
}
export function validateTaskPlan(value: unknown, tools: readonly { name: string }[]): TaskPlan {
  const plan = taskPlanSchema.parse(value);
  // A question is a complete planning outcome, never permission to execute a guess.
  if (plan.clarification ? plan.steps.length !== 0 : plan.steps.length === 0)
    throw new Error('INVALID_TASK_PLAN');
  const allowed = new Set(tools.map((t) => t.name));
  const prior = new Set<string>();
  for (const step of plan.steps) {
    if (
      prior.has(step.id) ||
      step.dependsOn.some((id) => !prior.has(id)) ||
      step.toolNames.some((name) => !allowed.has(name))
    )
      throw new Error('INVALID_TASK_PLAN');
    prior.add(step.id);
  }
  return plan;
}
