# Developer Journey — How a Startup Adopts Forge Engine

This document tells the story of a fictional startup called **ShipFast** as they discover Forge Engine and integrate it into their existing backend. The goal is to show how a real team would think about adoption, what problems they solve at each step, and what the end state looks like — with the exact code changes at each phase.

---

## Who Is ShipFast?

ShipFast is a B2B SaaS company with a Node.js/Express backend. They have about five engineers. Their product processes customer orders — each order goes through validation, payment, inventory reservation, warehouse notification, and a confirmation email to the buyer.

For the first two years this all happened synchronously inside their HTTP route handlers. The code worked. But as their order volume grew, cracks started appearing.

---

## The Breaking Point

ShipFast's order endpoint was taking five to seven seconds to respond. Most of that time was spent doing things that had nothing to do with answering the customer — sending emails, calling the warehouse API, updating analytics systems. If any of those calls failed, the whole order failed. There was no retry logic. There was no visibility. If the warehouse webhook silently timed out at 2am, nobody knew until a customer complained the next morning.

They also had a cron job running inside the API server that generated a daily report at 9am. When they started running two API server instances for redundancy, the report ran twice. When a deployment happened to land at 9am, the report was skipped entirely.

**This is what their order route looked like:**

```typescript
// routes/orders.ts — BEFORE Forge Engine
router.post('/orders', async (req, res) => {
  const order = await db.orders.create(req.body);

  await stripe.charges.create({ amount: order.total, customer: order.customerId });
  // ↑ 2–3 seconds. Blocks the response.

  await emailService.sendConfirmation(order.userId, order.id);
  // ↑ 1 second. Blocks the response.

  await webhookService.notifyWarehouse(order);
  // ↑ Can fail. No retry. Silently dropped.

  res.json({ orderId: order.id });
  // ↑ User waited 5–7 seconds total.
});
```

**And their cron job:**

```typescript
// cron.ts — BEFORE Forge Engine
import cron from 'node-cron';

cron.schedule('0 9 * * *', async () => {
  try {
    await reportService.generateDaily();
  } catch (err) {
    console.error('Daily report failed:', err);
    // No retry. No visibility. Just dies.
  }
});
// Runs on every API instance — duplicates when scaled.
// Skipped entirely if a deployment lands at 9am.
```

---

## What They Decided They Needed

After discussing the problem, the team wrote down their requirements:

- Jobs must run in the background so HTTP responses are fast
- Jobs must automatically retry with backoff when they hit flaky external services
- Multi-step pipelines must continue from the failed step — not restart from scratch
- Scheduled jobs must fire exactly once regardless of how many server instances are running
- Every job must be visible somewhere so support can answer questions without pinging engineering

They evaluated BullMQ (no built-in workflow orchestration), hosted queues like SQS (vendor lock-in, no local dev story), and Forge Engine. Forge Engine had everything in one repo — queue, orchestration, scheduler, and dashboard — self-hosted on their own infrastructure.

---

## Phase 1 — Running Forge Engine Alongside Their Stack

The first thing ShipFast did was add Forge Engine to their existing Docker Compose file. They did not touch their application code at all.

