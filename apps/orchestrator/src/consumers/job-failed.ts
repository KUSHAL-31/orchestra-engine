import { kafka, Topics, produceMessage } from '@forge-engine/kafka';
import { prisma } from '@forge-engine/prisma';
import { withLock, RedisKeys, RedisTTL } from '@forge-engine/redis';
import { computeBackoffMs } from '../lib/backoff';
import { writeAuditLog } from '@forge-engine/prisma';
import type { JobFailedEvent, JobRetryEvent, JobDlqEvent, WorkflowStepDoneEvent, JobSubmittedEvent } from '@forge-engine/types';
import { v4 as uuidv4 } from 'uuid';

export async function startJobFailedConsumer() {
  const consumer = kafka.consumer({
    groupId: process.env.KAFKA_GROUP_ID_ORCHESTRATOR ?? 'orchestrator',
  });
  await consumer.connect();
  await consumer.subscribe({ topics: [Topics.JOB_FAILED], fromBeginning: false });

  await consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      const event: JobFailedEvent = JSON.parse(message.value.toString());

      const job = await prisma.job.findUnique({ where: { id: event.jobId } });
      if (!job) return;

      const handlerFn = event.workflowId
        ? () => handleWorkflowJobFailed(event, job)
        : () => handleStandaloneJobFailed(event, job);

      if (event.workflowId) {
        await withLock(
          RedisKeys.lockWorkflow(event.workflowId),
          RedisTTL.LOCK_WORKFLOW * 1000,
          handlerFn
        );
      } else {
        await handlerFn();
      }
    },
  });
}

async function handleStandaloneJobFailed(event: JobFailedEvent, job: { id: string; type: string; payload: unknown; backoff: string }) {
  if (event.attempt < event.maxAttempts) {
    const retryAfterMs = computeBackoffMs(job.backoff, event.attempt);
    await prisma.job.update({ where: { id: job.id }, data: { status: 'RETRYING', attempts: event.attempt } });
    await produceMessage<JobRetryEvent>(Topics.JOB_RETRY, {
      jobId: job.id, type: job.type, payload: job.payload as Record<string, unknown>,
      attempt: event.attempt + 1, retryAfterMs, maxAttempts: event.maxAttempts,
    }, job.id);
  } else {
    await prisma.job.update({ where: { id: job.id }, data: { status: 'DEAD', error: event.error, attempts: event.attempt } });
    await writeAuditLog({ entityType: 'JOB', entityId: job.id, fromStatus: 'FAILED', toStatus: 'DEAD' });
    await produceMessage<JobDlqEvent>(Topics.JOB_DLQ, {
      jobId: job.id, type: job.type, payload: job.payload as Record<string, unknown>,
      errorHistory: [{ attempt: event.attempt, error: event.error, failedAt: new Date().toISOString() }],
    }, job.id);
  }
}

async function handleWorkflowJobFailed(event: JobFailedEvent, job: { id: string; type: string; payload: unknown; backoff: string }) {
  if (event.attempt < event.maxAttempts) {
    const retryAfterMs = computeBackoffMs(job.backoff, event.attempt);
    await prisma.job.update({ where: { id: job.id }, data: { status: 'RETRYING', attempts: event.attempt } });
    await produceMessage<JobRetryEvent>(Topics.JOB_RETRY, {
      jobId: job.id, type: job.type, payload: job.payload as Record<string, unknown>,
      attempt: event.attempt + 1, retryAfterMs, maxAttempts: event.maxAttempts,
      workflowId: event.workflowId, stepId: event.stepId,
    }, job.id);
  } else {
    // Exhausted retries: fail the step + fail the workflow
    await prisma.workflowStep.update({
      where: { id: event.stepId! },
      data: { status: 'FAILED', error: event.error },
    });
    await prisma.job.update({ where: { id: job.id }, data: { status: 'DEAD', error: event.error } });

    // Mark remaining steps as SKIPPED
    await prisma.workflowStep.updateMany({
      where: { workflowId: event.workflowId!, status: 'PENDING' },
      data: { status: 'SKIPPED' },
    });

    await prisma.workflow.update({
      where: { id: event.workflowId! },
      data: { status: 'FAILED' },
    });

    await writeAuditLog({ entityType: 'WORKFLOW', entityId: event.workflowId!, fromStatus: 'RUNNING', toStatus: 'FAILED' });

    // Check for onFailure handler
    const workflow = await prisma.workflow.findUnique({ where: { id: event.workflowId! } });
    const def = workflow?.definition as Record<string, unknown> | null;
    const onFailure = def?.onFailure as { type: string; payload: Record<string, unknown> } | undefined;
    if (onFailure) {
      const failureJobId = uuidv4();
      await prisma.job.create({
        data: { id: failureJobId, type: onFailure.type, payload: onFailure.payload as any, status: 'PENDING' },
      });
      await produceMessage<JobSubmittedEvent>(Topics.JOB_SUBMITTED, {
        jobId: failureJobId, type: onFailure.type, payload: onFailure.payload,
        priority: 'normal', delayMs: 0, maxAttempts: 3, backoff: 'exponential', attempt: 0,
      }, failureJobId);
    }

    await produceMessage<JobDlqEvent>(Topics.JOB_DLQ, {
      jobId: job.id, type: job.type, payload: job.payload as Record<string, unknown>,
      errorHistory: [{ attempt: event.attempt, error: event.error, failedAt: new Date().toISOString() }],
    }, job.id);

    await produceMessage<WorkflowStepDoneEvent>(Topics.WORKFLOW_STEP_DONE, {
      workflowId: event.workflowId!, stepId: event.stepId!,
      stepName: '', status: 'failed',
    }, event.workflowId);
  }
}
