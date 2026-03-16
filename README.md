# Forge Engine

A self-hostable distributed job scheduler and workflow orchestration engine built entirely in TypeScript. Submit background jobs, chain them into multi-step workflows, schedule them with cron or one-shot triggers, and observe everything in real time through a live dashboard and SSE stream.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20-green)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED)](infra/docker-compose.yml)

---

## Overview

Modern applications are full of deferred work: sending transactional emails, processing payments, generating reports, syncing data between systems, running ML pipelines. Every production service eventually needs a way to run tasks asynchronously, retry them on failure, chain them into ordered sequences, and observe what is happening.

The existing options are imperfect. Simple queues like BullMQ handle isolated jobs well but have no concept of multi-step workflows, fan-out/fan-in, or workflow-level observability. Enterprise engines like Temporal and Cadence are powerful but operationally heavy — they require dedicated infrastructure, have steep learning curves, and are overkill for teams that need reliable background processing without a platform team to support it. DIY solutions built on raw Redis or database polling are fragile, hard to scale, and invisible until something breaks.

Forge Engine sits in the gap. It is a self-hostable, Node.js-native, workflow-first job engine with real observability, a typed SDK, and a live dashboard — deployable with a single `docker compose up`. It is built on proven infrastructure (Kafka, Redis, PostgreSQL) and enforces a strict architectural contract between services so that correctness is a structural property, not a testing concern.

---

## Features

### Job Execution
- Submit background jobs via REST API or the typed Node.js SDK
- Configurable retry policy: `fixed`, `linear`, or `exponential` backoff
- Job priority levels: `low`, `normal`, `high`, `critical`
- Delayed execution — hold a job for N milliseconds before first attempt
- Idempotency keys — submitting the same job twice returns the existing job ID
- Per-job progress reporting (`ctx.progress(0–100)`) written to Redis, streamed live
- Per-job structured logging (`ctx.log(message)`) stored in Redis and visible in the dashboard
- Graceful worker shutdown — in-flight jobs complete before the process exits

### Workflow Orchestration
- Multi-step workflows defined as a JSON graph or built with the SDK's fluent API
- Sequential dependency resolution: step B starts only after step A completes (`dependsOn`)
- Parallel fan-out: multiple steps in the same `parallelGroup` execute simultaneously
- Fan-in: a downstream step waits for every member of its upstream parallel group before starting (tracked with Redis counters)
- `onFailure` handler: if a workflow fails, a designated cleanup job is automatically submitted
- Idempotent step execution — the orchestrator is the only service that writes workflow step state
- Full workflow state machine: `PENDING` → `RUNNING` → `COMPLETED` / `FAILED`

### Scheduling
- Cron schedules with standard 5-part cron expressions
- One-shot schedules that fire once at a specific datetime
- Distributed poll lock (`lock:scheduler:tick`) ensures exactly one scheduler instance fires per tick across all replicas
- Schedules can be paused, updated, or deleted at runtime via the API

### Dead Letter Queue
- Jobs that exhaust all retry attempts are automatically moved to the DLQ
- Full error history stored for every failed attempt, including the attempt number, error message, and timestamp
- Replay a DLQ job as a fresh first attempt with one API call
- Delete DLQ entries permanently once resolved

### Real-Time Observability
- Server-Sent Events (SSE) stream at `/events` — push job and workflow state changes to any connected client
- Dashboard with live-updating job list, workflow step graph (color progression: grey to blue to green or red), and DLQ view
- Worker registry with heartbeat timestamps — see which workers are alive, which are dead, and what job types each handles
- Full audit log of every status transition written to PostgreSQL with timestamps

### Security
- API key authentication on all write endpoints
- SHA-256 key hashing — the plaintext key is never stored
- Rate limiting: 1000 requests per minute per API key, tracked in Redis
- Keys can be created, listed, and revoked without restarting any service

### Developer Experience
- Typed Node.js SDK (`@forge-engine/sdk`) with `JobEngine` and `Worker` classes
- Full TypeScript across all services, packages, and the SDK
- Turborepo monorepo — one `npm run build` compiles everything in dependency order
- Kafka UI included at port 8080 for inspecting message flow during development
- One-command local setup: `docker compose up`

