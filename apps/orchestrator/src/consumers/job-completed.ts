import { kafka, Topics, produceMessage } from '@forge-engine/kafka';
import { prisma } from '@forge-engine/prisma';
import { redis, withLock, RedisKeys, RedisTTL } from '@forge-engine/redis';
import type { JobCompletedEvent, JobSubmittedEvent, WorkflowCompletedEvent, WorkflowStepDoneEvent } from '@forge-engine/types';
import { resolveReadySteps } from '../lib/step-resolver';
import { writeAuditLog } from '@forge-engine/prisma/src/audit';
import { v4 as uuidv4 } from 'uuid';

export async function startJobCompletedConsumer() {
  const consumer = kafka.consumer({
    groupId: process.env.KAFKA_GROUP_ID_ORCHESTRATOR ?? 'orchestrator',
  });
  await consumer.connect();
  await consumer.subscribe({ topics: [Topics.JOB_COMPLETED], fromBeginning: false });

  await consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      const event: JobCompletedEvent = JSON.parse(message.value.toString());

      // Standalone job (no workflow): update status in Postgres
      if (!event.workflowId || !event.stepId) {
        await prisma.job.update({
          where: { id: event.jobId },
          data: { status: 'COMPLETED', result: event.result as object, completedAt: new Date() },
        });
        await writeAuditLog({ entityType: 'JOB', entityId: event.jobId, fromStatus: 'RUNNING', toStatus: 'COMPLETED' });
        return;
      }

      // Workflow job: acquire lock, then handle transition
      await withLock(
        RedisKeys.lockWorkflow(event.workflowId),
        RedisTTL.LOCK_WORKFLOW * 1000,
        async () => {
          // RULE-3: Orchestrator is the ONLY service that writes workflow step state
          await prisma.workflowStep.update({
            where: { id: event.stepId! },
            data: { status: 'COMPLETED', result: event.result as object, executedAt: new Date() },
          });

          await prisma.job.update({
            where: { id: event.jobId },
            data: { status: 'COMPLETED', result: event.result as object, completedAt: new Date() },
          });

          await writeAuditLog({ entityType: 'JOB', entityId: event.jobId, fromStatus: 'RUNNING', toStatus: 'COMPLETED' });

          // Check if this step belongs to a parallel group (fan-in check)
          const thisStep = await prisma.workflowStep.findUnique({ where: { id: event.stepId! } });
          const allSteps = await prisma.workflowStep.findMany({ where: { workflowId: event.workflowId } });

          if (thisStep?.parallelGroup) {
            const groupName = thisStep.parallelGroup;
            const totalKey = RedisKeys.groupTotal(event.workflowId!, groupName);
            const completedKey = RedisKeys.groupCompleted(event.workflowId!, groupName);

            // Initialize total counter for the group if not set
            const totalExists = await redis.exists(totalKey);
            if (!totalExists) {
              const groupTotal = allSteps.filter((s) => s.parallelGroup === groupName).length;
              await redis.set(totalKey, groupTotal);
            }

            const completedCount = await redis.incr(completedKey);
            const totalCount = parseInt((await redis.get(totalKey)) ?? '0', 10);

            // Fan-in: only proceed if ALL jobs in the group are done
            if (completedCount < totalCount) {
              await produceMessage<WorkflowStepDoneEvent>(Topics.WORKFLOW_STEP_DONE, {
                workflowId: event.workflowId!, stepId: event.stepId!, stepName: thisStep.name,
                status: 'completed', parallelGroup: groupName,
              }, event.workflowId);
              return; // Wait for remaining group members
            }
          }

          // Find next ready steps
          const nextSteps = resolveReadySteps(allSteps, event.stepId!);

          if (nextSteps.length > 0) {
            // Submit next steps as jobs (fan-out if multiple)
            for (const nextStep of nextSteps) {
              const workflow = await prisma.workflow.findUnique({ where: { id: event.workflowId! } });
              const def = workflow?.definition as Record<string, unknown>;
              const steps = def?.steps as Array<{ name: string; payload?: Record<string, unknown> }>;
              const stepDef = steps?.find((s) => s.name === nextStep.name);
              const payload = stepDef?.payload ?? {};

              const newJobId = uuidv4();
              await prisma.job.create({
                data: { id: newJobId, type: nextStep.jobType, payload, status: 'PENDING', workflowId: event.workflowId, stepId: nextStep.id },
              });
              await prisma.workflowStep.update({ where: { id: nextStep.id }, data: { status: 'RUNNING' } });

              await produceMessage<JobSubmittedEvent>(Topics.JOB_SUBMITTED, {
                jobId: newJobId, type: nextStep.jobType, payload, priority: 'normal',
                delayMs: 0, maxAttempts: 3, backoff: 'exponential', attempt: 0,
                workflowId: event.workflowId, stepId: nextStep.id,
              }, newJobId);
            }
          } else {
            // Check if ALL steps are completed → workflow done
            const pendingOrRunning = allSteps.filter((s) =>
              s.status === 'PENDING' || s.status === 'RUNNING'
            );
            if (pendingOrRunning.length === 0) {
              await prisma.workflow.update({
                where: { id: event.workflowId! },
                data: { status: 'COMPLETED', completedAt: new Date() },
              });
              await writeAuditLog({ entityType: 'WORKFLOW', entityId: event.workflowId!, fromStatus: 'RUNNING', toStatus: 'COMPLETED' });
              await produceMessage<WorkflowCompletedEvent>(Topics.WORKFLOW_COMPLETED, {
                workflowId: event.workflowId!, status: 'completed',
                completedAt: new Date().toISOString(),
              }, event.workflowId);
            }
          }

          await produceMessage<WorkflowStepDoneEvent>(Topics.WORKFLOW_STEP_DONE, {
            workflowId: event.workflowId!, stepId: event.stepId!,
            stepName: thisStep?.name ?? '', status: 'completed',
          }, event.workflowId);
        }
      );
    },
  });
}
