import { kafka, Topics, produceMessage } from '@forge-engine/kafka';
import { prisma } from '@forge-engine/prisma';
import type { WorkflowCreatedEvent, JobSubmittedEvent } from '@forge-engine/types';
import { resolveFirstSteps } from '../lib/step-resolver';
import { v4 as uuidv4 } from 'uuid';

export async function startWorkflowCreatedConsumer() {
  const consumer = kafka.consumer({
    groupId: `${process.env.KAFKA_GROUP_ID_ORCHESTRATOR ?? 'orchestrator'}-workflow-created`,
  });
  await consumer.connect();
  await consumer.subscribe({ topics: [Topics.WORKFLOW_CREATED], fromBeginning: false });

  await consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      const event: WorkflowCreatedEvent = JSON.parse(message.value.toString());
      const { workflowId, definition } = event;

      // Load all steps for this workflow
      const steps = await prisma.workflowStep.findMany({ where: { workflowId } });
      const firstSteps = resolveFirstSteps(steps);

      // Update workflow status to RUNNING
      await prisma.workflow.update({
        where: { id: workflowId },
        data: { status: 'RUNNING' },
      });

      // Submit first steps as jobs
      for (const step of firstSteps) {
        const jobId = uuidv4();
        const stepDef = definition.steps.find((s) => s.name === step.name);
        const payload = stepDef?.payload ?? {};

        // RULE-5: Write to Postgres before producing to Kafka
        await prisma.job.create({
          data: {
            id: jobId,
            type: step.jobType,
            payload: payload as any,
            status: 'PENDING',
            workflowId,
            stepId: step.id,
          },
        });

        await prisma.workflowStep.update({
          where: { id: step.id },
          data: { status: 'RUNNING' },
        });

        const jobEvent: JobSubmittedEvent = {
          jobId, type: step.jobType, payload,
          priority: 'normal', delayMs: 0, maxAttempts: 3,
          backoff: 'exponential', attempt: 0,
          workflowId, stepId: step.id,
        };
        await produceMessage(Topics.JOB_SUBMITTED, jobEvent, jobId);
      }
    },
  });
}