---

## Architecture

```
                        +------------------+
                        |  Developer / SDK |
                        +--------+---------+
                                 |
                           HTTP REST API
                                 |
                    +------------v-----------+
                    |      API Service       |
                    |      (Fastify)         |
                    +---+--------+------+----+
                        |        |      |
                   Write to   Produce  Pub/Sub
                   Postgres   Kafka    Redis (SSE)
                        |        |      |
               +--------v+  +----v----+ |
               |PostgreSQL|  |  Kafka  | |
               +----+-----+  +----+----+ |
                    |              |      |
          +---------+    +---------+------+--------+
          |              |                         |
   +------v------+  +----v-------+         +-------v------+
   |Orchestrator |  |  Worker    |         |  Scheduler   |
   |(state mach.)|  |(consumers) |         |(cron/oneshot)|
   +------+------+  +----+-------+         +-------+------+
          |              |                         |
     Read/Write     Redlock +                 Lock + Poll
     Postgres       Progress/Logs             Postgres
          |         Redis                         |
          |              |                   POST /jobs
          +-------+-------+                       |
                  |                               |
              +---v---+                           |
              | Redis |<--------------------------+
              +-------+
```

The data flow contract between services is enforced structurally:

- The API service never triggers workers directly. It writes to PostgreSQL, then produces to Kafka.
- Workers never update PostgreSQL. They emit Kafka events only.
- The orchestrator is the only service that writes workflow step state to PostgreSQL.
- Every Redis lock has a TTL. A lock without TTL is a bug.
- PostgreSQL is written before Kafka is produced. If Kafka is unavailable, the job record still exists.

---

## Job State Machine

```
[POST /jobs]
     |
     v
  PENDING
     |
     | Worker picks up job
     v
  RUNNING
     |
     +------ Handler succeeds ------> COMPLETED
     |
     +------ Handler throws ----------> FAILED
                                          |
                              attempt < maxAttempts
                                          |
                                          v
                                       RETRYING
                                          |
                                   After backoff delay
                                          |
                                          v
                                       RUNNING (next attempt)
                                          |
                              attempt === maxAttempts
                                          |
                                          v
                                        DEAD
                                          |
                                   Moved to DLQ
```

---

## Quick Start

### Prerequisites

- Docker and Docker Compose
- Node.js 20 or later (for local development only)

### 1. Clone and install

```bash
git clone https://github.com/KUSHAL-31/forge-engine.git
cd forge-engine
npm install
```

### 2. Start the full stack

```bash
docker compose -f infra/docker-compose.yml up -d
```

This starts PostgreSQL, Redis, Kafka, Zookeeper, the API service, Orchestrator, two Worker replicas, Scheduler, Dashboard, and Kafka UI. The `migrate` container runs `prisma db push` and seeds the dev API key automatically.

### 3. Verify the API is up

```bash
curl http://localhost:3000/health
# {"status":"ok","service":"api"}
```

### 4. Submit your first job

```bash
curl -X POST http://localhost:3000/jobs \
  -H "Authorization: Bearer forge-dev-api-key-12345" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "send-email",
    "payload": { "to": "user@example.com", "subject": "Hello from Forge" }
  }'
```

### 5. Open the dashboard

```
http://localhost:5173
```

### 6. Open Kafka UI (optional, for debugging message flow)

```
http://localhost:8080
```

---

## SDK Usage

Install the SDK in your application:

```bash
npm install @forge-engine/sdk
```

### Submitting a standalone job

```typescript
import { JobEngine } from '@forge-engine/sdk';

const engine = new JobEngine({
  apiUrl: 'http://localhost:3000',
  apiKey: 'forge-dev-api-key-12345',
});

const { jobId } = await engine.submitJob({
  type: 'send-email',
  payload: { to: 'user@example.com', subject: 'Welcome', body: 'Thanks for signing up.' },
  retries: 3,
  backoff: 'exponential',
  priority: 'high',
  delay: 0,
});
```

### Polling job status

```typescript
const job = await engine.getJob(jobId);

console.log(job.status);    // 'COMPLETED'
console.log(job.progress);  // 100
console.log(job.logs);      // ['Sending email to user@example.com', 'Done']
console.log(job.result);    // { sent: true, messageId: 'msg_abc123' }
```