```yaml
# docker-compose.yml — added to their EXISTING file

services:
  # Their existing service stays untouched
  api-server:
    build: .
    ports: ['4000:4000']

  # ── Forge Engine infrastructure ───────────────────────────────────────────

  forge-postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: forge
      POSTGRES_PASSWORD: forge
      POSTGRES_DB: forge_engine
    volumes:
      - forge_postgres_data:/var/lib/postgresql/data

  forge-redis:
    image: redis:7-alpine

  forge-zookeeper:
    image: confluentinc/cp-zookeeper:7.6.0
    environment:
      ZOOKEEPER_CLIENT_PORT: 2181
      ZOOKEEPER_TICK_TIME: 2000

  forge-kafka:
    image: confluentinc/cp-kafka:7.6.0
    depends_on: [forge-zookeeper]
    environment:
      KAFKA_BROKER_ID: 1
      KAFKA_ZOOKEEPER_CONNECT: forge-zookeeper:2181
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://forge-kafka:29092
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
      KAFKA_AUTO_CREATE_TOPICS_ENABLE: 'true'

  # ── Forge Engine application services ────────────────────────────────────

  forge-api:
    image: ghcr.io/your-org/node-forge-engine-api:latest
    ports: ['3099:3000']   # internal only, not exposed to the internet
    environment:
      DATABASE_URL: postgresql://forge:forge@forge-postgres:5432/forge_engine
      KAFKA_BROKERS: forge-kafka:29092
      REDIS_HOST: forge-redis
      API_KEY_SEED: ${FORGE_API_KEY_SEED}
    depends_on: [forge-postgres, forge-kafka, forge-redis]

  forge-orchestrator:
    image: ghcr.io/your-org/node-forge-engine-orchestrator:latest
    environment:
      DATABASE_URL: postgresql://forge:forge@forge-postgres:5432/forge_engine
      KAFKA_BROKERS: forge-kafka:29092
      REDIS_HOST: forge-redis
    depends_on: [forge-api]

  forge-worker:
    image: ghcr.io/your-org/shipfast-forge-worker:latest  # their custom build
    environment:
      DATABASE_URL: postgresql://forge:forge@forge-postgres:5432/forge_engine
      KAFKA_BROKERS: forge-kafka:29092
      REDIS_HOST: forge-redis
    depends_on: [forge-api]
    deploy:
      replicas: 2

  forge-scheduler:
    image: ghcr.io/your-org/node-forge-engine-scheduler:latest
    environment:
      DATABASE_URL: postgresql://forge:forge@forge-postgres:5432/forge_engine
      KAFKA_BROKERS: forge-kafka:29092
      REDIS_HOST: forge-redis
      API_BASE_URL: http://forge-api:3000
    depends_on: [forge-api]

  forge-dashboard:
    image: ghcr.io/your-org/node-forge-engine-dashboard:latest
    ports: ['3100:80']   # internal dashboard for the team
    depends_on: [forge-api]

volumes:
  forge_postgres_data:
```

They add two env vars to their app:

```env
FORGE_API_URL=http://forge-api:3000
FORGE_API_KEY=shipfast-internal-key-prod
```

Within an hour the dashboard is running at `http://localhost:3100` and the Forge API is accepting requests from within their Docker network. **Zero changes to their existing application code.**

They also write a tiny helper that lives in their existing backend — this is the only new utility they need:

```typescript
// lib/forge.ts  (new file in their existing backend)
const FORGE_URL = process.env.FORGE_API_URL!;
const FORGE_KEY = process.env.FORGE_API_KEY!;

export async function enqueue(
  type: string,
  payload: Record<string, unknown>,
  options: {
    retries?: number;
    backoff?: 'fixed' | 'linear' | 'exponential';
    priority?: 'low' | 'normal' | 'high' | 'critical';
    idempotencyKey?: string;
    delayMs?: number;
  } = {}
) {
  const res = await fetch(`${FORGE_URL}/jobs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${FORGE_KEY}`,
    },
    body: JSON.stringify({ type, payload, ...options }),
  });
  return res.json() as Promise<{ jobId: string }>;
}

export async function submitWorkflow(body: Record<string, unknown>) {
  const res = await fetch(`${FORGE_URL}/workflows`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${FORGE_KEY}`,
    },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<{ workflowId: string }>;
}
```

---

## Phase 2 — Offloading the First Side Effect

The team picked their most painful problem first: the confirmation email was holding the order response hostage for over a second.

**The change to their route:**

```typescript
// routes/orders.ts — AFTER Forge Engine
import { enqueue } from '../lib/forge';

router.post('/orders', async (req, res) => {
  const order = await db.orders.create(req.body);
  await stripe.charges.create({ amount: order.total, customer: order.customerId });

  // Fire and forget — returns in <50ms
  await enqueue('send-confirmation-email', {
    orderId: order.id,
    userId:  order.userId,
    email:   req.body.email,
  }, {
    retries: 3,
    backoff: 'exponential',
    idempotencyKey: `order-email-${order.id}`,
  });

  await enqueue('notify-warehouse', {
    orderId: order.id,
    items:   order.items,
  }, {
    retries: 5,
    backoff: 'linear',
  });

  res.json({ orderId: order.id });
  // ↑ Returns in ~150ms now. Email and warehouse happen in the background.
});
```

To make this work they also write the handler inside the Forge worker. They fork this repo, add their handler, and build a custom worker image:

```typescript
// apps/worker/src/handlers/send-confirmation-email.ts  (in the forked repo)
import type { JobHandlerFn } from '../context';
import nodemailer from 'nodemailer';

