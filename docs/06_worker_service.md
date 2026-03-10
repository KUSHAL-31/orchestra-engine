# 06 — Worker Service (`apps/worker`)

> **Claude Code Instruction**: The Worker is a Kafka consumer group that executes jobs. It uses Redlock before starting any job execution. It NEVER writes to Postgres directly — it emits Kafka events. Progress and logs go to Redis. Implement heartbeat registration and the job context object exactly as specified.

---

## Folder Structure

```
apps/worker/
  package.json
  tsconfig.json
  src/
    index.ts              ← entry point: register handlers, start consumer + heartbeat
    consumer.ts           ← Kafka consumer loop (job.submitted + job.retry)
    context.ts            ← JobContext class (job.progress, job.log, job.data)
    heartbeat.ts          ← Redis heartbeat + Postgres worker registration
    handlers/
      index.ts            ← registers all built-in handler types (demo purposes)
      send-email.ts       ← example handler
      generate-report.ts  ← example handler
```

---

## `apps/worker/package.json`

```json
{
  "name": "@forge-engine/worker",
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
    "pino-pretty": "^11.0.0",
    "uuid": "^9.0.0"
  }
}
```

---

## `src/context.ts` — JobContext Object

```typescript
import { redis, RedisKeys, RedisTTL } from '@forge-engine/redis';

export interface JobContextData {
  jobId: string;
  data: Record<string, unknown>;
  type: string;
  attempt: number;
}

export class JobContext {
  readonly jobId: string;
  readonly data: Record<string, unknown>;
  readonly type: string;
  readonly attempt: number;

  constructor(params: JobContextData) {
    this.jobId = params.jobId;
    this.data = params.data;
    this.type = params.type;
    this.attempt = params.attempt;
  }

  /**
   * Update job progress (0-100). Stored in Redis immediately.
   */
  async progress(percent: number): Promise<void> {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    await redis.set(
      RedisKeys.jobProgress(this.jobId),
      clamped,
      'EX',
      RedisTTL.JOB_STATE
    );
  }

  /**
   * Append a log message to the job's Redis log list.
   */
  async log(message: string): Promise<void> {
    const entry = `[${new Date().toISOString()}] ${message}`;
    await redis.rpush(RedisKeys.jobLogs(this.jobId), entry);
    await redis.expire(RedisKeys.jobLogs(this.jobId), RedisTTL.JOB_STATE);
  }
}

export type JobHandler = (ctx: JobContext) => Promise<unknown>;
```

---

## `src/heartbeat.ts`

```typescript
import os from 'os';
import { prisma } from '@forge-engine/prisma';
import { redis, RedisKeys, RedisTTL } from '@forge-engine/redis';
import { createLogger } from '@forge-engine/types';

const logger = createLogger('worker:heartbeat');

export function getWorkerId(): string {
  return `${os.hostname()}-${process.pid}`;
}

export async function registerWorker(jobTypes: string[]): Promise<void> {
  const workerId = getWorkerId();
  await prisma.worker.upsert({
    where: { id: workerId },
    update: { status: 'ACTIVE', lastHeartbeat: new Date(), jobTypes },
    create: { id: workerId, jobTypes, status: 'ACTIVE', lastHeartbeat: new Date() },
  });
  logger.info({ workerId, jobTypes }, 'Worker registered');
}

export function startHeartbeat(jobTypes: string[]): NodeJS.Timeout {
  const workerId = getWorkerId();

  // Run immediately, then every 10s
  const beat = async () => {
    try {
      await redis.set(RedisKeys.heartbeat(workerId), 'alive', 'EX', RedisTTL.HEARTBEAT);
      await prisma.worker.update({
        where: { id: workerId },
        data: { lastHeartbeat: new Date() },
      });
    } catch (err) {
      logger.error(err, 'Heartbeat failed');
    }
  };

  beat(); // immediate
  return setInterval(beat, 10_000);
}

export async function deregisterWorker(): Promise<void> {
  const workerId = getWorkerId();
  await prisma.worker.update({
    where: { id: workerId },
    data: { status: 'DEAD' },
  });
  logger.info({ workerId }, 'Worker deregistered');
}
```

