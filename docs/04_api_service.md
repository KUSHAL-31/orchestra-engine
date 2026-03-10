# 04 — API Service (`apps/api`)

> **Claude Code Instruction**: This is the only public-facing HTTP entry point. It uses Fastify. All 15 routes are specified here with their exact logic. Implement every route. Do not skip any. The API never directly triggers workers — it writes to Postgres then emits to Kafka.

---

## Folder Structure

```
apps/api/
  package.json
  tsconfig.json
  src/
    index.ts              ← entry point (starts server)
    server.ts             ← Fastify instance + plugin registration
    routes/
      jobs.ts             ← POST /jobs, GET /jobs/:id
      workflows.ts        ← POST /workflows, GET /workflows/:id, POST /workflows/:id/resume
      dlq.ts              ← GET /dlq, POST /dlq/:id/replay, DELETE /dlq/:id
      schedules.ts        ← GET/POST /schedules, PATCH/DELETE /schedules/:id
      workers.ts          ← GET /workers
      events.ts           ← GET /events (SSE)
      health.ts           ← GET /health
    middleware/
      auth.ts             ← API key validation hook
      ratelimit.ts        ← per-key rate limiter
    consumers/
      job-events.ts       ← Kafka consumer → Redis pub/sub (job.started/completed/failed)
      workflow-events.ts  ← Kafka consumer → Redis pub/sub (workflow events)
      dlq-consumer.ts     ← Kafka consumer for job.dlq → writes to dead_letter_queue
      schedule-audit.ts   ← Kafka consumer for schedule.tick → writes audit log
    lib/
      api-key.ts          ← SHA-256 key validation helper
```

---

## `apps/api/package.json`

```json
{
  "name": "@forge-engine/api",
  "version": "1.0.0",
  "private": true,
  "main": "dist/index.js",
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
    "fastify": "^4.27.0",
    "@fastify/cors": "^9.0.1",
    "pino": "^8.19.0",
    "pino-pretty": "^11.0.0",
    "uuid": "^9.0.0",
    "node-cron": "^3.0.3",
    "cron-parser": "^4.9.0"
  },
  "devDependencies": {
    "@types/uuid": "^9.0.0"
  }
}
```

---

## `src/index.ts`

```typescript
import 'dotenv/config';
import { buildServer } from './server';
import { startApiConsumers } from './consumers';
import { initKafkaTopics } from '@forge-engine/kafka';
import { redis, redisSubscriber } from '@forge-engine/redis';
import { createLogger } from '@forge-engine/types';

const logger = createLogger('api');

async function main() {
  await initKafkaTopics();
  await redis.connect();
  await redisSubscriber.connect();

  await startApiConsumers(); // start Kafka → pub/sub bridge

  const server = await buildServer();
  const port = parseInt(process.env.API_PORT ?? '3000', 10);

  await server.listen({ port, host: '0.0.0.0' });
  logger.info({ port }, 'API Service started');
}

main().catch((err) => {
  logger.error(err, 'Failed to start API service');
  process.exit(1);
});
```

---

## `src/server.ts`

```typescript
import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { healthRoutes } from './routes/health';
import { jobRoutes } from './routes/jobs';
import { workflowRoutes } from './routes/workflows';
import { dlqRoutes } from './routes/dlq';
import { scheduleRoutes } from './routes/schedules';
import { workerRoutes } from './routes/workers';
import { eventsRoutes } from './routes/events';
import { authHook } from './middleware/auth';

export async function buildServer(): Promise<FastifyInstance> {
  const server = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

  await server.register(cors, { origin: true });

  // Auth hook applies to all routes EXCEPT /health
  server.addHook('preHandler', authHook);

  // Register all route modules
  await server.register(healthRoutes);          // GET /health  (no auth)
  await server.register(jobRoutes);             // /jobs
  await server.register(workflowRoutes);        // /workflows
  await server.register(dlqRoutes);             // /dlq
  await server.register(scheduleRoutes);        // /schedules
  await server.register(workerRoutes);          // /workers
  await server.register(eventsRoutes);           // /events

  return server;
}
```

---

## `src/middleware/auth.ts`

