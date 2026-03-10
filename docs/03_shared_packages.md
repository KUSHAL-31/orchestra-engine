# 03 — Shared Packages: Types, Kafka, Redis

> **Claude Code Instruction**: Build these three packages before any service (`apps/*`). All services import from these packages. Never define Kafka topics, Redis keys, or shared types inline in service code — always reference the constants and types from these packages.

---

## Package A: `packages/types`

### Structure
```
packages/types/
  package.json
  tsconfig.json
  src/
    index.ts          ← barrel export
    events.ts         ← Kafka message payload types
    api.ts            ← HTTP request/response types
    enums.ts          ← shared enum values as const objects
    logger.ts         ← logger factory
```

### `packages/types/package.json`
```json
{
  "name": "@forge-engine/types",
  "version": "1.0.0",
  "private": true,
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc"
  },
  "dependencies": {
    "pino": "^8.19.0",
    "pino-pretty": "^11.0.0"
  }
}
```

### `packages/types/src/events.ts`

```typescript
// ─── Kafka Event Payloads ────────────────────────────────────────────────────
// These are the exact shapes for every Kafka message in the system.

export interface JobSubmittedEvent {
  jobId: string;
  type: string;
  payload: Record<string, unknown>;
  priority: string;
  delayMs: number;
  maxAttempts: number;
  backoff: string;
  workflowId?: string;
  stepId?: string;
  attempt: number;
}

export interface JobRetryEvent {
  jobId: string;
  type: string;
  payload: Record<string, unknown>;
  attempt: number;
  retryAfterMs: number;
  workflowId?: string;
  stepId?: string;
}

export interface JobStartedEvent {
  jobId: string;
  workerId: string;
  startedAt: string; // ISO 8601
}

export interface JobCompletedEvent {
  jobId: string;
  workerId: string;
  result: unknown;
  completedAt: string; // ISO 8601
  workflowId?: string;
  stepId?: string;
}

export interface JobFailedEvent {
  jobId: string;
  workerId: string;
  error: string;
  attempt: number;
  maxAttempts: number;
  workflowId?: string;
  stepId?: string;
}

export interface JobDlqEvent {
  jobId: string;
  type: string;
  payload: Record<string, unknown>;
  errorHistory: Array<{
    attempt: number;
    error: string;
    failedAt: string;
  }>;
}

export interface WorkflowCreatedEvent {
  workflowId: string;
  definition: WorkflowDefinition;
}

export interface WorkflowStepDoneEvent {
  workflowId: string;
  stepId: string;
  stepName: string;
  status: string;
  parallelGroup?: string;
}

export interface WorkflowCompletedEvent {
  workflowId: string;
  status: string;
  completedAt: string; // ISO 8601
}

export interface ScheduleTickEvent {
  scheduleId: string;
  jobType: string;
  firedAt: string; // ISO 8601
}

// ─── Workflow Definition ─────────────────────────────────────────────────────

export interface WorkflowDefinition {
  name: string;
  steps: WorkflowStepDefinition[];
  onFailure?: {
    type: string;
    payload: Record<string, unknown>;
  };
}

export interface WorkflowStepDefinition {
  name: string;
  type: string;
  payload: Record<string, unknown>;
  dependsOn?: string[];        // array of step names (not IDs at definition time)
  parallelGroup?: string;
}
```

### `packages/types/src/api.ts`

```typescript
// ─── API Request Bodies ──────────────────────────────────────────────────────

export interface SubmitJobRequest {
  type: string;
  payload: Record<string, unknown>;
  retries?: number;             // defaults to 3
  backoff?: 'fixed' | 'linear' | 'exponential';
  delay?: number;               // ms, defaults to 0
  priority?: 'low' | 'normal' | 'high' | 'critical';
  idempotencyKey?: string;
}

export interface SubmitWorkflowRequest {
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

export interface CreateScheduleRequest {
  name: string;
  type: 'cron' | 'one-shot';
  cronExpr?: string;            // required for cron
  runAt?: string;               // ISO 8601, required for one-shot
  jobType: string;
  payload: Record<string, unknown>;
}

export interface UpdateScheduleRequest {
  cronExpr?: string;
  payload?: Record<string, unknown>;
  active?: boolean;
}

// ─── API Response Bodies ─────────────────────────────────────────────────────

export interface SubmitJobResponse {
  jobId: string;
}

export interface SubmitWorkflowResponse {
  workflowId: string;
}

export interface JobDetailResponse {
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

export interface WorkflowDetailResponse {
  id: string;
  name: string;
  status: string;
  definition: unknown;
  createdAt: string;
  completedAt: string | null;
  steps: Array<{
    id: string;
    name: string;
    jobType: string;
    status: string;
    dependsOn: string[];
    parallelGroup: string | null;
    position: number;
    result: unknown;
    error: string | null;
    executedAt: string | null;
  }>;
}
```