### Submitting a sequential workflow

Steps run in order based on `dependsOn`. Step B does not start until step A completes successfully.

```typescript
const { workflowId } = await engine.submitWorkflow({
  name: 'order-processing',
  steps: [
    {
      name: 'validate',
      type: 'validate-order',
      payload: { orderId: '123' },
    },
    {
      name: 'charge',
      type: 'charge-payment',
      payload: { orderId: '123', amount: 4999 },
      dependsOn: ['validate'],
    },
    {
      name: 'fulfil',
      type: 'create-shipment',
      payload: { orderId: '123' },
      dependsOn: ['charge'],
    },
    {
      name: 'notify',
      type: 'send-email',
      payload: { to: 'user@example.com', subject: 'Your order is confirmed' },
      dependsOn: ['fulfil'],
    },
  ],
  onFailure: {
    type: 'notify-ops',
    payload: { orderId: '123', channel: 'slack' },
  },
});
```

### Submitting a parallel fan-out / fan-in workflow

Steps in the same `parallelGroup` execute simultaneously. A step with `dependsOn` pointing to all parallel steps starts only when every one of them has completed (fan-in).

```typescript
await engine.submitWorkflow({
  name: 'monthly-report',
  steps: [
    {
      name: 'fetch-users',
      type: 'query-db',
      payload: { table: 'users', month: '2024-01' },
      parallelGroup: 'fetch',
    },
    {
      name: 'fetch-orders',
      type: 'query-db',
      payload: { table: 'orders', month: '2024-01' },
      parallelGroup: 'fetch',
    },
    {
      name: 'fetch-revenue',
      type: 'query-db',
      payload: { table: 'payments', month: '2024-01' },
      parallelGroup: 'fetch',
    },
    {
      name: 'generate-report',
      type: 'build-pdf-report',
      payload: { format: 'pdf', title: 'Monthly Report Jan 2024' },
      dependsOn: ['fetch-users', 'fetch-orders', 'fetch-revenue'],
    },
    {
      name: 'distribute',
      type: 'send-email',
      payload: { to: 'cfo@company.com', subject: 'Monthly Report' },
      dependsOn: ['generate-report'],
    },
  ],
});
```

### Creating a cron schedule

```typescript
const { scheduleId } = await engine.createSchedule({
  name: 'daily-cleanup',
  type: 'cron',
  cronExpr: '0 2 * * *',   // every day at 02:00
  jobType: 'cleanup-expired-sessions',
  payload: { olderThanDays: 30 },
});
```

### Creating a one-shot schedule

```typescript
await engine.createSchedule({
  name: 'send-reminder',
  type: 'one_shot',
  runAt: '2024-06-01T09:00:00Z',
  jobType: 'send-email',
  payload: { to: 'user@example.com', subject: 'Your trial expires tomorrow' },
});
```

### Registering a worker

```typescript
import { Worker } from '@forge-engine/sdk';

const worker = new Worker();

worker
  .register('send-email', async (ctx) => {
    const { to, subject, body } = ctx.data;

    await ctx.log(`Sending email to ${to}`);
    await ctx.progress(10);

    const result = await emailClient.send({ to, subject, body });
    await ctx.progress(100);

    return { sent: true, messageId: result.id };
  })
  .register('validate-order', async (ctx) => {
    const { orderId } = ctx.data;
    await ctx.log(`Validating order ${orderId}`);

    const order = await db.orders.findById(orderId);
    if (!order) throw new Error(`Order ${orderId} not found`);

    return { valid: true, total: order.total };
  })
  .register('charge-payment', async (ctx) => {
    const { orderId, amount } = ctx.data;
    await ctx.log(`Charging ${amount} for order ${orderId}`);
    await ctx.progress(50);

    const charge = await paymentGateway.charge({ amount });
    await ctx.progress(100);

    return { charged: true, chargeId: charge.id };
  });

await worker.start({
  kafkaBrokers: ['localhost:9092'],
  redisHost: 'localhost',
  redisPort: 6379,
});
```

---

## API Reference

All endpoints except `/health` require the header: `Authorization: Bearer {apiKey}`