```typescript
import { FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'crypto';
import { prisma } from '@forge-engine/prisma';
import { redis, RedisKeys, RedisTTL } from '@forge-engine/redis';

const EXEMPT_PATHS = ['/health'];

export async function authHook(request: FastifyRequest, reply: FastifyReply) {
  if (EXEMPT_PATHS.includes(request.url)) return;

  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return reply.code(401).send({ error: 'Missing or invalid Authorization header' });
  }

  const rawKey = authHeader.slice(7);
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

  const apiKey = await prisma.apiKey.findUnique({ where: { keyHash } });
  if (!apiKey) {
    return reply.code(401).send({ error: 'Invalid API key' });
  }

  // Rate limiting: 1000 requests per minute per API key
  const rateLimitKey = RedisKeys.rateLimitKey(apiKey.id);
  const count = await redis.incr(rateLimitKey);
  if (count === 1) {
    await redis.expire(rateLimitKey, RedisTTL.RATE_LIMIT);
  }
  if (count > 1000) {
    return reply.code(429).send({ error: 'Rate limit exceeded' });
  }

  // Update last_used_at (fire-and-forget for performance)
  prisma.apiKey.update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } }).catch(() => {});

  // Attach apiKeyId to request for downstream use
  (request as FastifyRequest & { apiKeyId: string }).apiKeyId = apiKey.id;
}
```

---

## `src/routes/jobs.ts`

```typescript
import { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '@forge-engine/prisma';
import { produceMessage, Topics } from '@forge-engine/kafka';
import { redis, RedisKeys } from '@forge-engine/redis';
import type { SubmitJobRequest, JobSubmittedEvent } from '@forge-engine/types';

export async function jobRoutes(server: FastifyInstance) {

  // POST /jobs — Submit a new job
  server.post<{ Body: SubmitJobRequest }>('/jobs', async (request, reply) => {
    const { type, payload, retries = 3, backoff = 'exponential',
            delay = 0, priority = 'normal', idempotencyKey } = request.body;

    if (!type || !payload) {
      return reply.code(400).send({ error: 'type and payload are required' });
    }

    // Idempotency check
    if (idempotencyKey) {
      const existing = await prisma.job.findUnique({ where: { idempotencyKey } });
      if (existing) return reply.code(200).send({ jobId: existing.id });
    }

    const jobId = uuidv4();

    // RULE-5: Write to Postgres BEFORE producing to Kafka
    await prisma.job.create({
      data: {
        id: jobId,
        type,
        payload,
        status: 'PENDING',
        priority: priority.toUpperCase() as any,
        maxAttempts: retries,
        backoff: backoff.toUpperCase() as any,
        delayMs: delay,
        idempotencyKey,
      },
    });

    const event: JobSubmittedEvent = {
      jobId, type, payload, priority, delayMs: delay,
      maxAttempts: retries, backoff, attempt: 0,
    };
    await produceMessage(Topics.JOB_SUBMITTED, event, jobId);

    return reply.code(202).send({ jobId });
  });

  // GET /jobs/:id — Get job status (Redis cache first, Postgres fallback)
  server.get<{ Params: { id: string } }>('/jobs/:id', async (request, reply) => {
    const { id } = request.params;

    // Try Redis cache first
    const [cachedStatus, cachedProgress] = await Promise.all([
      redis.get(RedisKeys.jobState(id)),
      redis.get(RedisKeys.jobProgress(id)),
    ]);
    const logs = await redis.lrange(RedisKeys.jobLogs(id), 0, -1);

    // Always hit Postgres for full record
    const job = await prisma.job.findUnique({ where: { id } });
    if (!job) return reply.code(404).send({ error: 'Job not found' });

    return reply.send({
      id: job.id,
      type: job.type,
      status: cachedStatus ?? job.status.toLowerCase(),
      progress: cachedProgress ? parseInt(cachedProgress, 10) : 0,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      result: job.result,
      error: job.error,
      logs,
      createdAt: job.createdAt.toISOString(),
      startedAt: job.startedAt?.toISOString() ?? null,
      completedAt: job.completedAt?.toISOString() ?? null,
    });
  });
}
```

---

## `src/routes/workflows.ts`

