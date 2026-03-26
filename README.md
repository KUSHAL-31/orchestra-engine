# Orchestra Engine

> A self-hostable, open-source **Distributed Job Scheduler & Workflow Engine** built in TypeScript.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20-green?logo=node.js)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker)](infra/docker-compose.yml)

Most teams end up duct-taping background jobs together with ad-hoc queues, scattered cron scripts, and zero visibility into what's running or failing. Orchestra Engine replaces all of that with a single, coherent system your entire team can reason about.

- **Background jobs that just work** — submit a job from anywhere via the typed Node.js SDK or REST API. Orchestra handles Kafka-backed queuing, distributed locking so the same job never runs twice, and automatic retries with configurable backoff. You write the handler function; it takes care of the rest.

- **Workflows without the coordination tax** — instead of building your own state machines or chaining promises across services, you declare steps with explicit `dependsOn` and `parallelGroup` relationships. Orchestra executes them in order, fans out parallel branches automatically, and fans back in before proceeding — so a pipeline like validate → charge → [notify warehouse + update inventory] → send receipt becomes a single JSON definition, not 300 lines of glue code.

- **Cron scheduling with history** — register recurring jobs with cron expressions and get a full audit trail of every trigger, execution result, and failure. No more silent cron jobs disappearing into the void.

- **Full observability out of the box** — a live dashboard shows every job, workflow, worker heartbeat, and dead-letter failure updating in real time over SSE. You can see progress mid-execution, inspect logs and error traces, replay failed jobs from the DLQ, and pause or delete schedules — all without touching a database or writing a query.

- **Your infrastructure, your rules** — Postgres for durability, Kafka for messaging, Redis for distributed locking, your own worker processes for execution. No vendor lock-in, no managed service to pay for, no data leaving your environment. Runs wherever containers run.

---

## Quick Start

**Prerequisites:** Docker + Docker Compose

### 1. Start the platform

```bash
git clone https://github.com/KUSHAL-31/orchestra-engine.git
cd orchestra-engine
docker compose -f infra/docker-compose.yml up -d postgres redis kafka zookeeper orchestrator api scheduler dashboard
```

| Service | URL |
|---------|-----|
| API | http://localhost:3000 |
| Dashboard | http://localhost:5173 |
| Kafka UI | http://localhost:8080 |

Verify:
```bash
curl http://localhost:3000/health
# {"status":"ok","service":"api"}
```

> The API key is seeded from `API_KEY_SEED` in your `.env` file. The default dev value is `orchestra-dev-api-key-12345`.

