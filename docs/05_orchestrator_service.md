# 05 — Orchestrator Service (`apps/orchestrator`)

> **Claude Code Instruction**: The Orchestrator is the workflow state machine. It is the ONLY service that writes workflow step state to Postgres. It must acquire a Redis Redlock before any workflow state transition. It is stateless — all state is in Postgres/Redis. Implement every `eachMessage` handler precisely as specified.

---

## Folder Structure

```
apps/orchestrator/
  package.json
  tsconfig.json
  src/
    index.ts                    ← entry point
    consumers/
      workflow-created.ts       ← handles workflow.created → submit first steps as jobs
      job-completed.ts          ← handles job.completed → advance workflow
      job-failed.ts             ← handles job.failed → retry or DLQ
      job-started.ts            ← handles job.started → write audit log
    lib/
      backoff.ts                ← backoff delay calculation
      step-resolver.ts          ← find ready next steps given a workflow state
```

---

## `apps/orchestrator/package.json`

```json
{
  "name": "@forge-engine/orchestrator",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "ts-node-dev --respawn --transpile-only src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@forge-engine/types": "*",
    "@forge-engine/kafka": "*",
    "@forge-engine/redis": "*",
    "@forge-engine/prisma": "*",
    "pino": "^8.19.0",
    "pino-pretty": "^11.0.0"
  }
}
```

---

## `src/index.ts`

```typescript
import 'dotenv/config';
import { initKafkaTopics } from '@forge-engine/kafka';
import { redis } from '@forge-engine/redis';
import { startWorkflowCreatedConsumer } from './consumers/workflow-created';
import { startJobCompletedConsumer } from './consumers/job-completed';
import { startJobFailedConsumer } from './consumers/job-failed';
import { startJobStartedConsumer } from './consumers/job-started';
import { createLogger } from '@forge-engine/types';

const logger = createLogger('orchestrator');

async function main() {
  await initKafkaTopics();
  await redis.connect();

  await Promise.all([
    startWorkflowCreatedConsumer(),
    startJobCompletedConsumer(),
    startJobFailedConsumer(),
    startJobStartedConsumer(),
  ]);

  logger.info('Orchestrator Service started');
}

main().catch((err) => {
  logger.error(err, 'Failed to start Orchestrator');
  process.exit(1);
});
```

---

## `src/lib/backoff.ts`

```typescript
const MAX_BACKOFF_MS = 5 * 60 * 1000; // 5 minutes

export function computeBackoffMs(
  strategy: string,
  attempt: number,
  baseDelayMs = 1000
): number {
  switch (strategy.toLowerCase()) {
    case 'fixed':
      return baseDelayMs;
    case 'linear':
      return attempt * baseDelayMs;
    case 'exponential':
      return Math.min(Math.pow(2, attempt) * baseDelayMs, MAX_BACKOFF_MS);
    default:
      return baseDelayMs;
  }
}
```

---

## `src/lib/step-resolver.ts`

```typescript
import { WorkflowStep } from '@forge-engine/prisma';

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
```

---

## `src/consumers/workflow-created.ts`

```typescript
import { kafka, Topics, produceMessage } from '@forge-engine/kafka';
import { prisma } from '@forge-engine/prisma';
import type { WorkflowCreatedEvent, JobSubmittedEvent } from '@forge-engine/types';
import { resolveFirstSteps } from '../lib/step-resolver';
import { v4 as uuidv4 } from 'uuid';

export async function startWorkflowCreatedConsumer() {
  const consumer = kafka.consumer({
    groupId: process.env.KAFKA_GROUP_ID_ORCHESTRATOR ?? 'orchestrator',
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
            payload,
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

      // Initialize parallel group counters if needed
      const groups = new Map<string, WorkflowStep[]>();
      for (const step of firstSteps) {
        if (step.parallelGroup) {
          const g = groups.get(step.parallelGroup) ?? [];
          g.push(step);
          groups.set(step.parallelGroup, g);
        }
      }
      // (counter initialization is handled in job-completed.ts when first job in group starts)
    },
  });
}
```

---

## `src/consumers/job-completed.ts`

```typescript
import { kafka, Topics, produceMessage } from '@forge-engine/kafka';
import { prisma } from '@forge-engine/prisma';
import { redis, redlock, withLock, RedisKeys, RedisTTL } from '@forge-engine/redis';
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
          data: { status: 'COMPLETED', result: event.result as any, completedAt: new Date() },
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
            data: { status: 'COMPLETED', result: event.result as any, executedAt: new Date() },
          });

          await prisma.job.update({
            where: { id: event.jobId },
            data: { status: 'COMPLETED', result: event.result as any, completedAt: new Date() },
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
              const def = workflow?.definition as any;
              const stepDef = def?.steps?.find((s: any) => s.name === nextStep.name);
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
```

---

## `src/consumers/job-failed.ts`

