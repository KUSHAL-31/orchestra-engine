# Forge Engine

> A self-hostable, open-source **Distributed Job Scheduler & Workflow Engine** built entirely in TypeScript.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20-green?logo=node.js)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker)](infra/docker-compose.yml)

---

**Forge Engine** is the developer-friendly middle ground between basic queues (BullMQ) and heavyweight orchestrators (Temporal). Submit jobs, chain them into multi-step workflows, schedule them, and watch them execute in real time — all with a clean REST API, a typed SDK, and a live dashboard.

> Get started in 5 minutes with `docker compose up`

---

## Why Forge Engine?

Modern applications are full of background work: sending transactional emails, generating reports, processing payments, syncing data between systems, and running ML pipelines. Every production service eventually needs a way to run tasks asynchronously, retry them on failure, and observe their progress.

Today, developers face three imperfect options. **Simple queues** like BullMQ handle isolated jobs well but have no concept of multi-step workflows, fan-out/fan-in patterns, or workflow-level observability. **Enterprise orchestration engines** like Temporal and Cadence are powerful but operationally heavy — they require dedicated clusters, have steep learning curves, and are overkill for teams that just need reliable background processing. **DIY solutions** built on raw Redis or database polling are fragile, hard to scale, and lack visibility into what's happening.

There is a gap in the ecosystem: no self-hostable, Node.js-native, workflow-first job engine with real observability, a typed SDK, and a live dashboard — all deployable with a single `docker compose up`. Forge Engine fills that gap.

Forge Engine gives you job scheduling with configurable retries and backoff, multi-step workflow orchestration with dependency resolution, distributed locking for exactly-once execution, real-time SSE streaming, and a React dashboard — built on battle-tested infrastructure (Kafka, Redis, Postgres) and written entirely in TypeScript.

---

## Features

### Job Management
- Submit background jobs via REST API or typed Node.js SDK
- Configurable retries with `fixed | linear | exponential` backoff
- Job priority: `low | normal | high | critical`
- Delayed job execution (delay before first attempt)
- Idempotency keys — safe to submit the same job twice, always get back the same job ID
- Live progress reporting (`ctx.progress(0–100)`) streamed to the dashboard in real time
- Structured per-job logging (`ctx.log(msg)`) stored in Redis and visible in the dashboard
- Graceful shutdown — in-flight jobs complete before the worker process exits

### Workflow Orchestration
- Multi-step workflows with a clean JSON definition or fluent SDK builder
- Sequential steps with `dependsOn` — step B only starts after step A completes
- Parallel fan-out — multiple steps run simultaneously in a `parallelGroup`
- Fan-in — a downstream step waits for all parallel steps to finish before starting (tracked with Redis atomic counters)
- `onFailure` handler — a dedicated cleanup job is automatically submitted when a workflow fails
- Resume failed workflows without re-running completed steps
- Full step-level status tracking: `PENDING`, `RUNNING`, `COMPLETED`, `FAILED`, `SKIPPED`

### Scheduling
- Cron schedules (standard 5-part cron syntax, e.g. `0 2 * * *`)
- One-shot scheduled jobs (fire once at a specific datetime)
- Distributed scheduler lock (`lock:scheduler:tick`) ensures exactly one scheduler fires per tick across all replicas
- Schedules can be paused, updated, or deleted at runtime without restarting any service

### Dead Letter Queue
- Automatic DLQ when a job exhausts all retry attempts
- Full error history stored for every failed attempt, including attempt number, error message, and timestamp
- Replay jobs from the DLQ as a fresh first attempt with one API call
- Permanent deletion of DLQ entries once resolved

### Real-Time Observability
- Server-Sent Events (SSE) stream at `/events` — every job and workflow state change is pushed instantly to connected clients
- Dashboard with real-time job list, live step graph for workflows (colours transition grey → blue → green or red), and live DLQ view
- Worker registry with heartbeat timestamps — see which worker instances are alive, which are dead, and what job types each one handles
- Full audit log of every status transition written durably to PostgreSQL with timestamps

### Security
- API key authentication on all write endpoints with SHA-256 hashing (plaintext never stored)
- Rate limiting: 1000 requests per minute per API key, enforced via Redis sliding window
- New API keys can be issued and revoked without restarting any service