### Jobs

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/jobs` | Submit a background job |
| `GET` | `/jobs` | List jobs with optional status filter |
| `GET` | `/jobs/:id` | Get job detail including progress, logs, and result |

**POST /jobs request body**

```json
{
  "type": "send-email",
  "payload": { "to": "user@example.com" },
  "retries": 3,
  "backoff": "exponential",
  "priority": "normal",
  "delay": 0,
  "idempotencyKey": "order-123-welcome-email"
}
```

### Workflows

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/workflows` | Submit a workflow definition |
| `GET` | `/workflows` | List workflows |
| `GET` | `/workflows/:id` | Get workflow with all step statuses |
| `POST` | `/workflows/:id/resume` | Resume a failed workflow from the last failed step |

**POST /workflows request body**

```json
{
  "name": "order-processing",
  "steps": [
    { "name": "validate", "type": "validate-order", "payload": {} },
    { "name": "charge", "type": "charge-payment", "payload": {}, "dependsOn": ["validate"] }
  ],
  "onFailure": { "type": "notify-ops", "payload": {} }
}
```

### Schedules

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/schedules` | List all schedules |
| `POST` | `/schedules` | Create a cron or one-shot schedule |
| `PATCH` | `/schedules/:id` | Update cron expression, payload, or active status |
| `DELETE` | `/schedules/:id` | Delete a schedule |

**POST /schedules request body (cron)**

```json
{
  "name": "nightly-cleanup",
  "type": "cron",
  "cronExpr": "0 3 * * *",
  "jobType": "cleanup-logs",
  "payload": { "retainDays": 90 }
}
```

**POST /schedules request body (one-shot)**

```json
{
  "name": "trial-expiry-reminder",
  "type": "one_shot",
  "runAt": "2024-12-01T09:00:00Z",
  "jobType": "send-email",
  "payload": { "to": "user@example.com" }
}
```

### Dead Letter Queue

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/dlq` | List dead letter queue entries (most recent first) |
| `POST` | `/dlq/:id/replay` | Replay a DLQ entry as a fresh job (attempt reset to 0) |
| `DELETE` | `/dlq/:id` | Permanently delete a DLQ entry |

### Workers

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/workers` | List registered workers with heartbeat timestamps and job type support |

### System

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Health check — returns `{"status":"ok"}` |
| `GET` | `/events` | SSE stream of live job and workflow events |

---

## Environment Variables

### API Service

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | — | PostgreSQL connection string |
| `REDIS_HOST` | `localhost` | Redis hostname |
| `REDIS_PORT` | `6379` | Redis port |
| `KAFKA_BROKERS` | `localhost:9092` | Comma-separated Kafka broker addresses |
| `API_PORT` | `3000` | Port the API listens on |
| `RATE_LIMIT_MAX` | `1000` | Max requests per minute per API key |

### Worker Service

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | — | PostgreSQL connection string |
| `REDIS_HOST` | `localhost` | Redis hostname |
| `KAFKA_BROKERS` | `localhost:9092` | Kafka broker addresses |
| `WORKER_ID` | auto-generated | Unique worker identifier for heartbeat |
| `KAFKA_GROUP_ID` | `workers` | Kafka consumer group ID |

### Orchestrator Service

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | — | PostgreSQL connection string |
| `REDIS_HOST` | `localhost` | Redis hostname |
| `KAFKA_BROKERS` | `localhost:9092` | Kafka broker addresses |
| `KAFKA_GROUP_ID_ORCHESTRATOR` | `orchestrator` | Kafka consumer group ID |

### Scheduler Service

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | — | PostgreSQL connection string |
| `REDIS_HOST` | `localhost` | Redis hostname |
| `API_BASE_URL` | `http://localhost:3000` | Internal URL of the API service |
| `INTERNAL_API_KEY` | — | API key used by the scheduler to submit jobs |
| `SCHEDULER_POLL_INTERVAL_MS` | `10000` | How often the scheduler checks for due schedules |

---

## Tech Stack

