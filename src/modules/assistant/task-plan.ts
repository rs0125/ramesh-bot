/** Typed outcome contract shared by planner, worker and verifier. Never an authorization grant. */
import { z } from 'zod';
export const routeSchema = z
  .object({
    route: z.enum(['direct', 'work']),
    objective: z.string().min(1).max(2000),
    reply: z.string().max(12000),
    workflow: z.enum(['general', 'personal']).default('general'),
  })
  .strict();
export const taskPlanSchema = z
  .object({
    objective: z.string().min(1).max(2000),
    successCriteria: z.array(z.string().min(1).max(600)).min(1).max(8),
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
      .min(1)
      .max(8),
  })
  .strict();
export type TaskPlan = z.infer<typeof taskPlanSchema>;
export function validateTaskPlan(value: unknown, tools: readonly { name: string }[]): TaskPlan {
  const plan = taskPlanSchema.parse(value);
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
