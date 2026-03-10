# Forge Engine — Complete Beginner's Guide

This guide walks you through **everything**: running the project, understanding how it works, testing it, and navigating the dashboard. Assume you know nothing — we'll explain everything step by step.

---

## Table of Contents

1. [What is Forge Engine?](#1-what-is-forge-engine)
2. [Prerequisites](#2-prerequisites)
3. [Running the Project From Scratch](#3-running-the-project-from-scratch)
4. [Understanding the Codebase](#4-understanding-the-codebase)
5. [Testing the API with curl](#5-testing-the-api-with-curl)
6. [Navigating the Dashboard](#6-navigating-the-dashboard)
7. [Understanding the Kafka Message Flow](#7-understanding-the-kafka-message-flow)
8. [Running the Tests](#8-running-the-tests)
9. [Common Issues and Fixes](#9-common-issues-and-fixes)
10. [Adding Your Own Job Type](#10-adding-your-own-job-type)

---

## 1. What is Forge Engine?

Forge Engine lets you **run background tasks** (called "jobs") in your application without blocking your main server.

**Real-world example**: When a user signs up, instead of sending the welcome email during the HTTP request (which is slow), you submit a background job: `{ type: "send-email", payload: { to: "user@example.com" } }`. Forge Engine picks it up, runs it, retries if it fails, and you can watch it happen live in the dashboard.

**Key concepts you need to know:**

| Term | What it means |
|------|--------------|
| **Job** | A single unit of background work (e.g., send an email) |
| **Worker** | A process that picks up jobs and executes them |
| **Workflow** | A chain of jobs where step B runs after step A completes |
| **Kafka** | The message bus — jobs are delivered to workers through it |
| **Redis** | Used for distributed locks, job progress, and real-time updates |
| **PostgreSQL** | The database that stores all job records permanently |
| **API Service** | The REST API you talk to when submitting jobs |
| **Orchestrator** | Manages workflow step sequencing automatically |
| **Scheduler** | Runs jobs on a cron schedule (like a cron job) |
| **Dashboard** | A web UI to see all jobs, workflows, schedules, and workers live |

---

## 2. Prerequisites

You need these installed on your machine:

### Docker Desktop
Download from https://www.docker.com/products/docker-desktop/

Verify it's working:
```bash
docker --version
# Should print: Docker version 24.x.x or higher

docker compose version
# Should print: Docker Compose version v2.x.x
```

### Node.js 20+
Download from https://nodejs.org/ (choose the LTS version)

Verify:
```bash
node --version
# Should print: v20.x.x or higher

npm --version
# Should print: 10.x.x or higher
```

### curl (for testing the API)
- **Mac**: Already installed — run `curl --version` to check
- **Windows**: Install via https://curl.se/windows/ or use Git Bash
- **Linux**: `sudo apt install curl`

---

## 3. Running the Project From Scratch

### Step 1 — Clone and install dependencies

```bash
# Clone the repository
git clone https://github.com/YOUR_USERNAME/forge-engine.git
cd forge-engine

# Install all Node.js dependencies for every package in the monorepo
npm install
```

This installs dependencies for all 5 services + 5 shared packages at once (it's a monorepo).

### Step 2 — Set up environment variables

```bash
# Copy the example env file
cp .env.example .env
```

The default `.env` file works for local development out of the box. You don't need to change anything.

Open `.env` to see what's there:
```dotenv
DATABASE_URL=postgresql://forge:forge@localhost:5432/forge_engine
KAFKA_BROKERS=localhost:9092
KAFKA_CLIENT_ID=forge-engine
REDIS_HOST=localhost
REDIS_PORT=6379
API_PORT=3000
API_KEY_SEED=forge-dev-seed
LOG_LEVEL=info
NODE_ENV=development
```

### Step 3 — Start the entire stack with Docker

This one command starts **everything**: Postgres, Redis, Kafka, Zookeeper, the API, Orchestrator, Worker, Scheduler, Dashboard, and Kafka UI.

```bash
docker compose -f infra/docker-compose.yml up -d
```

**What `-d` means**: runs everything in the background (detached mode). Without it, all logs would flood your terminal.

Wait about 30–60 seconds for everything to start. You can check status:

```bash
docker compose -f infra/docker-compose.yml ps
```

You should see all services with status `running` or `Up`. The `migrate` service will show `Exited (0)` — that's correct, it runs once to set up the database and then exits.

### Step 4 — Verify everything is up

Check the API health endpoint:
```bash
curl http://localhost:3000/health
# Expected response:
# {"status":"ok","timestamp":"2024-..."}
```

Open these in your browser:
- **Dashboard**: http://localhost:5173
- **API**: http://localhost:3000
- **Kafka UI**: http://localhost:8080

### Step 5 — View logs (optional)

To watch what's happening in real time:
```bash
# All services
docker compose -f infra/docker-compose.yml logs -f

# Just the API
docker compose -f infra/docker-compose.yml logs -f api

# API + Worker together
docker compose -f infra/docker-compose.yml logs -f api worker orchestrator
```

Press `Ctrl+C` to stop watching logs (services keep running).

### Step 6 — Stop everything

```bash
# Stop all services (keeps data)
docker compose -f infra/docker-compose.yml down

# Stop AND delete all data (fresh start)
docker compose -f infra/docker-compose.yml down -v
```

---

## 4. Understanding the Codebase

### Folder Map

```
forge-engine/
├── apps/
│   ├── api/              ← The REST API server (port 3000)
│   ├── orchestrator/     ← Manages workflow step ordering
│   ├── worker/           ← Executes jobs (this is where YOUR handlers go)
│   ├── scheduler/        ← Runs cron jobs automatically
│   └── dashboard/        ← React web UI (port 5173)
│
├── packages/
│   ├── types/            ← Shared TypeScript types (Kafka event shapes)
│   ├── kafka/            ← KafkaJS client setup, topic names
│   ├── redis/            ← Redis client, locking, key naming
│   ├── prisma/           ← Database schema and migrations
│   └── sdk/              ← What your app uses to submit jobs
│
└── infra/
    ├── docker-compose.yml   ← Starts everything
    ├── dockerfiles/         ← How each service is built
    └── helm/                ← Kubernetes deployment (for production)
```

### The Flow of a Single Job (Step by Step)

When you submit a job, here's what happens internally:

```
1. YOUR CODE calls POST /jobs
       ↓
2. API writes the job to PostgreSQL (so it's never lost)
       ↓
3. API publishes a message to Kafka topic "job.submitted"
       ↓
4. WORKER consumes the Kafka message
       ↓
5. WORKER acquires a Redis lock (prevents two workers running the same job)
       ↓
6. WORKER runs your handler function (e.g., sends the email)
       ↓
7. WORKER publishes "job.completed" to Kafka
       ↓
8. ORCHESTRATOR consumes "job.completed" → updates PostgreSQL
9. API consumes "job.completed" → pushes update to Dashboard via SSE
```

### Key Files to Read

Start with these files in order to understand the codebase:

| File | What it teaches you |
|------|---------------------|
| `packages/types/src/events.ts` | All Kafka event shapes (what data flows between services) |
| `packages/kafka/src/index.ts` | How Kafka producer/consumer are configured |
| `packages/redis/src/index.ts` | How Redis locking (Redlock) works |
| `apps/api/src/server.ts` | How the Fastify server is built |
| `apps/api/src/routes/jobs.ts` | The POST /jobs and GET /jobs/:id routes |
| `apps/worker/src/consumer.ts` | How the worker picks up and executes jobs |
| `apps/worker/src/context.ts` | The `ctx` object your handler receives |
| `apps/orchestrator/src/consumers/job-completed.ts` | How workflows advance step by step |
| `apps/worker/src/handlers/` | Example job handlers (send-email, generate-report) |

---

## 5. Testing the API with curl

The default API key for development is: **`forge-dev-api-key-12345`**

All API requests need this header: `Authorization: Bearer forge-dev-api-key-12345`

### Health Check (no auth required)

```bash
curl http://localhost:3000/health
```

Expected:
```json
{"status":"ok","timestamp":"2024-01-15T10:00:00.000Z"}
```

---

### Submit a Job

```bash
curl -X POST http://localhost:3000/jobs \
  -H "Authorization: Bearer forge-dev-api-key-12345" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "send-email",
    "payload": {
      "to": "user@example.com",
      "subject": "Hello from Forge!",
      "body": "This is a test email."
    }
  }'
```

Expected response:
```json
{"jobId": "clx1abc123def456"}
```

Save that `jobId` — you'll use it in the next request.

---

### Check Job Status

Replace `JOB_ID` with the ID from the previous response:

```bash
curl http://localhost:3000/jobs/JOB_ID \
  -H "Authorization: Bearer forge-dev-api-key-12345"
```

Expected response:
```json
{
  "id": "clx1abc123def456",
  "type": "send-email",
  "status": "completed",
  "progress": 100,
  "attempts": 1,
  "maxAttempts": 3,
  "result": {"sent": true},
  "error": null,
  "logs": [
    "[2024-01-15T10:00:01.000Z] Sending email to user@example.com",
    "[2024-01-15T10:00:01.500Z] Email sent successfully"
  ],
  "createdAt": "2024-01-15T10:00:00.000Z",
  "startedAt": "2024-01-15T10:00:00.500Z",
  "completedAt": "2024-01-15T10:00:02.000Z"
}
```

---

### Submit a Job with Retries and Backoff

```bash
curl -X POST http://localhost:3000/jobs \
  -H "Authorization: Bearer forge-dev-api-key-12345" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "generate-report",
    "payload": {"reportType": "monthly", "userId": "user-123"},
    "retries": 5,
    "backoff": "exponential",
    "priority": "high"
  }'
```

`backoff` options: `"fixed"` | `"linear"` | `"exponential"`
`priority` options: `"low"` | `"normal"` | `"high"` | `"critical"`

---

### Submit a Job with a Delay

The job won't start executing until 30 seconds after submission:

```bash
curl -X POST http://localhost:3000/jobs \
  -H "Authorization: Bearer forge-dev-api-key-12345" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "send-email",
    "payload": {"to": "delayed@example.com", "subject": "Delayed email"},
    "delay": 30000
  }'
```

---

### Submit a Job with Idempotency Key

Safe to submit twice — second request returns the same job without creating a duplicate:

```bash
# First submission
curl -X POST http://localhost:3000/jobs \
  -H "Authorization: Bearer forge-dev-api-key-12345" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "send-email",
    "payload": {"to": "safe@example.com"},
    "idempotencyKey": "my-unique-key-abc123"
  }'

# Second submission (same idempotencyKey) — returns the first job, no duplicate
curl -X POST http://localhost:3000/jobs \
  -H "Authorization: Bearer forge-dev-api-key-12345" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "send-email",
    "payload": {"to": "safe@example.com"},
    "idempotencyKey": "my-unique-key-abc123"
  }'
```

---

### Submit a Sequential Workflow

Steps run in order: `validate` → `charge` → `confirm`:

```bash
curl -X POST http://localhost:3000/workflows \
  -H "Authorization: Bearer forge-dev-api-key-12345" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "order-processing",
    "steps": [
      {
        "name": "validate-order",
        "type": "validate-order",
        "payload": {"orderId": "ORD-001"}
      },
      {
        "name": "charge-payment",
        "type": "send-email",
        "payload": {"to": "payment@example.com", "subject": "Payment charged"},
        "dependsOn": ["validate-order"]
      },
      {
        "name": "send-confirmation",
        "type": "send-email",
        "payload": {"to": "user@example.com", "subject": "Order confirmed"},
        "dependsOn": ["charge-payment"]
      }
    ],
    "onFailure": {
      "type": "send-email",
      "payload": {"to": "ops@example.com", "subject": "Order failed!"}
    }
  }'
```

Expected response:
```json
{"workflowId": "clx2xyz789"}
```

---

### Submit a Parallel Workflow (Fan-out → Fan-in)

`fetch-users`, `fetch-orders`, and `fetch-products` run simultaneously. `generate-report` only starts after all three complete:

```bash
curl -X POST http://localhost:3000/workflows \
  -H "Authorization: Bearer forge-dev-api-key-12345" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "parallel-report",
    "steps": [
      {
        "name": "fetch-users",
        "type": "send-email",
        "payload": {"to": "data@example.com", "subject": "Fetching users"},
        "parallelGroup": "data-fetch"
      },
      {
        "name": "fetch-orders",
        "type": "send-email",
        "payload": {"to": "data@example.com", "subject": "Fetching orders"},
        "parallelGroup": "data-fetch"
      },
      {
        "name": "generate-report",
        "type": "generate-report",
        "payload": {"reportType": "combined"},
        "dependsOn": ["fetch-users", "fetch-orders"]
      }
    ]
  }'
```

---

### Check Workflow Status

```bash
curl http://localhost:3000/workflows/WORKFLOW_ID \
  -H "Authorization: Bearer forge-dev-api-key-12345"
```

Expected:
```json
{
  "id": "clx2xyz789",
  "name": "order-processing",
  "status": "running",
  "steps": [
    {"id": "step1", "name": "validate-order", "status": "completed", "dependsOn": []},
    {"id": "step2", "name": "charge-payment", "status": "running", "dependsOn": ["validate-order"]},
    {"id": "step3", "name": "send-confirmation", "status": "pending", "dependsOn": ["charge-payment"]}
  ],
  "createdAt": "2024-01-15T10:00:00.000Z",
  "completedAt": null
}
```

---

### Resume a Failed Workflow

If a workflow fails partway through, resume it (skips already-completed steps):

```bash
curl -X POST http://localhost:3000/workflows/WORKFLOW_ID/resume \
  -H "Authorization: Bearer forge-dev-api-key-12345"
```

---

### Create a Cron Schedule

Run a job every day at 9am:

```bash
curl -X POST http://localhost:3000/schedules \
  -H "Authorization: Bearer forge-dev-api-key-12345" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "daily-report",
    "type": "cron",
    "cronExpr": "0 9 * * *",
    "jobType": "generate-report",
    "payload": {"reportType": "daily"}
  }'
```

**Cron expression guide:**
- `0 9 * * *` — every day at 9:00 AM
- `*/5 * * * *` — every 5 minutes
- `0 0 * * 1` — every Monday at midnight
- `0 12 1 * *` — first of every month at noon

---

### List All Schedules

```bash
curl http://localhost:3000/schedules \
  -H "Authorization: Bearer forge-dev-api-key-12345"
```

---

### Pause / Resume a Schedule

```bash
# Pause
curl -X PATCH http://localhost:3000/schedules/SCHEDULE_ID \
  -H "Authorization: Bearer forge-dev-api-key-12345" \
  -H "Content-Type: application/json" \
  -d '{"active": false}'

# Resume
curl -X PATCH http://localhost:3000/schedules/SCHEDULE_ID \
  -H "Authorization: Bearer forge-dev-api-key-12345" \
  -H "Content-Type: application/json" \
  -d '{"active": true}'
```

---

### Delete a Schedule

```bash
curl -X DELETE http://localhost:3000/schedules/SCHEDULE_ID \
  -H "Authorization: Bearer forge-dev-api-key-12345"
```

---

### View the Dead Letter Queue (DLQ)

Jobs that fail all retry attempts end up here:

```bash
curl http://localhost:3000/dlq \
  -H "Authorization: Bearer forge-dev-api-key-12345"
```

---

### Replay a DLQ Job

Re-submit a failed job to try it again:

```bash
curl -X POST http://localhost:3000/dlq/DLQ_ENTRY_ID/replay \
  -H "Authorization: Bearer forge-dev-api-key-12345"
```

---

### List Active Workers

```bash
curl http://localhost:3000/workers \
  -H "Authorization: Bearer forge-dev-api-key-12345"
```

Expected:
```json
[
  {
    "id": "worker-1abc",
    "status": "ACTIVE",
    "jobTypes": ["send-email", "generate-report"],
    "lastHeartbeat": "2024-01-15T10:00:55.000Z",
    "registeredAt": "2024-01-15T09:00:00.000Z",
    "isAlive": true
  }
]
```

---

### Test Error Handling (Submit an Invalid Request)

```bash
# No Authorization header → 401
curl -X POST http://localhost:3000/jobs \
  -H "Content-Type: application/json" \
  -d '{"type":"send-email","payload":{}}'

# Wrong API key → 401
curl -X POST http://localhost:3000/jobs \
  -H "Authorization: Bearer wrong-key" \
  -H "Content-Type: application/json" \
  -d '{"type":"send-email","payload":{}}'

# Missing required fields → 400
curl -X POST http://localhost:3000/jobs \
  -H "Authorization: Bearer forge-dev-api-key-12345" \
  -H "Content-Type: application/json" \
  -d '{"payload":{}}'
```

---

## 6. Navigating the Dashboard

Open **http://localhost:5173** in your browser.

The dashboard has a **dark sidebar on the left** with 5 sections. Here's what each does:

---

### Jobs (http://localhost:5173/jobs)

This is the main view. You'll see a table of all jobs with:

| Column | What it means |
|--------|--------------|
| **ID** | Shortened job ID — click it to see full details |
| **Type** | The job type you submitted (e.g., `send-email`) |
| **Status** | Current state — see the color codes below |
| **Progress** | 0–100% bar — your handler calls `ctx.progress(n)` to update this |
| **Attempts** | How many times it has tried / max allowed |
| **Created** | When the job was submitted |

**Status color guide:**
- ⬜ `pending` — waiting for a worker to pick it up
- 🔵 `running` — a worker is executing it right now
- 🟢 `completed` — finished successfully
- 🔴 `failed` — failed this attempt (may retry)
- 🟡 `retrying` — waiting before next attempt
- ⬛ `dead` — exhausted all retries, moved to DLQ

**The table updates in real-time via SSE** — you don't need to refresh.

To test: Submit a job via curl (from section 5), then watch it appear and update live.

---

### Job Detail (click any job ID)

Shows everything about a single job:
- **Status badge** — current state
- **Metadata grid** — type, attempts, timestamps
- **Progress bar** — live 0–100%
- **Result** — what your handler returned (shown as JSON)
- **Error** — if it failed, the error message
- **Logs** — every `ctx.log(message)` your handler wrote, with timestamps

This view **polls every 3 seconds** for the latest data.

---

### Workflows (http://localhost:5173/workflows)

Lists all workflows. Click a workflow ID to see the detail view.

---

### Workflow Detail (click any workflow ID)

The most interesting view. Shows:

**Step Graph** — Visual boxes for each step, color-coded by status:
- Grey border — pending
- Blue border — running
- Green border — completed
- Red border — failed

If a step is in a `parallelGroup`, you'll see "Group: group-name" inside the box.

**Steps Table** — Shows each step with its name, job type, status, dependencies, and when it ran.

**Resume Button** — Appears when the workflow has status `failed`. Click to retry from the failed step.

This view **refreshes every 5 seconds** automatically.

---

### Schedules (http://localhost:5173/schedules)

Lists all cron and one-shot schedules. For each:
- **Name** — human-readable label
- **Type** — `cron` or `one-shot`
- **Cron** — the cron expression (e.g., `0 9 * * *`)
- **Job Type** — which job type gets submitted when it fires
- **Active** — green `active` or grey `pending` (paused)
- **Next Run** — when it will fire next

**Actions:**
- `Pause` / `Resume` button — toggles `active` status
- `Delete` button — permanently removes the schedule

---

### Dead Letter Queue (http://localhost:5173/dlq)

Shows jobs that failed all retry attempts. For each entry:
- **Job ID** — the original job's ID
- **Job Type** — the type of job that failed
- **Errors** — how many error records are stored
- **Moved At** — when it was moved to the DLQ
- **Replayed** — whether it's been replayed and when

**Actions:**
- `Replay` — re-submits the job (creates a fresh attempt)
- `Delete` — permanently removes it from the DLQ

To generate a DLQ entry for testing, submit a job with an unknown type — it will fail all retries:
```bash
curl -X POST http://localhost:3000/jobs \
  -H "Authorization: Bearer forge-dev-api-key-12345" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "nonexistent-job-type",
    "payload": {},
    "retries": 1
  }'
```
Wait ~30 seconds, then check the DLQ view.

---

### Workers (http://localhost:5173/workers)

Shows all registered worker instances. For each:
- **ID** — unique worker identifier (includes hostname and PID)
- **Job Types** — which job types this worker can handle
- **Status** — `ACTIVE` (alive) or `DEAD` (no heartbeat for 30s)
- **Alive** — Yes/No based on heartbeat freshness
- **Last Heartbeat** — when the worker last checked in
- **Registered** — when this worker instance started

This view **polls every 10 seconds**.

---

### Kafka UI (http://localhost:8080)

Not part of the dashboard but extremely useful for debugging. Here you can:
- See all Kafka topics (job.submitted, job.completed, job.failed, etc.)
- Browse individual messages to see the exact data flowing between services
- Check consumer group lag (how far behind each service is)

Click **"forge"** cluster → **Topics** to see the message flow.

---

## 7. Understanding the Kafka Message Flow

Every action in Forge Engine produces a Kafka message. Here's the complete picture:

```
Topic: job.submitted
  → Who produces: API Service (when you POST /jobs)
  → Who consumes: Worker (to execute the job)

Topic: job.retry
  → Who produces: Orchestrator (when a job should retry with delay)
  → Who consumes: Worker (same as job.submitted)

Topic: job.started
  → Who produces: Worker (when it begins executing)
  → Who consumes: Orchestrator (for audit log), API (for SSE)

Topic: job.completed
  → Who produces: Worker (when handler returns successfully)
  → Who consumes: Orchestrator (updates DB, advances workflow), API (for SSE)

Topic: job.failed
  → Who produces: Worker (when handler throws an error)
  → Who consumes: Orchestrator (decides retry vs DLQ), API (for SSE)

Topic: workflow.created
  → Who produces: API Service (when you POST /workflows)
  → Who consumes: Orchestrator (submits the first workflow steps)
```

**Why Kafka instead of direct HTTP calls between services?**
- If the Orchestrator is temporarily down, messages wait in Kafka and are processed when it comes back
- Multiple workers can consume from `job.submitted` in parallel, auto-load-balancing
- Full message history is retained — useful for debugging and replay

---

## 8. Running the Tests

### Unit Tests Only (fast, no Docker needed)

```bash
# From the project root
npm test

# Or run just one service's tests
cd apps/orchestrator && npx jest
cd apps/api && npx jest
cd apps/worker && npx jest
```

### What each test file checks

| File | What it tests |
|------|--------------|
| `apps/orchestrator/src/__tests__/backoff.test.ts` | Backoff calculation (fixed/linear/exponential) |
| `apps/orchestrator/src/__tests__/step-resolver.test.ts` | Which workflow steps become ready after one completes |
| `apps/api/src/__tests__/auth.test.ts` | API key validation, 401 responses |
| `apps/api/src/__tests__/jobs.test.ts` | Job creation, idempotency key deduplication |
| `apps/worker/src/__tests__/consumer.test.ts` | JobContext progress clamping, log formatting |

### Integration Tests (requires Docker running)

```bash
# Start the stack first
docker compose -f infra/docker-compose.yml up -d

# Wait for it to be ready, then:
TEST_INTEGRATION=true npm test
```

The integration test submits a real job through a real worker and waits for completion.

### Coverage Report

```bash
npm run test:coverage
```

HTML coverage report will be in `coverage/` for each service.

---

## 9. Common Issues and Fixes

### "Connection refused" on port 3000

The API container might still be starting. Wait 30 seconds and retry. Check status:
```bash
docker compose -f infra/docker-compose.yml ps
docker compose -f infra/docker-compose.yml logs api
```

### Jobs stuck in "pending" forever

The worker might not be running. Check:
```bash
docker compose -f infra/docker-compose.yml logs worker
```

If you see Kafka connection errors, Kafka might need more time. Wait 60 seconds after startup.

### "Network not found" error when starting Docker

```bash
docker network prune
docker compose -f infra/docker-compose.yml up -d
```

### Kafka UI shows no topics

Topics are created automatically when the first message is produced. Submit one job via curl and Kafka topics will appear.

### Dashboard shows blank / "Loading jobs..."

Check that the API is running and accessible:
```bash
curl http://localhost:3000/health
```

If the API is down, the dashboard can't load data.

### Fresh start (wipe all data)

```bash
docker compose -f infra/docker-compose.yml down -v
docker compose -f infra/docker-compose.yml up -d
```

The `-v` flag removes all volumes (database, Redis, Kafka data).

### Port conflicts

If you already have Postgres/Redis/Kafka running locally, ports will conflict. Check:
```bash
lsof -i :5432   # Postgres
lsof -i :6379   # Redis
lsof -i :9092   # Kafka
lsof -i :3000   # API
lsof -i :5173   # Dashboard
```

Kill conflicting processes or stop local services before running Docker Compose.

---

## 10. Adding Your Own Job Type

This is how you extend Forge Engine with your own business logic.

### Step 1 — Create a handler file

Create `apps/worker/src/handlers/my-job.ts`:

```typescript
import type { JobHandlerFn } from '../context';

export const myJobHandler: JobHandlerFn = async (ctx) => {
  // ctx.jobId    — the job's unique ID
  // ctx.type     — "my-custom-job"
  // ctx.data     — the payload you submitted
  // ctx.attempt  — which attempt this is (starts at 1)

  await ctx.log(`Starting my job with data: ${JSON.stringify(ctx.data)}`);
  await ctx.progress(10);

  // --- YOUR BUSINESS LOGIC HERE ---
  const result = await doSomethingWith(ctx.data);
  // --------------------------------

  await ctx.progress(90);
  await ctx.log('Job complete!');
  await ctx.progress(100);

  // Whatever you return here becomes job.result
  return { success: true, output: result };
};

async function doSomethingWith(data: Record<string, unknown>) {
  // Replace with your actual logic
  return { processed: true, input: data };
}
```

### Step 2 — Register it in the worker

Open `apps/worker/src/index.ts` and add your handler:

```typescript
import { myJobHandler } from './handlers/my-job';

// Find the section where handlers are registered, add:
consumer.register('my-custom-job', myJobHandler);
```

### Step 3 — Rebuild and restart the worker

```bash
# If running with Docker
docker compose -f infra/docker-compose.yml up -d --build worker

# If running locally
npm run build --workspace=apps/worker
```

### Step 4 — Submit your job

```bash
curl -X POST http://localhost:3000/jobs \
  -H "Authorization: Bearer forge-dev-api-key-12345" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "my-custom-job",
    "payload": {"myData": "hello world"},
    "retries": 3,
    "backoff": "exponential"
  }'
```

### Step 5 — Watch it run

Open http://localhost:5173/jobs and watch your job appear, go `running`, then `completed`. Click the job ID to see its logs and result.

---

## Quick Reference

### Ports
| Service | URL |
|---------|-----|
| API | http://localhost:3000 |
| Dashboard | http://localhost:5173 |
| Kafka UI | http://localhost:8080 |
| PostgreSQL | localhost:5432 (user: forge, pass: forge, db: forge_engine) |
| Redis | localhost:6379 |
| Kafka | localhost:9092 |

### Default API Key
```
forge-dev-api-key-12345
```

### Essential Commands
```bash
# Start everything
docker compose -f infra/docker-compose.yml up -d

# Stop everything
docker compose -f infra/docker-compose.yml down

# Fresh start (wipe data)
docker compose -f infra/docker-compose.yml down -v && docker compose -f infra/docker-compose.yml up -d

# Watch all logs
docker compose -f infra/docker-compose.yml logs -f

# Scale workers to 5 instances
docker compose -f infra/docker-compose.yml up -d --scale worker=5

# Run tests
npm test
```