| Layer | Technology | Rationale |
|-------|------------|-----------|
| Language | TypeScript 5 / Node.js 20 | Single language across all services and the SDK |
| API framework | Fastify | Lower overhead than Express; built-in schema validation; native async/await |
| Message bus | Apache Kafka (KafkaJS) | Consumer groups for load balancing; event retention for replay; multiple services consume the same events independently |
| Distributed locking | Redis + Redlock | Fast cross-process mutex; handles horizontal scale; fails safely on network partitions |
| Job state cache | Redis (ioredis) | Sub-millisecond reads for progress and logs without hitting PostgreSQL on every poll |
| Pub/Sub for SSE | Redis pub/sub | Push events to dashboard clients instantly when job state changes |
| Database | PostgreSQL (Prisma) | ACID guarantees; durable source of truth for job and workflow state; relational step dependency resolution |
| Dashboard | React + Vite | SSE-driven live updates; no server-side rendering needed |
| Monorepo | Turborepo + npm workspaces | Parallel builds; shared packages; single `npm install` |
| Local infrastructure | Docker Compose | One command to run the entire stack including Kafka, Zookeeper, PostgreSQL, Redis |
| Production | Kubernetes + Helm | Independent service scaling; HPA for workers based on Kafka consumer lag |

---

## Project Structure

```
forge-engine/
├── apps/
│   ├── api/                   # Fastify REST API — 15 routes, SSE endpoint, Kafka consumers
│   │   └── src/
│   │       ├── routes/        # jobs, workflows, schedules, dlq, workers, events, health
│   │       ├── consumers/     # Kafka consumers that bridge events to SSE
│   │       └── middleware/    # Auth (API key) and rate limiting (Redis)
│   ├── orchestrator/          # Workflow state machine — consumes job events, advances step graph
│   │   └── src/
│   │       ├── consumers/     # job-completed, job-failed, job-started, workflow-created
│   │       └── lib/           # step-resolver (dependency graph), backoff calculator
│   ├── worker/                # Job execution engine — Kafka consumer + Redlock
│   │   └── src/
│   │       ├── consumer.ts    # Kafka message handler with distributed lock
│   │       ├── context.ts     # JobContext — progress(), log(), data, jobId
│   │       └── handlers/      # Built-in example job handlers
│   ├── scheduler/             # Cron and one-shot schedule poll loop
│   │   └── src/
│   │       └── poll.ts        # Poll loop with distributed lock, HTTP submit to API
│   └── dashboard/             # React + Vite SPA
│       └── src/
│           ├── views/         # Jobs, JobDetail, Workflows, WorkflowDetail, Schedules, DLQ, Workers
│           ├── hooks/         # useSSE — connects to /events and updates Zustand stores
│           └── stores/        # Zustand stores for jobs, workflows, workers
├── packages/
│   ├── types/                 # Shared TypeScript interfaces — Kafka event payloads, API request/response types, logger
│   ├── kafka/                 # KafkaJS client factory, topic constants, typed producer helper
│   ├── redis/                 # ioredis client, Redlock factory, Redis key builders, TTL constants
│   ├── prisma/                # Prisma schema (8 models), migrations, seed script, audit log helper
│   └── sdk/                   # Public SDK — JobEngine (HTTP client) and Worker (Kafka consumer) classes
├── infra/
│   ├── docker-compose.yml     # Full stack: infra + all 5 application services
│   ├── dockerfiles/           # Multi-stage Dockerfiles for api, orchestrator, worker, scheduler, dashboard
│   ├── nginx.conf             # Nginx config for the dashboard container
│   └── helm/                  # Kubernetes Helm chart with Deployments, Services, ConfigMaps, HPA
├── turbo.json                 # Turborepo task pipeline
├── tsconfig.base.json         # Shared TypeScript compiler options
└── jest.config.base.js        # Shared Jest configuration
```

---

## Data Model

