import { WorkflowStep } from '@node-forge-engine/prisma';

/**
 * Given the list of ALL steps in a workflow and a set of just-completed step IDs,
 * returns the steps that are now ready to be submitted as jobs.
 *
 * A step is ready when:
 *   1. Its status is PENDING
 *   2. ALL of its dependsOn step IDs have status COMPLETED
 */
export function resolveReadySteps(
  allSteps: WorkflowStep[],
  justCompletedStepId: string
): WorkflowStep[] {
  const completedIds = new Set(
    allSteps.filter((s) => s.status === 'COMPLETED').map((s) => s.id)
  );
  // Include the just-completed step ID in the set
  completedIds.add(justCompletedStepId);

  return allSteps.filter((step) => {
    if (step.status !== 'PENDING') return false;
    if (step.dependsOn.length === 0) return false; // first steps have no dependsOn
    return step.dependsOn.every((depId) => completedIds.has(depId));
  });
}

/**
 * Returns the first steps (those with empty dependsOn arrays).
 */
export function resolveFirstSteps(allSteps: WorkflowStep[]): WorkflowStep[] {
  return allSteps.filter((s) => s.dependsOn.length === 0);
}
