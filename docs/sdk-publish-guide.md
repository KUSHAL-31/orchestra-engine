# SDK — What Changed, How to Publish, How to Use

---

## What Changed

The `packages/sdk` directory existed before but was a design stub — it imported internal monorepo packages (`@node-forge-engine/kafka`, `@node-forge-engine/redis`, `@node-forge-engine/types`) that only exist inside this repo and would not be available on npm. It was not publishable.

The following changes were made to make it a real, self-contained npm package:

### `package.json`

- **Name changed** from `@node-forge-engine/sdk` (scoped, requires npm org) to `node-forge-engine` (unscoped, publishable immediately)
- **Internal monorepo dependencies removed** — `@node-forge-engine/kafka`, `@node-forge-engine/redis`, `@node-forge-engine/types` are gone
- **Real dependencies added** — `kafkajs`, `ioredis`, `redlock` (the same underlying libraries the engine uses internally, now declared directly)
- **Added** `files`, `engines`, `license`, `repository`, `keywords`, `prepublishOnly` fields required for a proper npm package

### `tsconfig.json`

Replaced the `extends: ../../tsconfig.base.json` reference (only valid inside the monorepo) with a standalone `compilerOptions` block that works on its own. Added `declaration: true` and `declarationMap: true` so TypeScript types are included in the published package.

### `src/types.ts`

- Added JSDoc comments on every field
- Added `redisPassword` and `clientId` to `WorkerOptions`
- Improved `JobStatus.status` and `WorkflowStatus.status` from `string` to typed union literals
- Added `executedAt` to workflow step type

### `src/job-engine.ts`

Kept the same logic. Minor cleanup — consistent null check for request body.

### `src/worker.ts` — biggest change

The previous version used singleton Kafka/Redis clients from internal packages (`import { kafka } from '@node-forge-engine/kafka'`). These singletons read from env vars and are only valid inside the monorepo's own services.

The rewritten Worker class:
- Takes all connection config via `WorkerOptions` (brokers, redis host/port/password)
- Creates its own `Kafka` instance from `kafkajs` using those options
- Creates its own two `Redis` instances from `ioredis` (one for general ops, one dedicated to Redlock)
- Creates its own `Redlock` instance from `redlock`
- Inlines the Kafka topic names and Redis key patterns (which are stable constants the engine depends on)
- Exposes a `stop()` method for graceful shutdown (disconnect consumer, producer, and both Redis clients)

### `src/index.ts`

No logic change. Barrel export file, just ensures all public types are re-exported.

### `README.md` (new file)

Written for the npm package page. Covers installation, all `JobEngine` methods with examples, full `Worker` usage with a graceful shutdown pattern, and reference tables for all options.

---

## How to Publish

### Step 1 — Create an npm account

Go to https://www.npmjs.com/signup if you don't have one.

### Step 2 — Log in from the terminal

```bash
npm login
```

Enter your username, password, and OTP if 2FA is enabled.

### Step 3 — Build the package

```bash
cd packages/sdk
npm install
npm run build
```

This compiles TypeScript to `packages/sdk/dist/`. Check that the `dist/` folder exists and contains `.js` and `.d.ts` files before publishing.

### Step 4 — Preview what will be published

```bash
npm pack --dry-run
```

You should see only files from the `dist/` folder and `README.md`. If you see source `.ts` files, something is wrong with the `files` field.

### Step 5 — Publish

```bash
npm publish
```

The `prepublishOnly` script runs `tsc` automatically before publishing, so even if you forgot Step 3 it will still build first.

### Publishing a new version

Every publish needs a version bump first:

```bash
# patch: 1.0.0 → 1.0.1  (bug fixes)
npm version patch

# minor: 1.0.0 → 1.1.0  (new features, backwards compatible)
npm version minor

# major: 1.0.0 → 2.0.0  (breaking changes)
npm version major

npm publish
```

`npm version` automatically updates `package.json` and creates a git tag.

---

## How to Use (from a consumer's perspective)

### Install

```bash
npm install node-forge-engine
```

### Submitting jobs from an existing backend

Import `JobEngine` and point it at your running Forge Engine API. No Kafka or Redis connection is needed on this side — it's just HTTP.

```typescript
import { JobEngine } from 'node-forge-engine';

const engine = new JobEngine({
  apiUrl: process.env.FORGE_API_URL, // e.g. 'http://localhost:3000'
  apiKey: process.env.FORGE_API_KEY,
});

// Inside a route handler
router.post('/orders', async (req, res) => {
  const order = await db.orders.create(req.body);

  const { jobId } = await engine.submitJob({
    type:           'send-confirmation-email',
    payload:        { orderId: order.id, email: req.body.email },
    retries:        3,
    backoff:        'exponential',
    idempotencyKey: `order-email-${order.id}`,
  });

  res.json({ orderId: order.id });
});
```

### Submitting a workflow

```typescript
const { workflowId } = await engine.submitWorkflow({
  name: `order-${orderId}`,
  steps: [
    { name: 'validate',  type: 'validate-order',  payload: { orderId } },
    { name: 'charge',    type: 'charge-payment',  payload: { orderId }, dependsOn: ['validate'] },
    { name: 'email',     type: 'send-email',      payload: { orderId }, dependsOn: ['charge'] },
  ],
  onFailure: { type: 'alert-ops', payload: { orderId } },
});
```

### Running a worker process

Create a new file (e.g. `worker.ts`) in your own project:

```typescript
import { Worker } from 'node-forge-engine';

const worker = new Worker();

worker
  .register('send-confirmation-email', async (ctx) => {
    const { email, orderId } = ctx.data as { email: string; orderId: string };

    await ctx.log(`Sending email to ${email}`);
    await ctx.progress(30);

    await myEmailService.send({ to: email, subject: `Order ${orderId} confirmed` });

    await ctx.progress(100);
    return { sent: true };
  })
  .register('charge-payment', async (ctx) => {
    const { orderId, amount } = ctx.data as { orderId: string; amount: number };
    await ctx.log(`Charging ${amount} for order ${orderId}`);
    const charge = await stripe.charges.create({ amount, currency: 'usd' });
    return { chargeId: charge.id };
  });

await worker.start({
  kafkaBrokers: [process.env.KAFKA_BROKERS ?? 'localhost:9092'],
  redisHost:    process.env.REDIS_HOST ?? 'localhost',
  redisPort:    parseInt(process.env.REDIS_PORT ?? '6379'),
  redisPassword: process.env.REDIS_PASSWORD,
});

// Graceful shutdown
const shutdown = () => worker.stop().then(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);
```

Run it:

```bash
npx ts-node worker.ts
# or after building:
node dist/worker.js
```

### What the developer still needs

The SDK only handles the client side. The developer still needs to run the Forge Engine infrastructure (API, Orchestrator, Scheduler, Redis, Kafka, Postgres). The easiest way is the Docker Compose file from this repo.

For a startup using this pattern:
1. Run Forge Engine infra via Docker Compose (one command)
2. `npm install node-forge-engine` in their app
3. Use `JobEngine` to submit jobs from their existing route handlers
4. Create a `worker.ts` file in their repo with their handlers
5. Run the worker process alongside their main server