export const sendConfirmationEmailHandler: JobHandlerFn = async (ctx) => {
  const { orderId, email } = ctx.data as { orderId: string; email: string };

  await ctx.log(`Sending confirmation to ${email} for order ${orderId}`);
  await ctx.progress(20);

  const transporter = nodemailer.createTransport({ /* SMTP config from env */ });
  await transporter.sendMail({
    to: email,
    subject: `Order ${orderId} confirmed`,
    html: `<p>Your order has been placed. Order ID: ${orderId}</p>`,
  });

  await ctx.progress(100);
  await ctx.log('Confirmation email sent successfully');
  return { sent: true, to: email };
};
```

Register it in the worker entry point:

```typescript
// apps/worker/src/index.ts
import { sendConfirmationEmailHandler } from './handlers/send-confirmation-email';
import { notifyWarehouseHandler }       from './handlers/notify-warehouse';

const handlers = new Map([
  ['send-confirmation-email', sendConfirmationEmailHandler],
  ['notify-warehouse',        notifyWarehouseHandler],
  // ... keep existing handlers
]);
```

**Result:** The order endpoint goes from 7 seconds to under 200ms. Emails are retried automatically on failure. Every email job is visible in the dashboard with its status, attempt count, logs, and error message.

---

## Phase 3 — Replacing the Broken Cron Job

They delete the node-cron code entirely from their API server. Instead they register a schedule in Forge once during app startup:

```typescript
// startup.ts  (runs when their API server boots)
async function ensureSchedules() {
  const existing = await fetch(`${FORGE_URL}/schedules`, {
    headers: { Authorization: `Bearer ${FORGE_KEY}` },
  }).then(r => r.json()) as any[];

  if (!existing.find(s => s.name === 'daily-report')) {
    await fetch(`${FORGE_URL}/schedules`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${FORGE_KEY}`,
      },
      body: JSON.stringify({
        name:     'daily-report',
        type:     'cron',
        cronExpr: '0 9 * * *',
        jobType:  'generate-daily-report',
        payload:  { reportType: 'daily' },
      }),
    });
  }
}
```

The schedule now lives in Forge's database. The Forge Scheduler fires exactly one job at 9am regardless of how many API server instances are running. If the job fails, it retries. If it exhausts all retries, it lands in the Dead Letter Queue. The duplicate-report problem is gone.

The corresponding handler in the worker:

```typescript
// apps/worker/src/handlers/generate-daily-report.ts
import type { JobHandlerFn } from '../context';

export const generateDailyReportHandler: JobHandlerFn = async (ctx) => {
  const { reportType } = ctx.data as { reportType: string };

  await ctx.log(`Generating ${reportType} report`);
  await ctx.progress(10);

  const data = await db.orders.aggregateForReport(reportType);
  await ctx.progress(60);

  const pdf = await reportService.buildPDF(data);
  await ctx.progress(90);

  await storageService.upload(`reports/${reportType}-${Date.now()}.pdf`, pdf);
  await ctx.progress(100);
  await ctx.log('Report generated and uploaded');

  return { reportType, rowCount: data.length };
};
```

---

## Phase 4 — Modeling the Order Pipeline as a Workflow

Once the team saw how easy individual jobs were, they looked at their order pipeline as a whole. It had natural dependencies:

- `validate-order` must run first
- `reserve-inventory` and `charge-payment` can run in parallel after validation
- `fulfill-order` must wait for both of those to complete
- `notify-warehouse` and `send-confirmation-email` can run in parallel after fulfillment

They submitted the entire pipeline as a single Forge workflow:

```typescript
// routes/orders.ts — workflow version
import { submitWorkflow } from '../lib/forge';

router.post('/orders', async (req, res) => {
  const order = await db.orders.create(req.body);

  const { workflowId } = await submitWorkflow({
    name: `order-${order.id}`,
    steps: [
      {
        name:    'validate-order',
        type:    'validate-order',
        payload: { orderId: order.id },
      },
      {
        name:          'reserve-inventory',
        type:          'reserve-inventory',
        payload:       { orderId: order.id, items: order.items },
        dependsOn:     ['validate-order'],
        parallelGroup: 'fulfillment-prep',   // runs in parallel with charge-payment
      },
      {
        name:          'charge-payment',
        type:          'charge-payment',
        payload:       { orderId: order.id, amount: order.total, customerId: order.customerId },
        dependsOn:     ['validate-order'],
        parallelGroup: 'fulfillment-prep',   // runs in parallel with reserve-inventory
      },
      {
        name:      'fulfill-order',
        type:      'fulfill-order',
        payload:   { orderId: order.id },
        dependsOn: ['reserve-inventory', 'charge-payment'],  // waits for both
      },
      {
        name:          'notify-warehouse',
        type:          'notify-warehouse',
        payload:       { orderId: order.id },
        dependsOn:     ['fulfill-order'],
        parallelGroup: 'post-fulfillment',
      },
      {
        name:          'send-confirmation-email',
        type:          'send-confirmation-email',
        payload:       { orderId: order.id, email: req.body.email },
        dependsOn:     ['fulfill-order'],
        parallelGroup: 'post-fulfillment',
      },
    ],
    onFailure: {
      type:    'alert-ops',
      payload: { orderId: order.id, channel: 'slack' },
    },
  });

  // Store the workflowId so support can look it up later
  await db.orders.update(order.id, { forgeWorkflowId: workflowId });

  res.json({ orderId: order.id, workflowId });
});
```

What they get for free now:

- `reserve-inventory` and `charge-payment` run simultaneously — saving time
- `notify-warehouse` and `send-confirmation-email` run simultaneously after fulfillment
- If `charge-payment` fails, the workflow pauses there — validation and inventory reservation are not re-run when resumed
- The `onFailure` handler fires `alert-ops` automatically, which posts to their Slack
- Every step is visible in the workflow detail view with timestamps and status

---

## Phase 5 — Giving Support Visibility Without a Dashboard Login

ShipFast's support team needs to answer "why hasn't this customer received their confirmation email" without asking engineering. They expose an internal endpoint in their existing API that proxies the workflow status:

```typescript
// routes/admin.ts
router.get('/admin/orders/:id/background', async (req, res) => {
  const order = await db.orders.findById(req.params.id);

  if (!order.forgeWorkflowId) {
    return res.json({ status: 'no-workflow-attached' });
  }

  const workflow = await fetch(
    `${process.env.FORGE_API_URL}/workflows/${order.forgeWorkflowId}`,
    { headers: { Authorization: `Bearer ${process.env.FORGE_API_KEY}` } }
  ).then(r => r.json()) as any;

  res.json({
    orderId:        order.id,
    workflowStatus: workflow.status,
    steps: workflow.steps.map((s: any) => ({
      name:       s.name,
      status:     s.status,
      executedAt: s.executedAt,
    })),
  });
});
```

Support now calls `GET /admin/orders/ORD-123/background` and instantly sees which step failed and when. They also get a direct link to the Forge dashboard for deeper inspection.

---

## Phase 6 — Protecting Against Double Submission

ShipFast's mobile app has a retry button that users tap multiple times when the network is slow. Without protection, this creates duplicate jobs. They add idempotency keys derived from the order ID:

```typescript
await enqueue('send-confirmation-email', {
  orderId: order.id,
  email:   req.body.email,
}, {
  retries:        3,
  backoff:        'exponential',
  idempotencyKey: `order-email-${order.id}`,  // same order = same key = no duplicate
});
```

Forge Engine returns the existing job if a job with that key already exists. The second, third, and fourth taps from the mobile app are all safe.

---

## Phase 7 — The Dead Letter Queue as an Operational Safety Net

The warehouse integration was the flakiest part of ShipFast's system. The vendor had a maintenance window every Saturday night. The `notify-warehouse` job would retry with backoff, but during a two-hour outage it would exhaust its retries and land in the Dead Letter Queue.

They set up a scheduled job — inside Forge itself — that checks the DLQ every hour and alerts the ops channel:

```typescript
// apps/worker/src/handlers/check-dlq.ts
import type { JobHandlerFn } from '../context';

export const checkDLQHandler: JobHandlerFn = async (ctx) => {
  const dlq = await fetch(`${process.env.FORGE_API_URL}/dlq`, {
    headers: { Authorization: `Bearer ${process.env.FORGE_API_KEY}` },
  }).then(r => r.json()) as any[];

  const unreplayed = dlq.filter(e => !e.replayedAt);

  if (unreplayed.length > 0) {
    await slackClient.chat.postMessage({
      channel: '#ops-alerts',
      text: `${unreplayed.length} unresolved jobs in the Dead Letter Queue — ${process.env.FORGE_DASHBOARD_URL}/dlq`,
    });
    await ctx.log(`Alerted on ${unreplayed.length} DLQ entries`);
  }

  return { checked: dlq.length, unreplayed: unreplayed.length };
};
```

Registered as an hourly Forge schedule:

```json
{
  "name":     "dlq-monitor",
  "type":     "cron",
  "cronExpr": "0 * * * *",
  "jobType":  "check-dlq",
  "payload":  {}
}
```

When the warehouse comes back online, ops clicks Replay in the dashboard. No engineering involvement, no deployment, no database queries.

---

## Phase 8 — Scaling Under Load

When a big client campaign drove ten times their normal order volume, ShipFast scaled Forge workers with a single command:

```bash
docker compose up -d --scale forge-worker=8
```

Eight worker containers came up, each registered itself in the dashboard, and Kafka automatically distributed job load across all of them. The dashboard Workers page showed all eight instances with their heartbeat status and job types.

When the campaign ended:

```bash
docker compose up -d --scale forge-worker=2
```

The six extra workers received SIGTERM, finished their current jobs, called `deregisterWorker()`, and exited. The dashboard showed only two active workers. No configuration changes were needed anywhere.

---

## Where ShipFast Ended Up

After three weeks of incremental adoption, their application code had almost no background processing logic in it.

```
BEFORE                                AFTER
──────────────────────────────────    ────────────────────────────────
routes/orders.ts                      routes/orders.ts
  ├── create order (sync)               ├── create order (sync)
  ├── charge Stripe (sync, 2-3s)        ├── charge Stripe (sync)
  ├── send email (sync, 1s)             └── submitWorkflow() (50ms)
  ├── notify warehouse (sync)
  └── respond after 5s               routes/admin.ts
                                        └── proxy workflow status
cron.ts
  └── daily report (unreliable)      startup.ts
                                        └── ensureSchedules()
setInterval for webhooks
  └── no retry, no visibility        lib/forge.ts
                                        └── enqueue() helper
```

All background work is now retried automatically, visible in the dashboard, resumable on failure, scalable by adjusting one number, and observable via the DLQ when all retries exhaust.

---

## Quick Reference — Integration Patterns

| Situation | What to do | Forge feature used |
|-----------|------------|-------------------|
| Send email after HTTP response | Call `enqueue('send-email', payload, { retries: 3 })` | Job with retries |
| Multi-step order pipeline with dependencies | Call `submitWorkflow({ steps: [...] })` | Workflow with `dependsOn` |
| Parallel data fetch before a report | Add `parallelGroup: 'fetch'` to concurrent steps | Parallel workflow group |
| Nightly report at 9am | Register a cron schedule via the Forge API | Scheduler |
| Safe submission from retry-happy clients | Add `idempotencyKey` derived from entity ID | Job deduplication |
| Monitor failed jobs without writing code | Open Dashboard `/dlq` | Dead Letter Queue UI |
| Alert on DLQ accumulation | Schedule a `check-dlq` job | Scheduled job + DLQ API |
| Handle peak load | `docker compose up --scale forge-worker=N` | Horizontal worker scaling |
| Resume a half-done workflow | Click Resume in Dashboard or `POST /workflows/:id/resume` | Workflow resume |

---

## Common Mistakes to Avoid

**Awaiting `enqueue` and expecting the job to be done.**
`enqueue()` returns as soon as the job is submitted — not when it completes. Execution is asynchronous. If you need the result synchronously to respond to the user, that work probably should not be a background job.

**Not setting `retries` on jobs that call external services.**
Any job touching email providers, payment gateways, or third-party webhooks needs at least three retries with exponential backoff. External services fail.

**Skipping `idempotencyKey` on user-triggered actions.**
Any job submitted as a result of a user action (button click, form submit, mobile tap) should have an idempotency key derived from the entity ID to prevent duplicates.

**Running the default worker image without custom handlers.**
The default Forge worker image only includes example handlers. Fork this repo, add your handlers to `apps/worker/src/handlers/`, register them in `apps/worker/src/index.ts`, and build and push your own worker image.

**Ignoring the Dead Letter Queue.**
Jobs land in the DLQ because something genuinely went wrong after exhausting all retries. Set up monitoring so the DLQ does not silently accumulate failures that the business depends on.