```typescript
import { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '@forge-engine/prisma';
import { produceMessage, Topics } from '@forge-engine/kafka';
import type { SubmitWorkflowRequest, WorkflowCreatedEvent } from '@forge-engine/types';

export async function workflowRoutes(server: FastifyInstance) {

  // POST /workflows — Submit a workflow
  server.post<{ Body: SubmitWorkflowRequest }>('/workflows', async (request, reply) => {
    const { name, steps, onFailure } = request.body;

    if (!name || !steps?.length) {
      return reply.code(400).send({ error: 'name and steps are required' });
    }

    const workflowId = uuidv4();
    const stepRecords = steps.map((step, index) => ({
      id: uuidv4(),
      workflowId,
      name: step.name,
      jobType: step.type,
      status: 'PENDING' as const,
      dependsOn: step.dependsOn ?? [],
      parallelGroup: step.parallelGroup ?? null,
      position: index,
    }));

    // RULE-5: Write Postgres first
    await prisma.workflow.create({
      data: {
        id: workflowId,
        name,
        status: 'PENDING',
        definition: { name, steps, onFailure } as any,
        steps: { create: stepRecords },
      },
    });

    const event: WorkflowCreatedEvent = {
      workflowId,
      definition: { name, steps, onFailure },
    };
    await produceMessage(Topics.WORKFLOW_CREATED, event, workflowId);

    return reply.code(202).send({ workflowId });
  });

  // GET /workflows/:id — Get workflow + all step statuses
  server.get<{ Params: { id: string } }>('/workflows/:id', async (request, reply) => {
    const workflow = await prisma.workflow.findUnique({
      where: { id: request.params.id },
      include: { steps: { orderBy: { position: 'asc' } } },
    });
    if (!workflow) return reply.code(404).send({ error: 'Workflow not found' });

    return reply.send({
      id: workflow.id,
      name: workflow.name,
      status: workflow.status.toLowerCase(),
      definition: workflow.definition,
      createdAt: workflow.createdAt.toISOString(),
      completedAt: workflow.completedAt?.toISOString() ?? null,
      steps: workflow.steps.map((s) => ({
        id: s.id,
        name: s.name,
        jobType: s.jobType,
        status: s.status.toLowerCase(),
        dependsOn: s.dependsOn,
        parallelGroup: s.parallelGroup,
        position: s.position,
        result: s.result,
        error: s.error,
        executedAt: s.executedAt?.toISOString() ?? null,
      })),
    });
  });

  // POST /workflows/:id/resume — Resume failed workflow
  server.post<{ Params: { id: string } }>('/workflows/:id/resume', async (request, reply) => {
    const workflow = await prisma.workflow.findUnique({
      where: { id: request.params.id },
      include: { steps: true },
    });
    if (!workflow) return reply.code(404).send({ error: 'Workflow not found' });
    if (workflow.status !== 'FAILED') {
      return reply.code(400).send({ error: 'Only failed workflows can be resumed' });
    }

    // Reset failed/pending steps; keep completed steps as-is
    const stepsToResume = workflow.steps.filter((s) =>
      s.status === 'FAILED' || s.status === 'PENDING' || s.status === 'SKIPPED'
    );
    await prisma.$transaction([
      prisma.workflow.update({ where: { id: workflow.id }, data: { status: 'RUNNING' } }),
      ...stepsToResume.map((s) =>
        prisma.workflowStep.update({ where: { id: s.id }, data: { status: 'PENDING' } })
      ),
    ]);

    // Re-emit workflow.created so Orchestrator re-initializes
    await produceMessage(
      Topics.WORKFLOW_CREATED,
      { workflowId: workflow.id, definition: workflow.definition as any },
      workflow.id
    );

    return reply.send({ message: 'Workflow resumed' });
  });
}
```

---

## `src/routes/dlq.ts`