### Developer Experience
- Fully typed TypeScript SDK (`@node-forge-engine/sdk`) with `JobEngine` and `Worker` classes
- Turborepo monorepo — a single `npm run build` compiles all packages and services in dependency order
- One-command local setup: `docker compose up` starts the entire stack
- Kafka UI included at port 8080 for inspecting raw message flow during development
- Multi-stage Docker builds with per-service Dockerfiles — production images are lean and contain only compiled output

---

## Architecture

```mermaid
graph TD
    Dev["Developer / SDK"] -->|HTTP REST| API["API Service\n(Fastify)"]
    API -->|writes| PG[("PostgreSQL\n(Prisma)")]
    API -->|produces| K1["Kafka"]

    K1 -->|workflow.created| ORC["Orchestrator"]
    K1 -->|job.submitted\njob.retry| WRK["Worker\n(Consumer Group)"]

    ORC -->|reads/writes| PG
    ORC -->|lock/fanin| RD[("Redis")]
    ORC -->|job.submitted| K2["Kafka"]

    WRK -->|Redlock| RD
    WRK -->|progress/logs| RD
    WRK -->|job.started\njob.completed\njob.failed| K3["Kafka"]

    K3 -->|job events| ORC
    K3 -->|forward| API
    API -->|pub/sub| RD

    SCH["Scheduler"] -->|polls| PG
    SCH -->|lock| RD
    SCH -->|POST /jobs| API

    DASH["Dashboard\n(React + Vite)"] -->|SSE + HTTP| API
    RD -->|pub/sub → SSE| DASH
```

The system enforces a strict contract between services:

- The API service never triggers workers directly. It writes to PostgreSQL, then produces to Kafka.
- Workers never update PostgreSQL. They emit Kafka events only.
- The orchestrator is the only service that writes workflow step state to PostgreSQL.
- Every Redis lock has a TTL. A lock without a TTL is a bug.
- PostgreSQL is always written before Kafka is produced. If Kafka is temporarily unavailable, the job record still exists in the database and can be requeued on recovery.

---

## Event Flow

```mermaid
sequenceDiagram
    participant C as Client/SDK
    participant A as API Service
    participant K as Kafka
    participant O as Orchestrator
    participant W as Worker
    participant R as Redis
    participant DB as PostgreSQL

    C->>A: POST /jobs {type, payload}
    A->>DB: INSERT job (status=PENDING)
    A->>K: produce job.submitted
    A-->>C: {jobId}

    K->>W: consume job.submitted
    W->>R: acquire Redlock (lock:job:{id})
    W->>K: produce job.started
    W->>R: SET job:state:{id} = running
    W->>W: execute handler(ctx)
    W->>R: SET job:progress:{id} = 50
    W->>R: RPUSH job:logs:{id}
    W->>K: produce job.completed {result}
    W->>R: release Redlock

    K->>A: consume job.completed
    A->>R: publish job.events (→ SSE)
    K->>O: consume job.completed
    O->>DB: UPDATE job status=COMPLETED
```

---

## Job State Machine

```mermaid
stateDiagram-v2
    [*] --> PENDING: POST /jobs
    PENDING --> RUNNING: Worker picks up
    RUNNING --> COMPLETED: Handler succeeds
    RUNNING --> FAILED: Handler throws
    FAILED --> RETRYING: attempt < maxAttempts
    RETRYING --> RUNNING: After backoff delay
    FAILED --> DEAD: attempt === maxAttempts
    DEAD --> [*]: Moved to DLQ
```

---

## Quick Start

### Prerequisites
- Docker + Docker Compose
- Node.js 20+ (for local development only)

### 1. Clone & Install
```bash
git clone https://github.com/KUSHAL-31/node-forge-engine.git
cd node-forge-engine
npm install
```

### 2. Start everything
```bash
docker compose -f infra/docker-compose.yml up -d
```

This starts: Postgres, Redis, Kafka, Zookeeper, API, Orchestrator, two Worker replicas, Scheduler, Dashboard, and Kafka UI. A `migrate` container automatically runs `prisma db push` and seeds the development API key before any application service starts.

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
  -d '{"type":"send-email","payload":{"to":"you@example.com","subject":"Hello from Forge!"}}'