```typescript
import { kafka, Topics, produceMessage } from '@forge-engine/kafka';
import { prisma } from '@forge-engine/prisma';
import { withLock, RedisKeys, RedisTTL } from '@forge-engine/redis';
import { computeBackoffMs } from '../lib/backoff';
import { writeAuditLog } from '@forge-engine/prisma/src/audit';
import type { JobFailedEvent, JobRetryEvent, JobDlqEvent, WorkflowStepDoneEvent, JobSubmittedEvent } from '@forge-engine/types';

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

async function handleStandaloneJobFailed(event: JobFailedEvent, job: any) {
  if (event.attempt < event.maxAttempts) {
    const retryAfterMs = computeBackoffMs(job.backoff, event.attempt);
    await prisma.job.update({ where: { id: job.id }, data: { status: 'RETRYING', attempts: event.attempt } });
    await produceMessage<JobRetryEvent>(Topics.JOB_RETRY, {
      jobId: job.id, type: job.type, payload: job.payload as any,
      attempt: event.attempt + 1, retryAfterMs,
    }, job.id);
  } else {
    await prisma.job.update({ where: { id: job.id }, data: { status: 'DEAD', error: event.error, attempts: event.attempt } });
    await writeAuditLog({ entityType: 'JOB', entityId: job.id, fromStatus: 'FAILED', toStatus: 'DEAD' });
    await produceMessage<JobDlqEvent>(Topics.JOB_DLQ, {
      jobId: job.id, type: job.type, payload: job.payload as any,
      errorHistory: [{ attempt: event.attempt, error: event.error, failedAt: new Date().toISOString() }],
    }, job.id);
  }
}

async function handleWorkflowJobFailed(event: JobFailedEvent, job: any) {
  if (event.attempt < event.maxAttempts) {
    const retryAfterMs = computeBackoffMs(job.backoff, event.attempt);
    await prisma.job.update({ where: { id: job.id }, data: { status: 'RETRYING', attempts: event.attempt } });
    await produceMessage<JobRetryEvent>(Topics.JOB_RETRY, {
      jobId: job.id, type: job.type, payload: job.payload as any,
      attempt: event.attempt + 1, retryAfterMs,
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
    const def = workflow?.definition as any;
    if (def?.onFailure) {
      const failureJobId = require('uuid').v4();
      await prisma.job.create({
        data: { id: failureJobId, type: def.onFailure.type, payload: def.onFailure.payload, status: 'PENDING' },
      });
      await produceMessage<JobSubmittedEvent>(Topics.JOB_SUBMITTED, {
        jobId: failureJobId, type: def.onFailure.type, payload: def.onFailure.payload,
        priority: 'normal', delayMs: 0, maxAttempts: 3, backoff: 'exponential', attempt: 0,
      }, failureJobId);
    }

    await produceMessage<JobDlqEvent>(Topics.JOB_DLQ, {
      jobId: job.id, type: job.type, payload: job.payload as any,
      errorHistory: [{ attempt: event.attempt, error: event.error, failedAt: new Date().toISOString() }],
    }, job.id);

    await produceMessage<WorkflowStepDoneEvent>(Topics.WORKFLOW_STEP_DONE, {
      workflowId: event.workflowId!, stepId: event.stepId!,
      stepName: '', status: 'failed',
    }, event.workflowId);
  }
}
```

---

## `src/consumers/job-started.ts`

```typescript
import { kafka, Topics } from '@forge-engine/kafka';
import { prisma } from '@forge-engine/prisma';
import { writeAuditLog } from '@forge-engine/prisma/src/audit';
import type { JobStartedEvent } from '@forge-engine/types';

export async function startJobStartedConsumer() {
  const consumer = kafka.consumer({
    groupId: `${process.env.KAFKA_GROUP_ID_ORCHESTRATOR ?? 'orchestrator'}-audit`,
  });
  await consumer.connect();
  await consumer.subscribe({ topics: [Topics.JOB_STARTED], fromBeginning: false });

  await consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      const event: JobStartedEvent = JSON.parse(message.value.toString());

      await prisma.job.update({
        where: { id: event.jobId },
        data: { status: 'RUNNING', startedAt: new Date(event.startedAt), attempts: { increment: 1 } },
      });

      await writeAuditLog({ entityType: 'JOB', entityId: event.jobId, fromStatus: 'PENDING', toStatus: 'RUNNING' });
    },
  });
}
```

---

## Critical Implementation Notes

1. **Consumer group IDs**: The Orchestrator uses its own consumer group (`orchestrator`). The Worker uses a separate group (`workers`). This ensures both consume from `job.submitted` independently.

2. **Fan-in logic**: The `workflow:{id}:group:{group}:total` Redis counter is initialized the *first time* a job.completed arrives for that group. Use `EXISTS` before `SET` to avoid overwriting.

3. **Backoff capping**: Exponential backoff is capped at 5 minutes (300,000ms).

4. **Lock acquisition failure**: If `withLock` throws (lock contention), the Kafka message should NOT be marked as processed. KafkaJS will retry it on the next poll. This is the correct behavior.

5. **Step name resolution**: `resolveReadySteps` uses step IDs in `dependsOn` arrays (as stored in Postgres), NOT step names. The Orchestrator maps names to IDs at workflow creation time.