> **Note:** Do not include the `worker` service when running your own application. The Docker worker only exists to demo the platform with built-in handlers. In a real setup, your own application runs its own worker with your business logic — see [SDK Usage](#sdk-usage) below.

### 2. Run your own worker

Install the SDK in your app and register your own handlers:

```bash
npm install orchestra-engine
```

```typescript
import { Worker } from 'orchestra-engine';

const worker = new Worker();

worker
  .register('send-email', async (ctx) => {
    const { to, subject } = ctx.data as { to: string; subject: string };
    // your real email logic here
    return { sent: true };
  })
  .register('generate-report', async (ctx) => {
    // your real report logic here
    return { reportUrl: '...' };
  });

worker.start({
  kafkaBrokers: ['localhost:9092'],
  redisHost:    'localhost',
  redisPort:    6379,
  groupId:      'workers',  // must match the engine's consumer group
});
```

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

## SDK Usage

Install the SDK in your Node.js project:

```bash
npm install @orchestra-engine/sdk
```

### Submit a Job

```typescript
import { JobEngine } from '@orchestra-engine/sdk';

const engine = new JobEngine({
  apiUrl: process.env.API_BASE_URL,   // e.g. http://localhost:3000
  apiKey: process.env.API_KEY_SEED,   // set in your .env file
});

const { jobId } = await engine.submitJob({
  type: 'send-email',
  payload: { to: 'user@example.com', subject: 'Welcome!', body: 'Hello!' },
  retries: 3,
  backoff: 'exponential',  // 'fixed' | 'linear' | 'exponential'
  priority: 'high',         // 'low' | 'normal' | 'high' | 'critical'
  delay: 5000,              // wait 5s before first attempt
  idempotencyKey: 'welcome-email-user-42',  // safe to call multiple times
});
```

### Check Job Status

```typescript
const job = await engine.getJob(jobId);
console.log(job.status);    // 'completed'
console.log(job.progress);  // 100
console.log(job.logs);      // ['Sending email to user@example.com', 'Email sent.']
console.log(job.result);    // { sent: true }
```

### Register a Worker

Register handlers for each job type your service processes. Orchestra Engine handles Kafka consumption, distributed locking, retries, and progress streaming — you just write the function.

```typescript
import { Worker } from '@orchestra-engine/sdk';

const worker = new Worker();

worker
  .register('send-email', async (ctx) => {
    await ctx.log(`Sending email to ${ctx.data.to}`);
    await ctx.progress(50);
    // ... your email sending logic
    await ctx.progress(100);
    return { sent: true };
  })
  .register('charge-payment', async (ctx) => {
    await ctx.log(`Charging $${ctx.data.amount} for order ${ctx.data.orderId}`);
    // ... your payment logic
    return { charged: true };
  });

await worker.start({
  kafkaBrokers: ['localhost:9092'],
  redisHost: 'localhost',
  redisPort: 6379,
});
```

**`ctx` methods available inside any handler:**

| Method | Description |
|--------|-------------|
| `ctx.data` | The job payload |
| `ctx.jobId` | Current job ID |
| `ctx.attempt` | Current attempt number (0-indexed) |
| `await ctx.progress(n)` | Report progress 0–100, streamed live to the dashboard |
| `await ctx.log(msg)` | Append a structured log entry, visible in the dashboard |

### Sequential Workflow

Steps run in order. Each step starts only after all steps in `dependsOn` have completed.

```typescript
const { workflowId } = await engine.workflow('order-processing')
  .step({
    name:    'validate',
    type:    'validate-order',
    payload: { orderId: 'ORD-100' },
  })
  .step({
    name:      'charge',
    type:      'charge-payment',
    payload:   { orderId: 'ORD-100', amount: 89.99 },
    dependsOn: ['validate'],
  })
  .step({
    name:      'confirm',
    type:      'send-email',
    payload:   { to: 'user@example.com', subject: 'Order confirmed' },
    dependsOn: ['charge'],
  })
  .onFailure({
    type:    'send-email',
    payload: { to: 'ops@company.com', subject: 'Order pipeline failed' },
  })
  .submit();
```

```
validate → charge → confirm
           ↓ (if fails permanently)
        onFailure: send-email (ops alert)
```

### Parallel Fan-out / Fan-in

Steps with the same `parallelGroup` run simultaneously. A downstream step waits for all of them to complete before starting (fan-in).

```typescript
await engine.workflow('post-payment-parallel')
  .step({
    name:    'charge',
    type:    'charge-payment',
    payload: { orderId: 'ORD-200', amount: 199.99 },
  })
  .step({
    name:          'notify-warehouse',
    type:          'notify-warehouse',
    payload:       { orderId: 'ORD-200' },
    dependsOn:     ['charge'],
    parallelGroup: 'fulfillment',
  })
  .step({
    name:          'update-inventory',
    type:          'update-inventory',
    payload:       { orderId: 'ORD-200' },
    dependsOn:     ['charge'],
    parallelGroup: 'fulfillment',
  })
  .step({
    name:      'send-receipt',
    type:      'send-email',
    payload:   { to: 'user@example.com', subject: 'Your receipt' },
    dependsOn: ['notify-warehouse', 'update-inventory'],
  })
  .submit();
```

```
          charge
            │
  ┌─────────┴─────────┐
notify-warehouse  update-inventory
  [fulfillment]   [fulfillment]
  └─────────┬─────────┘
       send-receipt
```

### Cron Schedule

```typescript
await engine.createSchedule({
  name: 'nightly-cleanup',
  type: 'cron',
  cronExpr: '0 2 * * *',   // every day at 02:00
  jobType: 'cleanup-sessions',
  payload: { olderThanDays: 30 },
});
```

### One-Shot Schedule

```typescript
await engine.createSchedule({
  name: 'black-friday-campaign',
  type: 'one_shot',
  runAt: '2026-11-27T00:00:00Z',
  jobType: 'send-email',
  payload: { to: 'subscribers@company.com', subject: 'Black Friday is LIVE!' },
});
```

### Manage Schedules

```typescript
// List all schedules
const schedules = await engine.listSchedules();

// Pause a schedule
await engine.updateSchedule(scheduleId, { active: false });

// Reactivate
await engine.updateSchedule(scheduleId, { active: true });

// Delete
await engine.deleteSchedule(scheduleId);
```

---

## REST API

If you're not using the SDK, every feature is available over HTTP. Load your env vars once:

```bash
export ORCHESTRA_KEY=$(grep API_KEY_SEED .env | cut -d '=' -f2)
export ORCHESTRA_URL="http://localhost:3000"
```

### Submit a Job

```bash
curl -X POST $ORCHESTRA_URL/jobs \
  -H "Authorization: Bearer $ORCHESTRA_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "send-email",
    "payload": { "to": "user@example.com", "subject": "Hello" },
    "retries": 3,
    "backoff": "exponential",
    "priority": "high"
  }'
# {"jobId":"4029e1c0-..."}
```

### Submit a Workflow

```bash
curl -X POST $ORCHESTRA_URL/workflows \
  -H "Authorization: Bearer $ORCHESTRA_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "order-pipeline",
    "steps": [
      {
        "name": "validate",
        "type": "validate-order",
        "payload": { "orderId": "ORD-1" }
      },
      {
        "name": "charge",
        "type": "charge-payment",
        "payload": { "orderId": "ORD-1", "amount": 99 },
        "dependsOn": ["validate"]
      }
    ]
  }'
```

### Create a Cron Schedule

```bash
curl -X POST $ORCHESTRA_URL/schedules \
  -H "Authorization: Bearer $ORCHESTRA_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "daily-report",
    "type": "cron",
    "cronExpr": "0 8 * * *",
    "jobType": "generate-report",
    "payload": { "format": "pdf" }
  }'
```

### DLQ — Inspect, Replay and Delete

```bash
# List dead-lettered jobs
curl $ORCHESTRA_URL/dlq \
  -H "Authorization: Bearer $ORCHESTRA_KEY"

# Replay as a fresh attempt (attempt counter reset to 0)
curl -X POST $ORCHESTRA_URL/dlq/{id}/replay \
  -H "Authorization: Bearer $ORCHESTRA_KEY"

# Delete permanently
curl -X DELETE $ORCHESTRA_URL/dlq/{id} \
  -H "Authorization: Bearer $ORCHESTRA_KEY"
```

### Resume a Failed Workflow

```bash
curl -X POST $ORCHESTRA_URL/workflows/{workflowId}/resume \
  -H "Authorization: Bearer $ORCHESTRA_KEY"
```

Completed steps are not re-run. Only failed and pending steps are retried from where the workflow left off.

### Full API Reference

All endpoints require `Authorization: Bearer {apiKey}`.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Health check |
| `POST` | `/jobs` | Submit a background job |
| `GET` | `/jobs` | List jobs |
| `GET` | `/jobs/:id` | Get job — status, progress, logs, result |
| `POST` | `/workflows` | Submit a workflow |
| `GET` | `/workflows` | List workflows |
| `GET` | `/workflows/:id` | Get workflow + all step statuses |
| `POST` | `/workflows/:id/resume` | Resume a failed workflow |
| `GET` | `/dlq` | List dead letter queue |
| `POST` | `/dlq/:id/replay` | Replay a DLQ entry (attempt reset to 0) |
| `DELETE` | `/dlq/:id` | Delete a DLQ entry |
| `GET` | `/schedules` | List all schedules |
| `POST` | `/schedules` | Create a cron or one-shot schedule |
| `PATCH` | `/schedules/:id` | Update schedule (expression, payload, active state) |
| `DELETE` | `/schedules/:id` | Delete a schedule |
| `GET` | `/workers` | List workers with heartbeat and job types |
| `GET` | `/events` | SSE stream — live job and workflow events |

---

## Dashboard

React SPA at `http://localhost:5173`. Connects to the SSE stream on load — all views update in real time.

| View | Path | What it shows |
|------|------|---------------|
| **Jobs** | `/jobs` | Live list of all jobs with status, progress, and attempts. Click a row for full detail — logs, progress bar, result, and error. |
| **Workflows** | `/workflows` | All workflows with step count. Click for a live step dependency graph — nodes colour-shift as steps run. |
| **Schedules** | `/schedules` | All cron and one-shot schedules. Create, pause, reactivate, or delete from this view. |
| **Dead Letter Queue** | `/dlq` | Jobs that exhausted all retries. Expand for full error history. Replay or delete entries directly. |
| **Workers** | `/workers` | Registered worker instances with heartbeat status and which job types each one handles. |

### Screenshots

**Analytics — KPI Overview**

The Analytics view opens with a live-updating header row of key metrics: total jobs processed, success rate, average duration, active workers, jobs running now, and jobs waiting in queue. Below the KPIs, a time-series chart plots completed, created, and failed jobs over the selected window.

![Analytics KPI Overview](images/Screenshot%202026-03-22%20at%2018.51.14.png)

---

**Analytics — Performance Metrics & Workers**

Scrolling down on the Analytics view reveals latency percentiles (P50 / P75 / P99), throughput, error rate, retry rate, and the busiest hour of the day. The **Job Type Volume** bar chart ranks job types by activity. The **Workers** panel lists every registered worker instance, its heartbeat status (alive / offline), and the full set of job types it handles — two workers are shown here, each covering `send-email`, `generate-report`, `validate-order`, `charge-payment`, `update-inventory`, and `notify-warehouse`.

![Analytics Performance Metrics and Workers](images/Screenshot%202026-03-22%20at%2018.51.23.png)

---

**Workflows List**

The Workflows view shows all submitted workflows in a sortable table with their IDs, names, status badges, and created / completed timestamps. All three workflows shown — `full-order-processing`, `parallel-report`, and `order-processing` — completed successfully within a few seconds of submission.

![Workflows List](images/Screenshot%202026-03-22%20at%2018.51.33.png)

---

**Jobs List**

The Jobs view lists every job with its UUID, type, status badge, progress bar, attempt count, and creation timestamp. Filter tabs at the top let you narrow by lifecycle state: `PENDING`, `RUNNING`, `COMPLETED`, `FAILED`, `RETRYING`, `DEAD`, or `SKIPPED`. The screenshot shows a fully completed run across multiple job types — `send-email`, `generate-report`, `notify-warehouse`, `update-inventory`, and `charge-payment` — all at 100 % progress.

![Jobs List](images/Screenshot%202026-03-22%20at%2018.51.40.png)

---

**Workflow Detail — Step Graph**

Clicking a workflow opens its detail view. The **Step Graph** at the top renders the dependency chain as a visual pipeline — each node shows its step name and a `COMPLETED` badge once done. The `full-order-processing` workflow pictured runs six steps in order: `validate → charge → update-inventory → notify-warehouse → generate-invoice → send-confirmation`. The steps table below lists each step's ID, name, job type, the step it depends on, its parallel group (if any), and the exact execution timestamp.

![Workflow Detail Step Graph](images/Screenshot%202026-03-22%20at%2018.51.49.png)

---

## Features

- **Jobs** — retries with fixed/linear/exponential backoff, priority queues, delayed execution, idempotency keys
- **Workflows** — sequential (`dependsOn`), parallel fan-out (`parallelGroup`), fan-in, `onFailure` handler, resume without re-running completed steps
- **Scheduling** — cron + one-shot, distributed lock ensures exactly one fire per tick across replicas
- **DLQ** — automatic on retry exhaustion, full error history, one-call replay
- **Real-time** — SSE stream for all job/workflow events, live progress and log streaming
- **Security** — SHA-256 hashed API keys, 1000 req/min rate limiting per key via Redis sliding window
- **Scale** — Kafka consumer groups for horizontal worker scaling, Redlock for exactly-once execution, Kubernetes Helm chart included

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
orchestra-engine/
├── apps/
│   ├── api/            # Fastify REST API + SSE + Kafka consumers
│   ├── orchestrator/   # Workflow state machine and step resolver
│   ├── worker/         # Job execution engine with Redlock
│   ├── scheduler/      # Cron poll loop with distributed lock
│   └── dashboard/      # React + Vite SPA (5 views)
├── packages/
│   ├── sdk/            # Public SDK — JobEngine and Worker classes
│   ├── types/          # Shared TypeScript types and Kafka event interfaces
│   ├── kafka/          # KafkaJS client and typed producer
│   ├── redis/          # ioredis client, Redlock, key builders
│   └── prisma/         # Schema, migrations, audit log helper
└── infra/
    ├── docker-compose.yml   # Full stack in one command
    ├── dockerfiles/         # Multi-stage Dockerfiles per service
    └── helm/                # Kubernetes Helm chart with HPA for workers
```

---

## FAQ

**How do I add a new job type?**
Register a handler in `apps/worker/src/handlers/` and add it to the handlers Map in `apps/worker/src/index.ts`. With the SDK: `worker.register('my-type', async (ctx) => { ... })`. No schema changes needed.

**What happens if a worker crashes mid-job?**
The Kafka consumer group rebalances and the message is re-delivered to another worker. The Redlock TTL (30s) expires, so the new worker acquires the lock and executes the job without duplication.

**What happens if Kafka goes down?**
Orchestra Engine writes to Postgres before producing to Kafka. The job record already exists and can be requeued on Kafka recovery. Postgres is always the source of truth.

**Can I run multiple worker instances?**
Yes. Kafka consumer groups distribute jobs across replicas automatically. Redlock ensures only one worker executes a given job at a time.

**Is there a Python or Go SDK?**
No — intentionally Node.js/TypeScript only. The REST API is language-agnostic so any HTTP client works.

**Can I host this on Kubernetes?**
Yes. The `infra/helm/` chart deploys all services with a HorizontalPodAutoscaler for workers. Use managed Redis and Postgres (e.g. AWS ElastiCache + RDS) in production.

---

## Contributing

1. Fork the repo and create a branch: `git checkout -b feat/your-feature`
2. Follow commit convention: `feat(scope): description`
3. Submit a Pull Request

---

## License

MIT
