# 08 — Node.js SDK (`packages/sdk`)

> **Claude Code Instruction**: The SDK is what end-users install in their own Node.js services. It wraps the REST API (job submission) and the worker execution engine (Kafka consumer). Implement two main classes: `JobEngine` (HTTP client) and `Worker` (Kafka consumer with handler registration). Both must be fully typed in TypeScript.

---

## Folder Structure

```
packages/sdk/
  package.json
  tsconfig.json
  src/
    index.ts          ← barrel export (public API surface)
    job-engine.ts     ← JobEngine class: submit jobs, submit workflows
    worker.ts         ← Worker class: register handlers, start consumer
    types.ts          ← SDK-specific types re-exported for users
  README.md           ← user-facing documentation
```

---

## `packages/sdk/package.json`

```json
{
  "name": "@forge-engine/sdk",
  "version": "1.0.0",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc"
  },
  "dependencies": {
    "@forge-engine/types": "*",
    "@forge-engine/kafka": "*",
    "@forge-engine/redis": "*",
    "node-fetch": "^3.3.2"
  },
  "peerDependencies": {
    "typescript": ">=5.0.0"
  }
}
```

---

## `src/types.ts`

```typescript
export interface JobEngineOptions {
  apiUrl: string;       // Base URL of the API service, e.g. 'http://localhost:3000'
  apiKey: string;       // Raw API key (will be sent as Bearer token)
}

export interface SubmitJobOptions {
  type: string;
  payload: Record<string, unknown>;
  retries?: number;
  backoff?: 'fixed' | 'linear' | 'exponential';
  delayMs?: number;
  priority?: 'low' | 'normal' | 'high' | 'critical';
  idempotencyKey?: string;
}

export interface SubmitWorkflowOptions {
  name: string;
  steps: Array<{
    name: string;
    type: string;
    payload: Record<string, unknown>;
    dependsOn?: string[];
    parallelGroup?: string;
  }>;
  onFailure?: {
    type: string;
    payload: Record<string, unknown>;
  };
}

export interface JobStatus {
  id: string;
  type: string;
  status: string;
  progress: number;
  attempts: number;
  maxAttempts: number;
  result: unknown;
  error: string | null;
  logs: string[];
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface WorkflowStatus {
  id: string;
  name: string;
  status: string;
  steps: Array<{
    id: string;
    name: string;
    jobType: string;
    status: string;
    dependsOn: string[];
    parallelGroup: string | null;
  }>;
  createdAt: string;
  completedAt: string | null;
}

export type JobHandlerFn = (ctx: WorkerJobContext) => Promise<unknown>;

export interface WorkerJobContext {
  jobId: string;
  data: Record<string, unknown>;
  type: string;
  attempt: number;
  progress(percent: number): Promise<void>;
  log(message: string): Promise<void>;
}
```

---

## `src/job-engine.ts`

