# orchestra-engine

Node.js SDK for [Orchestra Engine](https://github.com/KUSHAL-31/orchestra-engine) — a self-hosted background job engine built on Kafka, Redis, and PostgreSQL, with a real-time dashboard.

Install this SDK in your existing backend to:

- Submit background jobs and multi-step workflows from any Node.js service
- Run your own worker process that consumes and executes those jobs
- Create cron and one-shot schedules that fire jobs automatically

---

## Table of Contents

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Installation](#installation)
- [JobEngine — Submit jobs from your backend](#jobengine--submit-jobs-from-your-backend)
  - [Constructor](#constructor)
  - [Submit a job](#submit-a-job)
  - [Submit with idempotency key](#submit-with-an-idempotency-key)
  - [Submit with priority and delay](#submit-with-priority-and-delay)
  - [Check job status](#check-job-status)
  - [Submit a workflow](#submit-a-workflow)
  - [Get workflow status](#get-workflow-status)
  - [Resume a failed workflow](#resume-a-failed-workflow)
  - [Schedules](#schedules)
- [Worker — Execute jobs in your own process](#worker--execute-jobs-in-your-own-process)
  - [Handler context](#handler-context-ctx)
  - [Graceful shutdown](#graceful-shutdown)
- [Error handling](#error-handling)
- [TypeScript](#typescript)
- [Reference tables](#reference-tables)
  - [SubmitJobOptions](#submitjoboptions)
  - [WorkerOptions](#workeroptions)
  - [ScheduleOptions](#createscheduleoptions)
  - [JobStatus](#jobstatus-response)
  - [WorkflowStatus](#workflowstatus-response)
- [Infrastructure setup](#infrastructure-setup)
- [License](#license)

---

## How it works

```
Your backend                   Orchestra Engine
────────────────                ──────────────────────────────────────
JobEngine.submitJob()  ──HTTP──▶  API  ──Kafka──▶  Orchestrator
                                                         │
                                                    Redis (state)
                                                         │
Worker.start()  ◀──Kafka──────────────────────────────────
     │
  your handlers run here
```

- **`JobEngine`** is a lightweight HTTP client. It sends jobs and workflows to the Orchestra Engine REST API. It does **not** need direct access to Kafka or Redis — only the API URL.
- **`Worker`** is a long-running process that connects directly to Kafka and Redis. It consumes jobs, runs your registered handler functions, and reports progress/logs back to the engine.
- **Orchestrator** (part of the engine, not this SDK) manages workflow step ordering, retries, and scheduling. You don't run it — it's already running in the engine stack.

---

## Requirements

- Node.js >= 20.0.0
- A running Orchestra Engine stack (API + Kafka + Redis + PostgreSQL) — see [Infrastructure setup](#infrastructure-setup)

---

## Installation

```bash
npm install orchestra-engine
```

The package ships CommonJS and ESM-compatible output and includes TypeScript declaration files — no `@types/` package needed.

---

## JobEngine — Submit jobs from your backend

Use `JobEngine` to submit jobs, workflows, and schedules from your existing services. It communicates with the Orchestra Engine REST API over HTTP.

### Constructor

```typescript
import { JobEngine } from 'orchestra-engine';

const engine = new JobEngine({
  apiUrl: process.env.ORCHESTRA_API_URL, // e.g. 'http://localhost:3000'
  apiKey: process.env.ORCHESTRA_API_KEY,
});
```

Both fields are required. The `apiKey` is sent as a `Bearer` token on every request.

---

### Submit a job

```typescript
const { jobId } = await engine.submitJob({
  type:    'send-email',
  payload: { to: 'user@example.com', subject: 'Welcome!' },
  retries: 3,
  backoff: 'exponential',
});
```

`type` must match a handler registered in your worker. `payload` is passed to the handler via `ctx.data`.

---

### Submit with an idempotency key

Safe to call multiple times — submitting the same key twice returns the existing job without creating a duplicate:

```typescript
const { jobId } = await engine.submitJob({
  type:           'send-email',
  payload:        { to: 'user@example.com', subject: 'Welcome!' },
  idempotencyKey: `welcome-email-${userId}`,
  retries:        3,
  backoff:        'exponential',
});
```

Useful inside payment flows, webhook handlers, or any retry-prone code path.

---

### Submit with priority and delay

```typescript
const { jobId } = await engine.submitJob({
  type:     'generate-report',
  payload:  { reportId: '123' },
  priority: 'high',
  delayMs:  5000,  // wait 5 s before first execution attempt
});
```

Priority controls queue ordering. Delay is applied before the very first attempt (not between retries).

---

### Check job status

```typescript
const job = await engine.getJob(jobId);

console.log(job.status);      // 'pending' | 'running' | 'retrying' | 'completed' | 'failed' | 'dead'
console.log(job.progress);    // 0–100, as reported by ctx.progress()
console.log(job.logs);        // string[] of lines written by ctx.log()
console.log(job.result);      // whatever your handler returned
console.log(job.error);       // error message if the job failed
console.log(job.attempts);    // how many attempts have been made
console.log(job.maxAttempts); // configured retry limit
```

Status lifecycle:

| Status | Meaning |
|--------|---------|
| `pending` | Queued, not yet picked up |
| `running` | Currently executing in a worker |
| `retrying` | Failed, waiting for next retry attempt |
| `completed` | Handler returned successfully |
| `failed` | Last attempt failed |
| `dead` | Exhausted all retries — will not retry again |

---

### Submit a workflow

A workflow is a directed acyclic graph of jobs. Steps that declare `dependsOn` run after their dependencies complete. Steps sharing a `parallelGroup` run concurrently once their shared dependencies are met.

Use the fluent chain API via `engine.workflow(name)`:

```typescript
const { workflowId } = await engine.workflow('order-processing')
  .step({ name: 'validate-order', type: 'validate-order', payload: { orderId: '123' } })
  .step({ name: 'reserve-inventory', type: 'reserve-inventory', payload: { orderId: '123' }, dependsOn: ['validate-order'], parallelGroup: 'fulfillment' })
  .step({ name: 'charge-payment', type: 'charge-payment', payload: { orderId: '123', amount: 4999 }, dependsOn: ['validate-order'], parallelGroup: 'fulfillment' })
  .step({ name: 'send-confirmation', type: 'send-email', payload: { to: 'user@example.com', subject: 'Order confirmed' }, dependsOn: ['reserve-inventory', 'charge-payment'] })
  .onFailure({ type: 'notify-ops', payload: { alert: 'order-processing failed', orderId: '123' } })
  .submit();
```

`onFailure` is optional. If provided, it is submitted as a new job automatically when the workflow enters a `failed` state.

> You can also use `submitWorkflow(options)` directly if you prefer passing the full options object (e.g. when building steps dynamically in a loop).

---

### Get workflow status

```typescript
const workflow = await engine.getWorkflow(workflowId);

console.log(workflow.status); // 'pending' | 'running' | 'completed' | 'failed'
console.log(workflow.steps);  // array of per-step status objects

for (const step of workflow.steps) {
  console.log(step.name, step.status, step.executedAt);
}
```

---

### Resume a failed workflow

Resumes execution from the failed step — already-completed steps are not re-run:

```typescript
await engine.resumeWorkflow(workflowId);
```

---

### Schedules

Create recurring (cron) or one-time (one-shot) schedules. On each trigger, the engine automatically submits the configured job.

#### Create a cron schedule

```typescript
const schedule = await engine.createSchedule({
  name:     'daily-digest',
  type:     'cron',
  cronExpr: '0 8 * * *',          // every day at 08:00 UTC
  jobType:  'send-digest-email',
  payload:  { audience: 'all-users' },
});

console.log(schedule.id);         // schedule ID
console.log(schedule.nextRunAt);  // ISO datetime of next execution
```

Standard 5-part cron expressions are supported (`minute hour day month weekday`).

#### Create a one-shot schedule

```typescript
const schedule = await engine.createSchedule({
  name:    'launch-promo',
  type:    'one_shot',
  runAt:   '2026-04-01T09:00:00.000Z',  // ISO 8601, fires once
  jobType: 'send-promo-email',
  payload: { campaign: 'spring-sale' },
});
```

#### List all schedules

```typescript
const schedules = await engine.listSchedules();

for (const s of schedules) {
  console.log(s.name, s.type, s.active, s.nextRunAt);
}
```

#### Pause or reactivate a schedule

```typescript
// Pause
await engine.updateSchedule(scheduleId, { active: false });

// Reactivate
await engine.updateSchedule(scheduleId, { active: true });
```

#### Delete a schedule

```typescript
await engine.deleteSchedule(scheduleId);
```

Deletion is permanent. The job history for previously triggered jobs is not affected.

---

## Worker — Execute jobs in your own process

Create a `worker.ts` file in your own project. Register a handler for every job type your application needs to process, then call `worker.start()`.

```typescript
import { Worker } from 'orchestra-engine';

const worker = new Worker();

worker
  .register('send-email', async (ctx) => {
    const { to, subject } = ctx.data as { to: string; subject: string };

    await ctx.log(`Sending email to ${to}`);
    await ctx.progress(30);

    await emailService.send({ to, subject });

    await ctx.progress(100);
    return { sent: true };
  })
  .register('charge-payment', async (ctx) => {
    const { orderId, amount } = ctx.data as { orderId: string; amount: number };

    await ctx.log(`Charging $${amount / 100} for order ${orderId}`);
    const charge = await stripe.charges.create({ amount, currency: 'usd' });

    return { chargeId: charge.id };
  })
  .register('generate-report', async (ctx) => {
    await ctx.log('Building report...');

    for (let i = 10; i <= 100; i += 10) {
      await doWork();
      await ctx.progress(i);
    }

    const report = await reportService.build(ctx.data);
    return { url: report.url };
  });

await worker.start({
  kafkaBrokers:  [process.env.KAFKA_BROKERS  ?? 'localhost:9092'],
  redisHost:     process.env.REDIS_HOST      ?? 'localhost',
  redisPort:     parseInt(process.env.REDIS_PORT ?? '6379'),
  redisPassword: process.env.REDIS_PASSWORD,
});
```

Run it alongside your main server:

```bash
# Development
npx ts-node worker.ts

# Production (after building)
node dist/worker.js
```

### Handler context (`ctx`)

Every handler receives a `ctx` object with everything it needs to process the job:

| Property | Type | Description |
|----------|------|-------------|
| `ctx.jobId` | `string` | Unique job ID |
| `ctx.type` | `string` | The job type string |
| `ctx.data` | `Record<string, unknown>` | The payload submitted with the job |
| `ctx.attempt` | `number` | Which attempt this is (starts at `1`) |
| `ctx.progress(n)` | `(percent: number) => Promise<void>` | Report 0–100 progress — visible live in the dashboard |
| `ctx.log(msg)` | `(message: string) => Promise<void>` | Append a timestamped log line — visible in the job detail view |

**Return value:** whatever a handler returns is stored as `job.result` and can be retrieved via `engine.getJob()`.

**Failures:** if a handler throws, the job is marked `failed` and retried up to `maxAttempts`. On the final attempt, the job moves to `dead`. The thrown error message is stored in `job.error`.

### Graceful shutdown

Always set up shutdown handlers so in-progress jobs are not abandoned mid-execution:

```typescript
async function shutdown() {
  console.log('Shutting down worker...');
  await worker.stop();   // disconnects Kafka consumer/producer and Redis clients
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);
```

`worker.stop()` waits for any currently-running handler to complete before disconnecting.

---

## Error handling

All `JobEngine` methods throw if the API returns a non-2xx response. The error message includes the HTTP status code and the API's error body:

```typescript
try {
  const { jobId } = await engine.submitJob({ type: 'send-email', payload: {} });
} catch (err) {
  // err.message: "OrchestraEngine API error [401]: Unauthorized"
  console.error(err.message);
}
```

Common status codes:

| Code | Meaning |
|------|---------|
| `401` | Invalid or missing API key |
| `404` | Job/workflow/schedule not found |
| `409` | Conflict — e.g. duplicate idempotency key with different payload |
| `422` | Validation error — check your options |
| `500` | Engine-side error |

---

## TypeScript

The package ships `.d.ts` declaration files. All options and response types are exported and can be imported directly:

```typescript
import type {
  JobEngineOptions,
  SubmitJobOptions,
  SubmitWorkflowOptions,
  CreateScheduleOptions,
  JobStatus,
  WorkflowStatus,
  ScheduleStatus,
  WorkerOptions,
  WorkerJobContext,
} from 'orchestra-engine';
```

---

## Reference tables

### SubmitJobOptions

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `type` | `string` | **required** | Job type — must match a registered handler |
| `payload` | `object` | **required** | Data passed to the handler via `ctx.data` |
| `retries` | `number` | `3` | Max retry attempts on failure |
| `backoff` | `'fixed' \| 'linear' \| 'exponential'` | `'exponential'` | Delay strategy between retry attempts |
| `delayMs` | `number` | `0` | Milliseconds to wait before first execution |
| `priority` | `'low' \| 'normal' \| 'high' \| 'critical'` | `'normal'` | Queue priority |
| `idempotencyKey` | `string` | — | Deduplication key — same key returns existing job |

### WorkerOptions

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `kafkaBrokers` | `string[]` | **required** | Kafka broker addresses, e.g. `['localhost:9092']` |
| `redisHost` | `string` | `'localhost'` | Redis host |
| `redisPort` | `number` | `6379` | Redis port |
| `redisPassword` | `string` | — | Redis password (if auth is enabled) |
| `groupId` | `string` | `'orchestra-sdk-workers'` | Kafka consumer group ID |
| `clientId` | `string` | `'orchestra-engine-sdk-worker'` | Kafka client ID |

### CreateScheduleOptions

**Cron schedule:**

| Option | Type | Description |
|--------|------|-------------|
| `name` | `string` | Human-readable label for the schedule |
| `type` | `'cron'` | Schedule type |
| `cronExpr` | `string` | Standard 5-part cron expression, e.g. `"0 8 * * *"` |
| `jobType` | `string` | Job type to submit on each tick |
| `payload` | `object` | Optional payload passed to the job |

**One-shot schedule:**

| Option | Type | Description |
|--------|------|-------------|
| `name` | `string` | Human-readable label |
| `type` | `'one_shot'` | Schedule type |
| `runAt` | `string` | ISO 8601 datetime — fires exactly once |
| `jobType` | `string` | Job type to submit |
| `payload` | `object` | Optional payload passed to the job |

### JobStatus response

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Job ID |
| `type` | `string` | Job type |
| `status` | `string` | `'pending' \| 'running' \| 'retrying' \| 'completed' \| 'failed' \| 'dead'` |
| `progress` | `number` | 0–100, last value reported via `ctx.progress()` |
| `attempts` | `number` | Number of execution attempts so far |
| `maxAttempts` | `number` | Configured retry limit |
| `result` | `unknown` | Return value of the handler (if completed) |
| `error` | `string \| null` | Error message (if failed) |
| `logs` | `string[]` | Lines written via `ctx.log()` |
| `createdAt` | `string` | ISO 8601 timestamp |
| `startedAt` | `string \| null` | When the first attempt began |
| `completedAt` | `string \| null` | When the job reached a terminal state |

### WorkflowStatus response

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Workflow ID |
| `name` | `string` | Name provided at submission |
| `status` | `string` | `'pending' \| 'running' \| 'completed' \| 'failed'` |
| `steps` | `array` | Per-step status — see below |
| `createdAt` | `string` | ISO 8601 timestamp |
| `completedAt` | `string \| null` | When the workflow reached a terminal state |

Each element in `steps`:

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Step ID |
| `name` | `string` | Step name from the workflow definition |
| `jobType` | `string` | Job type for this step |
| `status` | `string` | Same statuses as job status |
| `dependsOn` | `string[]` | Step names this step waited for |
| `parallelGroup` | `string \| null` | Parallel group name, if any |
| `executedAt` | `string \| null` | When this step's job started |

---

## Infrastructure setup

This SDK is the client library only. You still need to run the Orchestra Engine stack, which includes:

- **API** — REST server this SDK talks to
- **Orchestrator** — manages workflow step ordering and retries
- **Scheduler** — fires scheduled jobs
- **Kafka** — job queue transport
- **Redis** — distributed locking and job state
- **PostgreSQL** — persistent storage
- **Dashboard** — real-time UI (optional)

The fastest way to run everything locally:

```bash
git clone https://github.com/KUSHAL-31/orchestra-engine
cd orchestra-engine
docker compose up
```

This starts all services. The API will be available at `http://localhost:3000` by default.

---

## License

MIT