---

## `src/consumer.ts` — Main Kafka Consumer Loop

```typescript
import { kafka, Topics, produceMessage } from '@forge-engine/kafka';
import { redis, redlock, withLock, RedisKeys, RedisTTL } from '@forge-engine/redis';
import { JobContext, JobHandler } from './context';
import { getWorkerId } from './heartbeat';
import { createLogger } from '@forge-engine/types';
import type { JobSubmittedEvent, JobRetryEvent, JobStartedEvent, JobCompletedEvent, JobFailedEvent } from '@forge-engine/types';

const logger = createLogger('worker:consumer');

type AnyJobEvent = (JobSubmittedEvent | JobRetryEvent) & { attempt: number };

export async function startWorkerConsumer(handlers: Map<string, JobHandler>) {
  const consumer = kafka.consumer({ groupId: process.env.KAFKA_GROUP_ID_WORKER ?? 'workers' });
  await consumer.connect();

  await consumer.subscribe({
    topics: [Topics.JOB_SUBMITTED, Topics.JOB_RETRY],
    fromBeginning: false,
  });

  const workerId = getWorkerId();

  await consumer.run({
    eachMessage: async ({ topic, message }) => {
      if (!message.value) return;

      const event = JSON.parse(message.value.toString()) as AnyJobEvent;

      // Step 1: Check if this worker has a handler for this job type
      const handler = handlers.get(event.type);
      if (!handler) {
        logger.debug({ type: event.type }, 'No handler registered — skipping');
        return;
      }

      // Step 2: Handle delayed jobs (job.retry with retryAfterMs)
      if ('retryAfterMs' in event && event.retryAfterMs > 0) {
        await new Promise((res) => setTimeout(res, event.retryAfterMs));
      }

      // Step 3: Acquire Redlock — RULE-6: second layer of safety
      const lockKey = RedisKeys.lockJob(event.jobId);
      let lockAcquired = false;

      try {
        await withLock(lockKey, RedisTTL.LOCK_JOB * 1000, async () => {
          lockAcquired = true;

          // Step 4: Emit job.started
          await redis.set(RedisKeys.jobState(event.jobId), 'running', 'EX', RedisTTL.JOB_STATE);
          await produceMessage<JobStartedEvent>(Topics.JOB_STARTED, {
            jobId: event.jobId,
            workerId,
            startedAt: new Date().toISOString(),
          }, event.jobId);

          // Step 5: Execute handler with JobContext
          const ctx = new JobContext({
            jobId: event.jobId,
            data: event.payload,
            type: event.type,
            attempt: event.attempt,
          });

          try {
            const result = await handler(ctx);

            // Step 6: On success
            await redis.set(RedisKeys.jobState(event.jobId), 'completed', 'EX', RedisTTL.JOB_STATE);
            await produceMessage<JobCompletedEvent>(Topics.JOB_COMPLETED, {
              jobId: event.jobId,
              workerId,
              result,
              completedAt: new Date().toISOString(),
              workflowId: event.workflowId,
              stepId: event.stepId,
            }, event.jobId);

            logger.info({ jobId: event.jobId, type: event.type }, 'Job completed');
          } catch (err: any) {
            // Step 7: On handler throw
            await redis.set(RedisKeys.jobState(event.jobId), 'failed', 'EX', RedisTTL.JOB_STATE);
            await produceMessage<JobFailedEvent>(Topics.JOB_FAILED, {
              jobId: event.jobId,
              workerId,
              error: err?.message ?? String(err),
              attempt: event.attempt,
              maxAttempts: event.maxAttempts,
              workflowId: event.workflowId,
              stepId: event.stepId,
            }, event.jobId);

            logger.warn({ jobId: event.jobId, error: err?.message }, 'Job failed');
          }
        });
      } catch (lockErr) {
        // Lock acquisition failed — another worker is executing this job
        logger.debug({ jobId: event.jobId }, 'Could not acquire lock — skipping');
      }
    },
  });

  return consumer;
}
```