### `packages/types/src/logger.ts`

```typescript
import pino from 'pino';

export function createLogger(service: string) {
  return pino({
    name: service,
    level: process.env.LOG_LEVEL ?? 'info',
    transport:
      process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
  });
}

export type Logger = ReturnType<typeof createLogger>;
```

### `packages/types/src/index.ts`
```typescript
export * from './events';
export * from './api';
export * from './logger';
```

---

## Package B: `packages/kafka`

### Structure
```
packages/kafka/
  package.json
  tsconfig.json
  src/
    index.ts        ← barrel export
    client.ts       ← KafkaJS client factory
    topics.ts       ← topic name constants
    producer.ts     ← shared producer with typed produce helper
    init-topics.ts  ← admin topic initialization
```

### `packages/kafka/package.json`
```json
{
  "name": "@forge-engine/kafka",
  "version": "1.0.0",
  "private": true,
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": { "build": "tsc" },
  "dependencies": {
    "kafkajs": "^2.2.4",
    "@forge-engine/types": "*"
  }
}
```

### `packages/kafka/src/client.ts`

```typescript
import { Kafka, logLevel } from 'kafkajs';

export const kafka = new Kafka({
  clientId: process.env.KAFKA_CLIENT_ID ?? 'forge-engine',
  brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(','),
  logLevel:
    process.env.NODE_ENV === 'production' ? logLevel.WARN : logLevel.INFO,
  retry: {
    initialRetryTime: 300,
    retries: 10,
  },
});
```

### `packages/kafka/src/topics.ts`

```typescript
// ── NEVER use raw strings for topic names in service code.
// ── Always import from this module.

export const Topics = {
  JOB_SUBMITTED: 'job.submitted',
  JOB_RETRY: 'job.retry',
  JOB_STARTED: 'job.started',
  JOB_COMPLETED: 'job.completed',
  JOB_FAILED: 'job.failed',
  JOB_DLQ: 'job.dlq',
  WORKFLOW_CREATED: 'workflow.created',
  WORKFLOW_STEP_DONE: 'workflow.step.done',
  WORKFLOW_COMPLETED: 'workflow.completed',
  SCHEDULE_TICK: 'schedule.tick',
} as const;

export type TopicName = (typeof Topics)[keyof typeof Topics];
```

### `packages/kafka/src/producer.ts`

```typescript
import { Producer, CompressionTypes } from 'kafkajs';
import { kafka } from './client';
import { TopicName } from './topics';

let producerInstance: Producer | null = null;

export async function getProducer(): Promise<Producer> {
  if (!producerInstance) {
    producerInstance = kafka.producer({
      allowAutoTopicCreation: false,
      transactionTimeout: 30000,
    });
    await producerInstance.connect();
  }
  return producerInstance;
}

export async function produceMessage<T>(topic: TopicName, value: T, key?: string) {
  const producer = await getProducer();
  await producer.send({
    topic,
    compression: CompressionTypes.GZIP,
    messages: [
      {
        key: key ?? null,
        value: JSON.stringify(value),
        timestamp: Date.now().toString(),
      },
    ],
  });
}

export async function disconnectProducer() {
  if (producerInstance) {
    await producerInstance.disconnect();
    producerInstance = null;
  }
}
```

### `packages/kafka/src/init-topics.ts`

```typescript
import { kafka } from './client';
import { Topics } from './topics';

export async function initKafkaTopics(): Promise<void> {
  const admin = kafka.admin();
  await admin.connect();
  try {
    const existing = await admin.listTopics();
    const toCreate = Object.values(Topics)
      .filter((t) => !existing.includes(t))
      .map((topic) => ({
        topic,
        numPartitions: 3,
        replicationFactor: 1,
      }));

    if (toCreate.length > 0) {
      await admin.createTopics({ topics: toCreate, waitForLeaders: true });
    }
  } finally {
    await admin.disconnect();
  }
}
```

### `packages/kafka/src/index.ts`
```typescript
export * from './client';
export * from './topics';
export * from './producer';
export * from './init-topics';
```

---

## Package C: `packages/redis`

