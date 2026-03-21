# node-forge-engine

Node.js SDK for [Node Forge Engine](https://github.com/KUSHAL-31/node-forge-engine) — a self-hosted background job engine with Kafka, Redis, and a real-time dashboard.

Install the SDK in your existing backend to:
- Submit jobs and workflows to the engine from any Node.js service
- Run your own worker process that consumes and executes jobs

## Requirements

- Node.js >= 20.0.0
- A running Forge Engine stack (API + Kafka + Redis) — see the [main repo](https://github.com/KUSHAL-31/node-forge-engine) for setup

## Installation

```bash
npm install node-forge-engine
```

---

## JobEngine — Submit jobs from your backend

Use `JobEngine` to submit jobs and workflows from any existing service. It talks to the Forge Engine REST API over HTTP — no Kafka or Redis connection needed on the client side.

```typescript
import { JobEngine } from 'node-forge-engine';

const engine = new JobEngine({
  apiUrl: 'http://localhost:3000',  // your Forge Engine API URL
  apiKey: 'your-api-key',
});
```

### Submit a job

```typescript
const { jobId } = await engine.submitJob({
  type:    'send-email',
  payload: { to: 'user@example.com', subject: 'Welcome!' },
  retries: 3,
  backoff: 'exponential',
});
```

### Submit with an idempotency key

Safe to call multiple times — same key returns the existing job, no duplicate created:

```typescript
const { jobId } = await engine.submitJob({
  type:           'send-email',
  payload:        { to: 'user@example.com' },
  idempotencyKey: `welcome-email-${userId}`,
  retries:        3,
  backoff:        'exponential',
});
```

### Submit with priority and delay

```typescript
const { jobId } = await engine.submitJob({
  type:     'generate-report',
  payload:  { reportId: '123' },
  priority: 'high',
  delayMs:  5000,  // wait 5 seconds before first execution
});
```

### Check job status

```typescript
const job = await engine.getJob(jobId);

console.log(job.status);    // 'pending' | 'running' | 'completed' | 'failed' | 'dead'
console.log(job.progress);  // 0–100
console.log(job.logs);      // string[] of log lines written by the handler
console.log(job.result);    // whatever the handler returned
console.log(job.error);     // error message if it failed
```

### Submit a workflow

Steps with `dependsOn` run after their dependencies complete. Steps sharing a `parallelGroup` run at the same time:

```typescript
const { workflowId } = await engine.submitWorkflow({
  name: 'order-processing',
  steps: [
    {
      name:    'validate-order',
      type:    'validate-order',
      payload: { orderId: '123' },
    },
    {
      name:          'reserve-inventory',
      type:          'reserve-inventory',
      payload:       { orderId: '123' },
      dependsOn:     ['validate-order'],
      parallelGroup: 'fulfillment',   // runs in parallel with charge-payment
    },
    {
      name:          'charge-payment',
      type:          'charge-payment',
      payload:       { orderId: '123', amount: 4999 },
      dependsOn:     ['validate-order'],
      parallelGroup: 'fulfillment',   // runs in parallel with reserve-inventory
    },
    {
      name:      'send-confirmation',
      type:      'send-email',
      payload:   { to: 'user@example.com', subject: 'Order confirmed' },
      dependsOn: ['reserve-inventory', 'charge-payment'],  // waits for both
    },
  ],
  onFailure: {
    type:    'notify-ops',
    payload: { orderId: '123' },
  },
});
```

### Get workflow status

```typescript
const workflow = await engine.getWorkflow(workflowId);
console.log(workflow.status); // 'pending' | 'running' | 'completed' | 'failed'
console.log(workflow.steps);  // per-step status
```

### Resume a failed workflow

Resumes from the failed step — already-completed steps are skipped:

```typescript
await engine.resumeWorkflow(workflowId);
```

---

## Worker — Execute jobs in your own process

Use `Worker` to run a worker process inside your own repo. It connects to Kafka and Redis, consumes jobs, and calls your handler functions.

```typescript
import { Worker } from 'node-forge-engine';

const worker = new Worker();

worker
  .register('send-email', async (ctx) => {
    const { to, subject } = ctx.data as { to: string; subject: string };

    await ctx.log(`Sending email to ${to}`);
    await ctx.progress(50);

    // your actual sending logic here
    await emailService.send({ to, subject });

    await ctx.progress(100);
    return { sent: true };
  })
  .register('generate-report', async (ctx) => {
    await ctx.log('Building report...');
    const report = await reportService.build(ctx.data);
    return { url: report.url };
  });

await worker.start({
  kafkaBrokers: ['localhost:9092'],
  redisHost:    'localhost',
  redisPort:    6379,
});

// Graceful shutdown
process.on('SIGTERM', () => worker.stop());
process.on('SIGINT',  () => worker.stop());
```

### Handler context (ctx)

Every handler receives a `ctx` object:

| Property | Type | Description |
|----------|------|-------------|
| `ctx.jobId` | `string` | Unique job ID |
| `ctx.type` | `string` | The job type string |
| `ctx.data` | `Record<string, unknown>` | The payload submitted with the job |
| `ctx.attempt` | `number` | Which attempt this is (starts at 1) |
| `ctx.progress(n)` | `(percent: number) => Promise<void>` | Report 0–100 progress — visible live in the dashboard |
| `ctx.log(msg)` | `(message: string) => Promise<void>` | Append a timestamped log line — visible in job detail view |

Whatever a handler returns becomes `job.result`. If it throws, the job fails and is retried (up to `maxAttempts`).

### WorkerOptions

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `kafkaBrokers` | `string[]` | required | Kafka broker addresses |
| `redisHost` | `string` | `'localhost'` | Redis host |
| `redisPort` | `number` | `6379` | Redis port |
| `redisPassword` | `string` | — | Redis password (if auth enabled) |
| `groupId` | `string` | `'forge-sdk-workers'` | Kafka consumer group ID |
| `clientId` | `string` | `'forge-engine-sdk-worker'` | Kafka client ID |

---

## SubmitJobOptions reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `type` | `string` | required | Job type — must match a registered handler |
| `payload` | `object` | required | Data passed to the handler via `ctx.data` |
| `retries` | `number` | `3` | Max retry attempts on failure |
| `backoff` | `'fixed' \| 'linear' \| 'exponential'` | `'exponential'` | Retry backoff strategy |
| `delayMs` | `number` | `0` | Delay before first execution (ms) |
| `priority` | `'low' \| 'normal' \| 'high' \| 'critical'` | `'normal'` | Job priority |
| `idempotencyKey` | `string` | — | Deduplication key |

---

## License

MIT