### Job

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Unique job identifier |
| `type` | string | Handler name — matched to a registered worker handler |
| `payload` | JSON | Arbitrary data passed to the handler |
| `status` | enum | `PENDING`, `RUNNING`, `COMPLETED`, `FAILED`, `RETRYING`, `DEAD` |
| `priority` | enum | `LOW`, `NORMAL`, `HIGH`, `CRITICAL` |
| `attempts` | int | Number of execution attempts so far |
| `maxAttempts` | int | Maximum attempts before the job moves to DEAD |
| `backoff` | enum | `FIXED`, `LINEAR`, `EXPONENTIAL` |
| `delayMs` | int | Milliseconds to wait before first execution |
| `idempotencyKey` | string? | Optional deduplication key |
| `result` | JSON? | Return value from the handler on success |
| `error` | string? | Last error message on failure |
| `workflowId` | UUID? | Parent workflow if this job is a workflow step |
| `stepId` | UUID? | Associated workflow step if applicable |

### Workflow

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Unique workflow identifier |
| `name` | string | Human-readable workflow name |
| `status` | enum | `PENDING`, `RUNNING`, `COMPLETED`, `FAILED` |
| `definition` | JSON | Original step graph definition as submitted |
| `completedAt` | datetime? | Timestamp of completion or failure |

### WorkflowStep

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Unique step identifier |
| `workflowId` | UUID | Parent workflow |
| `name` | string | Step name — used for `dependsOn` resolution |
| `jobType` | string | Job handler type to execute for this step |
| `status` | enum | `PENDING`, `RUNNING`, `COMPLETED`, `FAILED`, `SKIPPED` |
| `dependsOn` | string[] | Names of steps that must complete before this one starts |
| `parallelGroup` | string? | Group name for parallel execution |
| `position` | int | Display order in the dashboard step graph |
| `result` | JSON? | Handler return value on success |
| `error` | string? | Error message on failure |

### Schedule

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Unique schedule identifier |
| `name` | string | Human-readable schedule name |
| `type` | enum | `CRON` or `ONE_SHOT` |
| `cronExpr` | string? | Cron expression (cron schedules only) |
| `runAt` | datetime? | Exact fire time (one-shot schedules only) |
| `nextRunAt` | datetime | Next scheduled execution time |
| `jobType` | string | Job handler type to submit when the schedule fires |
| `payload` | JSON | Payload passed to the submitted job |
| `active` | boolean | Whether the schedule is active |
| `lastRunAt` | datetime? | Timestamp of most recent execution |

---

## Kafka Topics

| Topic | Producer | Consumers | Description |
|-------|----------|-----------|-------------|
| `job.submitted` | API, Orchestrator | Worker | New job ready for execution |
| `job.retry` | Orchestrator | Worker | Job retry after backoff delay |
| `job.started` | Worker | Orchestrator, API | Worker has acquired the job lock |
| `job.completed` | Worker | Orchestrator, API | Job finished successfully |
| `job.failed` | Worker | Orchestrator, API | Job attempt failed |
| `job.dlq` | Orchestrator | API | Job exhausted all retries |
| `workflow.created` | API | Orchestrator | New workflow submitted |
| `workflow.step_done` | Orchestrator | API | A workflow step changed state |
| `workflow.completed` | Orchestrator | API | All workflow steps finished |

---

## Redis Keys

| Key Pattern | Type | TTL | Description |
|-------------|------|-----|-------------|
| `job:state:{jobId}` | string | 24h | Current job state for SSE |
| `job:progress:{jobId}` | string | 24h | Progress percentage (0–100) |
| `job:logs:{jobId}` | list | 24h | Structured log entries |
| `lock:job:{jobId}` | string | 30s | Redlock for exactly-once execution |
| `lock:workflow:{workflowId}` | string | 30s | Redlock for orchestrator step transitions |
| `lock:scheduler:tick` | string | 15s | Distributed lock for the scheduler poll loop |
| `rate:{apiKeyHash}` | string | 60s | Request count for rate limiting |
| `workflow:group:total:{wfId}:{group}` | string | 1h | Total step count in a parallel group |
| `workflow:group:done:{wfId}:{group}` | string | 1h | Completed step count for fan-in |

---

## Deployment

### Docker Compose (development and staging)

```bash
# Start everything
docker compose -f infra/docker-compose.yml up -d

# View logs for a specific service
docker logs forge-api -f
docker logs forge-orchestrator -f

# Scale workers
docker compose -f infra/docker-compose.yml up -d --scale worker=4

# Tear down (preserves volumes)
docker compose -f infra/docker-compose.yml down

# Tear down and delete all data
docker compose -f infra/docker-compose.yml down -v
```