# {"jobId":"4029e1c0-..."}
```

### 5. Open the Dashboard
```
http://localhost:5173
```

### 6. Open Kafka UI (optional)
```
http://localhost:8080
```

---

## Dashboard

The dashboard is a React + Vite SPA served at `http://localhost:5173`. It connects to the API's SSE stream on load and updates in real time — no manual refreshes needed. The left sidebar contains navigation links to all seven views.

### Jobs

The Jobs view (`/jobs`) shows a paginated, live-updating list of all submitted jobs. Each row displays the job ID, type, current status (colour-coded), priority, number of attempts, and when it was created.

Click any job row to open the **Job Detail** view, which shows:
- The current status and all metadata (payload, retries, backoff strategy, delay)
- A live progress bar that updates in real time as the worker calls `ctx.progress()`
- A structured log panel that streams entries as the worker calls `ctx.log()`, with timestamps
- The final result object on completion, or the error message and full stack trace on failure
- Which attempt is currently running and how many remain

### Workflows

The Workflows view (`/workflows`) lists all submitted workflows with their overall status, the number of steps completed out of the total, and when the workflow was created.

Click any workflow to open the **Workflow Detail** view, which shows:
- A live step dependency graph rendered as a node diagram. Each node represents one step and its current status. Colours follow the convention: grey (pending), blue (running), green (completed), red (failed), and yellow (skipped).
- The `dependsOn` edges are drawn as directed arrows between nodes, so you can see exactly which steps are blocking which.
- Parallel steps in the same `parallelGroup` are shown side by side, making fan-out/fan-in patterns immediately visible.
- Clicking a step node opens a side panel with that step's job detail — progress, logs, result, and error.

### Schedules

The Schedules view (`/schedules`) lists all active and paused cron and one-shot schedules. Each row shows the schedule name, type, cron expression or target datetime, the job type it will submit, and the next run time.

From this view you can:
- Create a new cron or one-shot schedule using the form in the top right
- Toggle a schedule between active and paused using the switch on the row
- Delete a schedule permanently

### Dead Letter Queue

The DLQ view (`/dlq`) shows all jobs that have exhausted their retry attempts and been moved to the dead letter queue. Each entry shows the job type, when it was moved to the DLQ, and a summary of the error.

Click an entry to expand its full error history — every failed attempt is recorded with its attempt number, the error message, and the exact timestamp. From here you can:
- **Replay** the job — resubmits it as a fresh attempt with the same payload, resetting the attempt counter to zero. You will see it appear immediately in the Jobs view.
- **Delete** the entry permanently once the underlying issue is resolved.

### Workers

The Workers view (`/workers`) shows all registered worker instances. Each row displays the worker ID, which job types it handles, its current status (active or dead), and the timestamp of its last heartbeat.

Workers send a heartbeat every 30 seconds. If a worker misses enough heartbeats, its status is marked as dead. This view lets you confirm that the right number of worker replicas are running and that no workers are silently disconnected.

---

## SDK Usage

### Submit a standalone job

```typescript
import { JobEngine } from '@node-forge-engine/sdk';

const engine = new JobEngine({
  apiUrl: 'http://localhost:3000',
  apiKey: 'forge-dev-api-key-12345',
});

const { jobId } = await engine.submitJob({
  type: 'send-email',
  payload: { to: 'user@example.com', subject: 'Welcome!', body: 'Hello!' },
  retries: 3,
  backoff: 'exponential',
  priority: 'high',
  delay: 5000,           // wait 5 seconds before first attempt
  idempotencyKey: 'welcome-email-user-42',
});
```

### Check job status and read progress

```typescript
const job = await engine.getJob(jobId);
console.log(job.status);    // 'COMPLETED'
console.log(job.progress);  // 100
console.log(job.logs);      // ['Connecting to SMTP...', 'Email sent.']
console.log(job.result);    // { sent: true, messageId: 'abc123' }
```

### Submit a sequential workflow

Each step only starts after all steps listed in its `dependsOn` have completed successfully. If any step fails and exhausts its retries, the entire workflow is marked as failed and the `onFailure` job is submitted.

```typescript
const { workflowId } = await engine.submitWorkflow({
  name: 'order-processing',
  steps: [
    { name: 'validate', type: 'validate-order', payload: { orderId: '123' } },
    {
      name: 'charge',
      type: 'charge-payment',
      payload: { orderId: '123' },
      dependsOn: ['validate'],
    },
    {
      name: 'confirm',
      type: 'send-email',
      payload: { to: 'user@example.com', subject: 'Order confirmed' },
      dependsOn: ['charge'],
    },
  ],
  onFailure: { type: 'notify-ops', payload: { orderId: '123' } },
});
```