```typescript
import type { JobEngineOptions, SubmitJobOptions, SubmitWorkflowOptions, JobStatus, WorkflowStatus } from './types';

export class JobEngine {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(options: JobEngineOptions) {
    this.baseUrl = options.apiUrl.replace(/\/$/, '');
    this.headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${options.apiKey}`,
    };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(`ForgeEngine API error [${res.status}]: ${(error as any).error}`);
    }

    return res.json() as Promise<T>;
  }

  /**
   * Submit a background job.
   * Returns the jobId.
   */
  async submitJob(options: SubmitJobOptions): Promise<{ jobId: string }> {
    return this.request<{ jobId: string }>('POST', '/jobs', {
      type: options.type,
      payload: options.payload,
      retries: options.retries,
      backoff: options.backoff,
      delay: options.delayMs,
      priority: options.priority,
      idempotencyKey: options.idempotencyKey,
    });
  }

  /**
   * Get full job status including progress, logs, and result.
   */
  async getJob(jobId: string): Promise<JobStatus> {
    return this.request<JobStatus>('GET', `/jobs/${jobId}`);
  }

  /**
   * Submit a workflow definition.
   * Returns the workflowId.
   */
  async submitWorkflow(options: SubmitWorkflowOptions): Promise<{ workflowId: string }> {
    return this.request<{ workflowId: string }>('POST', '/workflows', options);
  }

  /**
   * Get workflow status and all step statuses.
   */
  async getWorkflow(workflowId: string): Promise<WorkflowStatus> {
    return this.request<WorkflowStatus>('GET', `/workflows/${workflowId}`);
  }

  /**
   * Resume a failed workflow from the failed step.
   */
  async resumeWorkflow(workflowId: string): Promise<{ message: string }> {
    return this.request<{ message: string }>('POST', `/workflows/${workflowId}/resume`);
  }

  /**
   * Hook into SSE events. Calls onEvent for each event received.
   * Returns a cleanup function to close the connection.
   */
  onEvent(onEvent: (event: { type: string; data: unknown }) => void): () => void {
    const eventSource = new EventSource(`${this.baseUrl}/events?key=${encodeURIComponent(this.headers.Authorization.slice(7))}`);

    eventSource.onmessage = (e) => {
      try {
        const parsed = JSON.parse(e.data);
        onEvent({ type: e.type || 'message', data: parsed });
      } catch {
        // ignore parse errors
      }
    };

    return () => eventSource.close();
  }
}
```

---

## `src/worker.ts`

```typescript
import { kafka, Topics, produceMessage } from '@forge-engine/kafka';
import { redis, withLock, RedisKeys, RedisTTL } from '@forge-engine/redis';
import type { JobHandlerFn, WorkerJobContext } from './types';
import type { JobSubmittedEvent, JobRetryEvent, JobStartedEvent, JobCompletedEvent, JobFailedEvent } from '@forge-engine/types';
import os from 'os';

export interface WorkerOptions {
  kafkaBrokers: string[];    // e.g. ['localhost:9092']
  redisHost?: string;
  redisPort?: number;
  groupId?: string;
  concurrency?: number;      // reserved for future parallel execution
}

type AnyJobEvent = (JobSubmittedEvent | JobRetryEvent) & { attempt: number };

export class Worker {
  private handlers = new Map<string, JobHandlerFn>();
  private workerId = `sdk-worker-${os.hostname()}-${process.pid}`;

  /**
   * Register a handler function for a specific job type.
   * Call this before worker.start().
   */
  register(jobType: string, handler: JobHandlerFn): this {
    this.handlers.set(jobType, handler);
    return this;
  }