---

## `src/index.ts` — Entry Point

```typescript
import 'dotenv/config';
import { initKafkaTopics } from '@forge-engine/kafka';
import { redis } from '@forge-engine/redis';
import { startWorkerConsumer } from './consumer';
import { registerWorker, startHeartbeat, deregisterWorker } from './heartbeat';
import { createLogger, type JobHandler } from '@forge-engine/types';

// ─── Register your job handlers here ─────────────────────────────────────────
// Add new handlers by importing and registering them in this map.
import { sendEmailHandler } from './handlers/send-email';
import { generateReportHandler } from './handlers/generate-report';

const logger = createLogger('worker');

const handlers = new Map<string, JobHandler>([
  ['send-email', sendEmailHandler],
  ['generate-report', generateReportHandler],
]);

async function main() {
  await initKafkaTopics();
  await redis.connect();

  const jobTypes = Array.from(handlers.keys());
  await registerWorker(jobTypes);
  startHeartbeat(jobTypes);

  const consumer = await startWorkerConsumer(handlers);

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down worker...');
    await consumer.disconnect();
    await deregisterWorker();
    await redis.quit();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  logger.info({ jobTypes }, 'Worker Service started');
}

main().catch((err) => {
  logger.error(err, 'Failed to start Worker');
  process.exit(1);
});
```

---

## `src/handlers/send-email.ts` — Example Handler

```typescript
import { JobContext } from '../context';

export async function sendEmailHandler(ctx: JobContext): Promise<{ sent: boolean }> {
  const { to, subject, body } = ctx.data as { to: string; subject: string; body: string };

  await ctx.log(`Sending email to ${to}`);
  await ctx.progress(10);

  // Simulate sending (replace with real email logic)
  await new Promise((res) => setTimeout(res, 500));
  await ctx.progress(50);

  await ctx.log(`Email sent: "${subject}" to ${to}`);
  await ctx.progress(100);

  return { sent: true };
}
```

---

## `src/handlers/generate-report.ts` — Example Handler

```typescript
import { JobContext } from '../context';

export async function generateReportHandler(ctx: JobContext): Promise<{ reportUrl: string }> {
  const { period, userId } = ctx.data as { period: string; userId: string };

  await ctx.log(`Generating report for user ${userId}, period: ${period}`);
  await ctx.progress(0);

  // Simulate report generation
  for (let i = 10; i <= 100; i += 10) {
    await new Promise((res) => setTimeout(res, 200));
    await ctx.progress(i);
    await ctx.log(`Processing step ${i / 10} of 10`);
  }

  const reportUrl = `https://reports.example.com/${userId}/${period}.pdf`;
  return { reportUrl };
}
```

---

## Adding a Custom Handler (SDK Users)

When using the SDK (see `packages/sdk`), end users don't edit this file. They use:

```typescript
const engine = new JobEngine({ apiKey: '...' });
const worker = engine.createWorker();

worker.register('my-job-type', async (ctx) => {
  await ctx.log('Starting...');
  await ctx.progress(50);
  return { done: true };
});

await worker.start();
```

The SDK `Worker` class internally reuses the same `startWorkerConsumer` logic.

---

## Implementation Notes

1. **Consumer group `workers`**: Both `job.submitted` and `job.retry` are consumed by the same group. Kafka distributes messages across replicas automatically.
2. **Lock TTL 30s**: If the handler takes longer than 30s, the lock expires. For long-running jobs, use `ctx.progress()` calls — but the lock will not auto-extend in this implementation (add Redlock `extend()` calls for very long jobs if needed).
3. **No direct Postgres writes**: The Worker never writes to Postgres. All state transitions happen via Kafka events that the Orchestrator and API Service consume.
4. **Retry delay**: For `job.retry` events, the worker sleeps for `retryAfterMs` before attempting to acquire the lock. This implements the backoff on the consumer side.
5. **Graceful shutdown**: On SIGTERM/SIGINT, the consumer disconnects (causes Kafka rebalance), the worker status in Postgres is set to `DEAD`, and Redis is disconnected cleanly.