### Kubernetes (production)

The `infra/helm/` directory contains a Helm chart for deploying all services to Kubernetes. Each service is a separate Deployment with its own ConfigMap. The worker Deployment includes a HorizontalPodAutoscaler that scales based on Kafka consumer group lag.

```bash
# Install
helm install forge-engine ./infra/helm \
  --set postgresql.url="postgresql://..." \
  --set redis.host="redis.internal" \
  --set kafka.brokers="kafka.internal:9092"

# Scale workers manually
kubectl scale deployment forge-worker --replicas=8

# View HPA status
kubectl get hpa forge-worker-hpa
```

For production deployments, PostgreSQL and Redis should be managed cloud services (e.g. AWS RDS, ElastiCache). Kafka can be managed (Confluent Cloud, AWS MSK) or self-hosted with replication factor set to 3.

---

## FAQ

**How is this different from BullMQ?**

BullMQ handles isolated jobs backed by Redis. It has no concept of multi-step workflows, dependency resolution between steps, fan-out/fan-in, or workflow-level observability. Forge Engine adds a full workflow orchestration layer, distributed locking across service boundaries, a Kafka-backed event bus for independent consumer groups, and a live dashboard — on top of durable PostgreSQL storage.

**How is this different from Temporal?**

Temporal is powerful but operationally heavy. It requires a dedicated server cluster, uses its own persistence layer, and has a steep learning curve around workflow versioning and determinism constraints. Forge Engine is a standard Node.js application running on infrastructure you already know — PostgreSQL, Redis, Kafka. You can have it running in production in an afternoon.

**What happens if a worker crashes mid-job?**

The Kafka consumer group rebalances and re-delivers the message to another worker instance. The Redlock TTL (30 seconds) ensures the crashed worker's lock expires, allowing the new worker to acquire the lock and execute the job. Combined with idempotent job handlers, this provides at-least-once execution with the Redlock preventing concurrent duplicates.

**What happens if Kafka is unavailable when a job is submitted?**

Because the API writes to PostgreSQL before producing to Kafka, the job record exists in the database. On Kafka recovery, unprocessed jobs can be requeued from PostgreSQL. The database is always the durable source of truth.

**What happens if the orchestrator crashes mid-workflow?**

The workflow state is persisted in PostgreSQL after every step transition. On restart, the orchestrator resumes from the current database state. In-flight Kafka messages are re-delivered by the consumer group. Redlock prevents duplicate step transitions.

**Can I run multiple worker instances?**

Yes. Kafka consumer groups automatically distribute `job.submitted` messages across all worker replicas. Redlock provides a second layer — only one worker can execute a given job at a time even if the same message is delivered to multiple workers.

**How do I add a new job type?**

Register a handler in `apps/worker/src/handlers/` and add it to the handlers Map in `apps/worker/src/index.ts`. When using the SDK: `worker.register('my-type', async (ctx) => { ... })`. No schema changes required.

**Can I use Forge Engine with an existing database?**

The Prisma schema creates its own tables in a dedicated schema. As long as the `DATABASE_URL` points to a PostgreSQL database the service user has write access to, there is no conflict with existing tables.

**What is the maximum job payload size?**

1 MB. For larger data — files, images, large datasets — store the content in object storage (S3, GCS) and pass a reference URL or key in the payload.

**Is there a Python or Go SDK?**

No. Forge Engine is intentionally TypeScript-only. The REST API is language-agnostic, so any HTTP client can submit jobs and poll status. A typed SDK for other languages is not on the roadmap.

**Can I host this on a single machine?**

Yes. The `docker compose` setup runs the entire stack on one machine. For a single-node deployment with reduced resource usage, you can lower Kafka replication factors, use a single worker replica, and reduce the scheduler poll interval.

---

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/your-feature`
3. Follow the conventional commit format: `feat(scope): description`
4. Ensure the build passes: `npm run build`
5. Submit a pull request with a clear description of the change

The `docs/` folder contains 13 detailed implementation guides covering every service and package. Read `docs/00_overview_and_architecture.md` before contributing — it defines the architectural invariants that must never be violated.

---

## License

MIT — see [LICENSE](LICENSE)