### Submit a parallel fan-out / fan-in workflow

Steps in the same `parallelGroup` are submitted simultaneously. A step whose `dependsOn` lists all members of a parallel group will only start once every one of them has completed — this is the fan-in.

```typescript
await engine.submitWorkflow({
  name: 'parallel-report',
  steps: [
    { name: 'fetch-users',    type: 'query-db', payload: { table: 'users' },    parallelGroup: 'fetch' },
    { name: 'fetch-orders',   type: 'query-db', payload: { table: 'orders' },   parallelGroup: 'fetch' },
    { name: 'fetch-products', type: 'query-db', payload: { table: 'products' }, parallelGroup: 'fetch' },
    {
      name: 'generate-report',
      type: 'build-report',
      payload: { format: 'pdf' },
      dependsOn: ['fetch-users', 'fetch-orders', 'fetch-products'],
    },
  ],
});
```

### Create a cron schedule

```typescript
await engine.createSchedule({
  name: 'nightly-cleanup',
  type: 'cron',
  cronExpr: '0 2 * * *',   // every day at 02:00
  jobType: 'cleanup-expired-sessions',
  payload: { olderThanDays: 30 },
});
```

### Create a one-shot schedule

```typescript
await engine.createSchedule({
  name: 'trial-expiry-reminder',
  type: 'one_shot',
  runAt: '2024-12-01T09:00:00Z',
  jobType: 'send-email',
  payload: { to: 'user@example.com', subject: 'Your trial expires tomorrow' },
});
```

### Register a worker handler

```typescript
import { Worker } from '@node-forge-engine/sdk';

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

---

## API Reference

All authenticated requests require: `Authorization: Bearer {apiKey}`

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/jobs` | Submit a background job |
| `GET` | `/jobs` | List jobs (filter by status, type, limit) |
| `GET` | `/jobs/:id` | Get job detail — status, progress, logs, result, error |
| `POST` | `/workflows` | Submit a workflow definition |
| `GET` | `/workflows` | List workflows |
| `GET` | `/workflows/:id` | Get workflow + all step statuses and results |
| `POST` | `/workflows/:id/resume` | Resume a failed workflow from the last failed step |
| `GET` | `/dlq` | List dead letter queue entries (most recent first) |
| `POST` | `/dlq/:id/replay` | Replay a DLQ entry as a fresh job (attempt reset to 0) |
| `DELETE` | `/dlq/:id` | Delete a DLQ entry permanently |
| `GET` | `/schedules` | List all schedules |
| `POST` | `/schedules` | Create a cron or one-shot schedule |
| `PATCH` | `/schedules/:id` | Update cron expression, payload, or active status |
| `DELETE` | `/schedules/:id` | Delete a schedule |
| `GET` | `/workers` | List workers with heartbeat timestamps and supported job types |
| `GET` | `/events` | SSE stream of live job and workflow events |
| `GET` | `/health` | Health check |

---

## Tech Stack

| Component | Technology | Why |
|-----------|------------|-----|
| Language | TypeScript 5 / Node.js 20 | Single language across all services |
| API Framework | Fastify | Lower overhead than Express; built-in JSON schema validation |
| Message Bus | Apache Kafka (KafkaJS) | Consumer groups for load balancing; event retention for replay; multiple services consume the same events independently |
| Distributed Locks | Redis + Redlock | Fast cross-process mutex; handles horizontal scale correctly; lock expiry prevents deadlocks on worker crash |
| Job State Cache | Redis (ioredis) | Sub-millisecond reads for progress and logs without hitting Postgres on every poll |
| Pub/Sub (SSE) | Redis pub/sub | Push job events to dashboard SSE clients instantly when state changes |
| Database | PostgreSQL (Prisma) | ACID guarantees; durable source of truth; relational step dependency resolution |
| Dashboard | React + Vite | SPA with SSE-driven live updates; no server-side rendering needed |
| Monorepo | Turborepo | Parallel builds; shared packages compiled once and reused across all services |
| Local Dev | Docker Compose | One command to run entire stack including all infrastructure |
| Production | Kubernetes + Helm | Independent scaling per service; HPA for workers based on Kafka consumer lag |