```typescript
import { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '@forge-engine/prisma';
import { produceMessage, Topics } from '@forge-engine/kafka';

export async function dlqRoutes(server: FastifyInstance) {

  server.get('/dlq', async (_req, reply) => {
    const entries = await prisma.deadLetterQueue.findMany({
      orderBy: { movedAt: 'desc' },
      take: 100,
    });
    return reply.send(entries);
  });

  // POST /dlq/:id/replay — Resubmit as fresh job (attempt = 0)
  server.post<{ Params: { id: string } }>('/dlq/:id/replay', async (request, reply) => {
    const dlqEntry = await prisma.deadLetterQueue.findUnique({
      where: { id: request.params.id },
    });
    if (!dlqEntry) return reply.code(404).send({ error: 'DLQ entry not found' });

    const newJobId = uuidv4();
    await prisma.job.create({
      data: {
        id: newJobId,
        type: dlqEntry.jobType,
        payload: dlqEntry.payload,
        status: 'PENDING',
        maxAttempts: 3,
        backoff: 'EXPONENTIAL',
      },
    });

    await produceMessage(
      Topics.JOB_SUBMITTED,
      { jobId: newJobId, type: dlqEntry.jobType, payload: dlqEntry.payload as any,
        priority: 'normal', delayMs: 0, maxAttempts: 3, backoff: 'exponential', attempt: 0 },
      newJobId
    );

    await prisma.deadLetterQueue.update({
      where: { id: request.params.id },
      data: { replayedAt: new Date() },
    });

    return reply.send({ jobId: newJobId });
  });

  server.delete<{ Params: { id: string } }>('/dlq/:id', async (request, reply) => {
    await prisma.deadLetterQueue.delete({ where: { id: request.params.id } });
    return reply.code(204).send();
  });
}
```

---

## `src/routes/schedules.ts`

```typescript
import { FastifyInstance } from 'fastify';
import parser from 'cron-parser';
import { prisma } from '@forge-engine/prisma';
import type { CreateScheduleRequest, UpdateScheduleRequest } from '@forge-engine/types';

export async function scheduleRoutes(server: FastifyInstance) {
  server.get('/schedules', async (_req, reply) => {
    const schedules = await prisma.schedule.findMany({ orderBy: { createdAt: 'desc' } });
    return reply.send(schedules);
  });

  server.post<{ Body: CreateScheduleRequest }>('/schedules', async (request, reply) => {
    const { name, type, cronExpr, runAt, jobType, payload } = request.body;

    let nextRunAt: Date;
    if (type === 'cron') {
      if (!cronExpr) return reply.code(400).send({ error: 'cronExpr required for cron schedule' });
      nextRunAt = parser.parseExpression(cronExpr).next().toDate();
    } else {
      if (!runAt) return reply.code(400).send({ error: 'runAt required for one-shot schedule' });
      nextRunAt = new Date(runAt);
    }

    const schedule = await prisma.schedule.create({
      data: {
        name, type: type === 'cron' ? 'CRON' : 'ONE_SHOT',
        cronExpr, runAt: runAt ? new Date(runAt) : undefined,
        nextRunAt, jobType, payload: payload as any,
      },
    });

    return reply.code(201).send(schedule);
  });

  server.patch<{ Params: { id: string }; Body: UpdateScheduleRequest }>(
    '/schedules/:id', async (request, reply) => {
      const schedule = await prisma.schedule.update({
        where: { id: request.params.id },
        data: {
          ...(request.body.cronExpr && { cronExpr: request.body.cronExpr }),
          ...(request.body.payload && { payload: request.body.payload as any }),
          ...(request.body.active !== undefined && { active: request.body.active }),
        },
      });
      return reply.send(schedule);
    }
  );

  server.delete<{ Params: { id: string } }>('/schedules/:id', async (request, reply) => {
    await prisma.schedule.delete({ where: { id: request.params.id } });
    return reply.code(204).send();
  });
}
```

---

## `src/routes/workers.ts`

```typescript
import { FastifyInstance } from 'fastify';
import { prisma } from '@forge-engine/prisma';

export async function workerRoutes(server: FastifyInstance) {
  server.get('/workers', async (_req, reply) => {
    const workers = await prisma.worker.findMany({ orderBy: { registeredAt: 'desc' } });
    // A worker is "dead" if lastHeartbeat > 30s ago
    const HEARTBEAT_THRESHOLD_MS = 30_000;
    const now = Date.now();
    const enriched = workers.map((w) => ({
      ...w,
      isAlive: now - w.lastHeartbeat.getTime() < HEARTBEAT_THRESHOLD_MS,
    }));
    return reply.send(enriched);
  });
}
```