### Structure
```
packages/redis/
  package.json
  tsconfig.json
  src/
    index.ts        ← barrel export
    client.ts       ← ioredis client + subscriber client
    redlock.ts      ← Redlock instance + typed lock helper
    keys.ts         ← Redis key builder functions
    pubsub.ts       ← pub/sub channel names
```

### `packages/redis/package.json`
```json
{
  "name": "@forge-engine/redis",
  "version": "1.0.0",
  "private": true,
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": { "build": "tsc" },
  "dependencies": {
    "ioredis": "^5.3.2",
    "redlock": "^5.0.0-beta.2"
  }
}
```

### `packages/redis/src/client.ts`

```typescript
import Redis from 'ioredis';

function createRedisClient(name: string): Redis {
  return new Redis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    lazyConnect: true,
    retryStrategy: (times) => Math.min(times * 100, 3000),
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    connectionName: name,
  });
}

// Main client — for general operations
export const redis = createRedisClient('forge-main');

// Separate subscriber client — ioredis subscriber clients cannot run other commands
export const redisSubscriber = createRedisClient('forge-sub');

// Redlock requires its own client instances
export const redlockClients = [createRedisClient('forge-lock')];
```

### `packages/redis/src/redlock.ts`

```typescript
import Redlock from 'redlock';
import { redlockClients } from './client';

export const redlock = new Redlock(redlockClients, {
  driftFactor: 0.01,        // clock drift multiplier
  retryCount: 3,
  retryDelay: 200,          // ms between retry attempts
  retryJitter: 100,
  automaticExtensionThreshold: 500,
});

redlock.on('error', (err) => {
  // Suppress expected lock contention errors; log unexpected ones
  if (!err.message.includes('The operation was unable to achieve a quorum')) {
    console.error('[Redlock] unexpected error:', err);
  }
});

/**
 * Acquire a Redlock lock, run the callback, then release.
 * Throws if lock cannot be acquired (caller should skip/retry).
 */
export async function withLock<T>(
  resource: string,
  ttlMs: number,
  fn: () => Promise<T>
): Promise<T> {
  const lock = await redlock.acquire([resource], ttlMs);
  try {
    return await fn();
  } finally {
    await lock.release().catch(() => {
      // Lock may have expired; safe to ignore
    });
  }
}
```

### `packages/redis/src/keys.ts`

```typescript
// ── ALL Redis key patterns in the system.
// ── Always use these builder functions. Never use raw strings.

export const RedisKeys = {
  // Distributed locks
  lockJob: (jobId: string) => `lock:job:${jobId}`,
  lockWorkflow: (workflowId: string) => `lock:workflow:${workflowId}`,
  lockSchedulerTick: () => `lock:scheduler:tick`,

  // Job state cache
  jobState: (jobId: string) => `job:state:${jobId}`,
  jobProgress: (jobId: string) => `job:progress:${jobId}`,
  jobLogs: (jobId: string) => `job:logs:${jobId}`,

  // Parallel group fan-in counters
  groupTotal: (workflowId: string, group: string) =>
    `workflow:${workflowId}:group:${group}:total`,
  groupCompleted: (workflowId: string, group: string) =>
    `workflow:${workflowId}:group:${group}:completed`,

  // Rate limiting
  rateLimitKey: (apiKeyId: string) => `ratelimit:${apiKeyId}`,

  // Worker heartbeats
  heartbeat: (workerId: string) => `heartbeat:${workerId}`,
};

// TTL constants in seconds
export const RedisTTL = {
  LOCK_JOB: 30,
  LOCK_WORKFLOW: 10,
  LOCK_SCHEDULER: 70,
  JOB_STATE: 7 * 24 * 60 * 60, // 7 days
  HEARTBEAT: 30,
  RATE_LIMIT: 60,
};
```

### `packages/redis/src/pubsub.ts`

```typescript
// ── Redis Pub/Sub channel names
// ── API Service subscribes to these; workers/orchestrator publish to them

export const PubSubChannels = {
  JOB_EVENTS: 'job.events',
  WORKFLOW_EVENTS: 'workflow.events',
} as const;
```

### `packages/redis/src/index.ts`
```typescript
export * from './client';
export * from './redlock';
export * from './keys';
export * from './pubsub';
```

---

## Cross-Package Dependency Graph

```
@forge-engine/types   (no forge deps)
       ↑
@forge-engine/kafka   (imports types for event payloads)
@forge-engine/redis   (no forge deps)
@forge-engine/prisma  (no forge deps)
       ↑
All apps (api, orchestrator, worker, scheduler)
```