  /**
   * Start consuming jobs from Kafka. Blocks until stop() is called.
   */
  async start(options: WorkerOptions): Promise<void> {
    await redis.connect();

    const consumer = kafka.consumer({
      groupId: options.groupId ?? 'workers',
    });
    await consumer.connect();
    await consumer.subscribe({
      topics: [Topics.JOB_SUBMITTED, Topics.JOB_RETRY],
      fromBeginning: false,
    });

    const workerId = this.workerId;
    const handlers = this.handlers;

    await consumer.run({
      eachMessage: async ({ message }) => {
        if (!message.value) return;
        const event = JSON.parse(message.value.toString()) as AnyJobEvent;

        const handler = handlers.get(event.type);
        if (!handler) return;

        if ('retryAfterMs' in event && event.retryAfterMs > 0) {
          await new Promise((r) => setTimeout(r, event.retryAfterMs));
        }

        try {
          await withLock(RedisKeys.lockJob(event.jobId), RedisTTL.LOCK_JOB * 1000, async () => {
            await redis.set(RedisKeys.jobState(event.jobId), 'running', 'EX', RedisTTL.JOB_STATE);
            await produceMessage<JobStartedEvent>(Topics.JOB_STARTED, {
              jobId: event.jobId, workerId, startedAt: new Date().toISOString(),
            }, event.jobId);

            const ctx: WorkerJobContext = {
              jobId: event.jobId,
              data: event.payload,
              type: event.type,
              attempt: event.attempt,
              progress: async (n: number) => {
                await redis.set(RedisKeys.jobProgress(event.jobId), Math.min(100, Math.max(0, n)), 'EX', RedisTTL.JOB_STATE);
              },
              log: async (msg: string) => {
                await redis.rpush(RedisKeys.jobLogs(event.jobId), `[${new Date().toISOString()}] ${msg}`);
                await redis.expire(RedisKeys.jobLogs(event.jobId), RedisTTL.JOB_STATE);
              },
            };

            try {
              const result = await handler(ctx);
              await redis.set(RedisKeys.jobState(event.jobId), 'completed', 'EX', RedisTTL.JOB_STATE);
              await produceMessage<JobCompletedEvent>(Topics.JOB_COMPLETED, {
                jobId: event.jobId, workerId, result, completedAt: new Date().toISOString(),
                workflowId: event.workflowId, stepId: event.stepId,
              }, event.jobId);
            } catch (err: any) {
              await redis.set(RedisKeys.jobState(event.jobId), 'failed', 'EX', RedisTTL.JOB_STATE);
              await produceMessage<JobFailedEvent>(Topics.JOB_FAILED, {
                jobId: event.jobId, workerId, error: err?.message ?? String(err),
                attempt: event.attempt, maxAttempts: event.maxAttempts,
                workflowId: event.workflowId, stepId: event.stepId,
              }, event.jobId);
            }
          });
        } catch {
          // Lock not acquired — another worker handling this job
        }
      },
    });
  }
}
```

---

## `src/index.ts` — Public API Surface

```typescript
export { JobEngine } from './job-engine';
export { Worker } from './worker';
export type {
  JobEngineOptions,
  SubmitJobOptions,
  SubmitWorkflowOptions,
  JobStatus,
  WorkflowStatus,
  JobHandlerFn,
  WorkerJobContext,
  WorkerOptions,
} from './types';
```

---

## Example SDK Usage

```typescript
import { JobEngine, Worker } from '@forge-engine/sdk';

// ── Client: Submit jobs ──────────────────────────────────────────────────────
const engine = new JobEngine({
  apiUrl: 'http://localhost:3000',
  apiKey: 'forge-dev-api-key-12345',
});

// Submit a standalone job
const { jobId } = await engine.submitJob({
  type: 'send-email',
  payload: { to: 'user@example.com', subject: 'Welcome!', body: 'Hello!' },
  retries: 3,
  backoff: 'exponential',
});

// Check status
const job = await engine.getJob(jobId);
console.log(job.status, job.progress, job.logs);

// Submit a workflow
const { workflowId } = await engine.submitWorkflow({
  name: 'order-processing',
  steps: [
    { name: 'validate-order', type: 'validate-order', payload: { orderId: '123' } },
    {
      name: 'charge-payment',
      type: 'charge-payment',
      payload: { orderId: '123' },
      dependsOn: ['validate-order'],
    },
    {
      name: 'send-confirmation',
      type: 'send-email',
      payload: { to: 'user@example.com', subject: 'Order confirmed' },
      dependsOn: ['charge-payment'],
    },
  ],
  onFailure: {
    type: 'notify-ops',
    payload: { orderId: '123' },
  },
});

// ── Worker: Execute jobs ─────────────────────────────────────────────────────
const worker = new Worker();

worker
  .register('send-email', async (ctx) => {
    await ctx.log(`Sending email to ${ctx.data.to}`);
    await ctx.progress(50);
    // ... actual sending logic
    await ctx.progress(100);
    return { sent: true };
  })
  .register('validate-order', async (ctx) => {
    await ctx.log(`Validating order ${ctx.data.orderId}`);
    return { valid: true };
  });

await worker.start({
  kafkaBrokers: ['localhost:9092'],
  redisHost: 'localhost',
  redisPort: 6379,
});
```