---

## `src/routes/events.ts` (SSE)

```typescript
import { FastifyInstance } from 'fastify';
import { redisSubscriber, PubSubChannels } from '@forge-engine/redis';

export async function eventsRoutes(server: FastifyInstance) {
  server.get('/events', async (request, reply) => {
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.flushHeaders();

    // Keep-alive ping every 15 seconds
    const pingInterval = setInterval(() => {
      reply.raw.write(': ping\n\n');
    }, 15_000);

    const handleMessage = (channel: string, message: string) => {
      reply.raw.write(`event: ${channel}\ndata: ${message}\n\n`);
    };

    // Subscribe to both pub/sub channels
    await redisSubscriber.subscribe(
      PubSubChannels.JOB_EVENTS,
      PubSubChannels.WORKFLOW_EVENTS,
    );
    redisSubscriber.on('message', handleMessage);

    request.raw.on('close', () => {
      clearInterval(pingInterval);
      redisSubscriber.off('message', handleMessage);
      // Note: unsubscribe is intentionally not called here to avoid
      // affecting other SSE clients sharing the subscriber. Each SSE
      // connection attaches its own listener.
    });

    // Prevent Fastify from auto-terminating the response
    return reply;
  });
}
```

> **Note on SSE subscriber pattern**: Use a single `redisSubscriber` connection for the entire API service. All SSE clients attach listeners to the same subscriber. This is efficient and correct since ioredis subscriber clients can have multiple message listeners.

---

## `src/routes/health.ts`

```typescript
import { FastifyInstance } from 'fastify';

export async function healthRoutes(server: FastifyInstance) {
  server.get('/health', async (_req, reply) => {
    return reply.send({ status: 'ok', service: 'api' });
  });
}
```

---

## `src/consumers/index.ts`

```typescript
import { startJobEventsConsumer } from './job-events';
import { startWorkflowEventsConsumer } from './workflow-events';
import { startDlqConsumer } from './dlq-consumer';
import { startScheduleAuditConsumer } from './schedule-audit';

export async function startApiConsumers() {
  await Promise.all([
    startJobEventsConsumer(),
    startWorkflowEventsConsumer(),
    startDlqConsumer(),
    startScheduleAuditConsumer(),
  ]);
}
```

---

## `src/consumers/job-events.ts`

```typescript
import { kafka, Topics } from '@forge-engine/kafka';
import { redis, PubSubChannels } from '@forge-engine/redis';

export async function startJobEventsConsumer() {
  const consumer = kafka.consumer({ groupId: process.env.KAFKA_GROUP_ID_API ?? 'api-consumers' });
  await consumer.connect();

  await consumer.subscribe({
    topics: [Topics.JOB_STARTED, Topics.JOB_COMPLETED, Topics.JOB_FAILED],
    fromBeginning: false,
  });

  await consumer.run({
    eachMessage: async ({ topic, message }) => {
      if (!message.value) return;
      // Forward raw JSON to Redis pub/sub for SSE clients
      await redis.publish(PubSubChannels.JOB_EVENTS, message.value.toString());
    },
  });
}
```

---

## `src/consumers/dlq-consumer.ts`

```typescript
import { kafka, Topics } from '@forge-engine/kafka';
import { prisma } from '@forge-engine/prisma';
import type { JobDlqEvent } from '@forge-engine/types';

export async function startDlqConsumer() {
  const consumer = kafka.consumer({ groupId: 'api-dlq-consumer' });
  await consumer.connect();
  await consumer.subscribe({ topics: [Topics.JOB_DLQ], fromBeginning: false });

  await consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      const event: JobDlqEvent = JSON.parse(message.value.toString());

      await prisma.deadLetterQueue.upsert({
        where: { jobId: event.jobId },
        update: { errorHistory: event.errorHistory as any },
        create: {
          jobId: event.jobId,
          jobType: event.type,
          payload: event.payload,
          errorHistory: event.errorHistory as any,
        },
      });
    },
  });
}
```