---

## Project Structure

```
node-forge-engine/
├── apps/
│   ├── api/                  # Fastify REST API (15 routes + SSE + Kafka consumers)
│   ├── orchestrator/         # Workflow state machine (Kafka consumers, step resolver)
│   ├── worker/               # Job execution engine (Kafka consumer group + Redlock)
│   ├── scheduler/            # Cron poll loop with distributed lock
│   └── dashboard/            # React + Vite SPA (SSE-driven, 7 views)
├── packages/
│   ├── types/                # Shared TypeScript types + Kafka event payload interfaces
│   ├── kafka/                # KafkaJS client, topic constants, typed producer helper
│   ├── redis/                # ioredis client, Redlock factory, Redis key builders, TTL constants
│   ├── prisma/               # Prisma schema (8 models), seed script, audit log helper
│   └── sdk/                  # Public SDK — JobEngine (HTTP client) and Worker (Kafka consumer)
├── infra/
│   ├── docker-compose.yml    # Full stack (infra + all 5 application services)
│   ├── dockerfiles/          # Multi-stage Dockerfiles per service
│   ├── nginx.conf            # Nginx config for the dashboard container
│   └── helm/                 # Kubernetes Helm chart with HPA for workers
├── jest.config.base.js       # Shared Jest configuration
├── turbo.json                # Turborepo task pipeline
└── tsconfig.base.json        # Shared TypeScript compiler options
```

---

## FAQ

**Q: How is this different from BullMQ?**
BullMQ handles isolated jobs with no concept of chaining, fan-out/fan-in, or workflow-level observability. Forge Engine adds workflow orchestration, distributed locking across service boundaries, a Kafka-backed event bus for independent consumer groups, and a live dashboard — all on top of durable PostgreSQL storage rather than Redis-only state.

**Q: How is this different from Temporal?**
Temporal is powerful but operationally heavy — it requires a dedicated cluster, uses its own storage engine, and has a steep learning curve around workflow versioning and determinism constraints. Forge Engine runs on infrastructure you already know (Postgres, Redis, Kafka), is self-hostable with a single `docker compose up`, and can be adopted in an afternoon.

**Q: What happens if a worker crashes mid-job?**
The Kafka consumer group rebalances. The job message is re-delivered to another worker instance. The Redlock TTL (30s) ensures the crashed worker's lock expires, so the new worker can acquire it and execute the job without duplicate execution.

**Q: What happens if Kafka goes down?**
Because Forge Engine writes to Postgres before producing to Kafka, the job record already exists in the database. On Kafka recovery, unprocessed jobs can be requeued from Postgres. The database is always the source of truth.

**Q: What happens if the orchestrator crashes mid-workflow?**
All workflow step state is persisted in Postgres after every transition. On restart, the orchestrator resumes from the current database state. In-flight Kafka messages are re-delivered by the consumer group and processed idempotently.

**Q: Can I run multiple worker instances?**
Yes. Kafka consumer groups automatically distribute `job.submitted` messages across all worker replicas. Redlock provides a second layer of safety — only one worker can execute a given job at a time even if multiple workers receive the same message.

**Q: How do I add a new job type?**
Register a handler in `apps/worker/src/handlers/` and add it to the handlers Map in `apps/worker/src/index.ts`. Using the SDK: `worker.register('my-type', async (ctx) => { ... })`. No schema changes required.

**Q: Can I host this on Kubernetes?**
Yes. The `infra/helm/` chart deploys all services with a HorizontalPodAutoscaler for the worker Deployment. Redis and Postgres should be managed cloud services (e.g. AWS ElastiCache, RDS) in production.

**Q: What is the maximum job payload size?**
1 MB. For larger data (files, images, large datasets), store the content in object storage and pass a reference URL or key in the payload.

**Q: Is there a Python or Go SDK?**
No. This project is intentionally Node.js/TypeScript only. The REST API is language-agnostic — any HTTP client can submit jobs and poll status.

---

## Contributing

1. Fork the repo
2. Create a feature branch: `git checkout -b feat/your-feature`
3. Follow the commit convention: `feat(scope): description`
4. Submit a Pull Request

Please read the `docs/` folder before contributing — especially `docs/00_overview_and_architecture.md` for the architectural rules that must never be violated.

---

## License

MIT — see [LICENSE](LICENSE)
