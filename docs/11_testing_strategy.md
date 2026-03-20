# 11 — Testing Strategy

> **Claude Code Instruction**: Implement tests for every service. Unit tests isolate business logic with mocked dependencies. Integration tests spin up real Kafka, Redis, and Postgres (via Docker) to verify the full flow. Use Jest throughout. Follow the folder pattern and test helpers shown here.

---

## Testing Philosophy

| Test Type | Scope | Dependencies | Framework |
|---|---|---|---|
| Unit | Single function/class | All external deps mocked | Jest |
| Integration | Service end-to-end | Real Kafka, Redis, Postgres | Jest + testcontainers |
| API | HTTP layer | Fastify test mode + mocked Kafka/Redis | Jest + `fastify.inject()` |

---

## 1. Jest Configuration

Root-level `jest.config.base.js` (shared by all packages):

```js
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts', '**/*.spec.ts'],
  collectCoverageFrom: ['src/**/*.ts', '!src/index.ts'],
  coverageThreshold: {
    global: { branches: 70, functions: 80, lines: 80, statements: 80 },
  },
  moduleNameMapper: {
    '@forge-engine/types': '<rootDir>/../../packages/types/src/index.ts',
    '@forge-engine/kafka': '<rootDir>/../../packages/kafka/src/index.ts',
    '@forge-engine/redis': '<rootDir>/../../packages/redis/src/index.ts',
    '@forge-engine/prisma': '<rootDir>/../../packages/prisma/src/index.ts',
  },
};
```

Each service extends this in its `jest.config.ts`:
```ts
import base from '../../jest.config.base.js';
export default { ...base };
```

---

## 2. Test Helpers / Mocks

### `packages/types/src/__mocks__/redis.ts` — Mock Redis

```typescript
export const redisMock = {
  get: jest.fn(),
  set: jest.fn(),
  incr: jest.fn(),
  expire: jest.fn(),
  exists: jest.fn(),
  publish: jest.fn(),
  rpush: jest.fn(),
  lrange: jest.fn(),
  quit: jest.fn(),
  connect: jest.fn(),
};

export const redis = redisMock;
export const redisSubscriber = { ...redisMock, subscribe: jest.fn(), on: jest.fn(), off: jest.fn() };
export const RedisKeys = {
  lockJob: (id: string) => `lock:job:${id}`,
  lockWorkflow: (id: string) => `lock:workflow:${id}`,
  lockSchedulerTick: () => 'lock:scheduler:tick',
  jobState: (id: string) => `job:state:${id}`,
  jobProgress: (id: string) => `job:progress:${id}`,
  jobLogs: (id: string) => `job:logs:${id}`,
  groupTotal: (wId: string, g: string) => `workflow:${wId}:group:${g}:total`,
  groupCompleted: (wId: string, g: string) => `workflow:${wId}:group:${g}:completed`,
  rateLimitKey: (id: string) => `ratelimit:${id}`,
  heartbeat: (id: string) => `heartbeat:${id}`,
};
export const RedisTTL = {
  LOCK_JOB: 30, LOCK_WORKFLOW: 10, LOCK_SCHEDULER: 70,
  JOB_STATE: 604800, HEARTBEAT: 30, RATE_LIMIT: 60,
};
export const withLock = jest.fn(async (_key: string, _ttl: number, fn: () => Promise<unknown>) => fn());
```

### `packages/types/src/__mocks__/kafka.ts` — Mock Kafka

```typescript
export const produceMessageMock = jest.fn();
export const produceMessage = produceMessageMock;
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
};
export const kafka = {
  consumer: jest.fn(() => ({
    connect: jest.fn(),
    subscribe: jest.fn(),
    run: jest.fn(),
    disconnect: jest.fn(),
  })),
};
export const initKafkaTopics = jest.fn();
```

---

## 3. Unit Tests — Orchestrator

### `apps/orchestrator/src/__tests__/backoff.test.ts`

```typescript
import { computeBackoffMs } from '../lib/backoff';

describe('computeBackoffMs', () => {
  test('fixed: always returns baseDelay', () => {
    expect(computeBackoffMs('fixed', 1, 1000)).toBe(1000);
    expect(computeBackoffMs('fixed', 5, 1000)).toBe(1000);
  });

  test('linear: returns attempt * baseDelay', () => {
    expect(computeBackoffMs('linear', 1, 1000)).toBe(1000);
    expect(computeBackoffMs('linear', 3, 1000)).toBe(3000);
  });

  test('exponential: doubles each attempt, capped at 5 minutes', () => {
    expect(computeBackoffMs('exponential', 1, 1000)).toBe(2000);
    expect(computeBackoffMs('exponential', 2, 1000)).toBe(4000);
    expect(computeBackoffMs('exponential', 10, 1000)).toBe(300_000); // capped
  });
});
```

### `apps/orchestrator/src/__tests__/step-resolver.test.ts`

```typescript
import { resolveReadySteps, resolveFirstSteps } from '../lib/step-resolver';

const makeStep = (id: string, dependsOn: string[], status = 'PENDING') => ({
  id, dependsOn, status,
  workflowId: 'wf1', name: id, jobType: id,
  parallelGroup: null, position: 0, result: null, error: null, executedAt: null,
} as any);

describe('resolveFirstSteps', () => {
  test('returns steps with empty dependsOn', () => {
    const steps = [
      makeStep('s1', []),
      makeStep('s2', ['s1']),
      makeStep('s3', []),
    ];
    const first = resolveFirstSteps(steps);
    expect(first.map(s => s.id)).toEqual(['s1', 's3']);
  });
});

describe('resolveReadySteps', () => {
  test('returns step whose single dependency just completed', () => {
    const steps = [
      makeStep('s1', [], 'COMPLETED'),
      makeStep('s2', ['s1'], 'PENDING'),
      makeStep('s3', ['s2'], 'PENDING'),
    ];
    const ready = resolveReadySteps(steps, 's1');
    expect(ready.map(s => s.id)).toEqual(['s2']);
  });

  test('does not return step whose dependencies are not all completed', () => {
    const steps = [
      makeStep('s1', [], 'COMPLETED'),
      makeStep('s2', [], 'PENDING'),             // not completed
      makeStep('s3', ['s1', 's2'], 'PENDING'),   // waits for both
    ];
    const ready = resolveReadySteps(steps, 's1');
    expect(ready).toHaveLength(0);
  });

  test('returns multiple fan-out steps simultaneously', () => {
    const steps = [
      makeStep('s1', [], 'COMPLETED'),
      makeStep('s2', ['s1'], 'PENDING'),
      makeStep('s3', ['s1'], 'PENDING'),
    ];
    const ready = resolveReadySteps(steps, 's1');
    expect(ready.map(s => s.id)).toEqual(expect.arrayContaining(['s2', 's3']));
  });
});
```

---

## 4. Unit Tests — API Service

### `apps/api/src/__tests__/auth.test.ts`

```typescript
import { buildServer } from '../server';
import crypto from 'crypto';

// Mock prisma
jest.mock('@forge-engine/prisma', () => ({
  prisma: {
    apiKey: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    job: { findUnique: jest.fn(), create: jest.fn() },
  },
}));
jest.mock('@forge-engine/redis', () => require('../../src/__mocks__/redis'));
jest.mock('@forge-engine/kafka', () => require('../../src/__mocks__/kafka'));

const { prisma } = require('@forge-engine/prisma');

describe('Auth middleware', () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    server = await buildServer();
  });

  afterAll(async () => {
    await server.close();
  });

  test('returns 401 when no Authorization header', async () => {
    const res = await server.inject({ method: 'GET', url: '/jobs/123' });
    expect(res.statusCode).toBe(401);
  });

  test('returns 401 for invalid API key', async () => {
    prisma.apiKey.findUnique.mockResolvedValue(null);
    const res = await server.inject({
      method: 'GET', url: '/jobs/123',
      headers: { Authorization: 'Bearer bad-key' },
    });
    expect(res.statusCode).toBe(401);
  });

  test('allows request with valid API key', async () => {
    const keyHash = crypto.createHash('sha256').update('good-key').digest('hex');
    prisma.apiKey.findUnique.mockResolvedValue({ id: 'key1', keyHash });
    prisma.job.findUnique.mockResolvedValue(null);

    const res = await server.inject({
      method: 'GET', url: '/jobs/nonexistent',
      headers: { Authorization: 'Bearer good-key' },
    });
    expect(res.statusCode).toBe(404);
  });
});
```

### `apps/api/src/__tests__/jobs.test.ts`

```typescript
import { buildServer } from '../server';

jest.mock('@forge-engine/prisma', () => ({
  prisma: {
    apiKey: { findUnique: jest.fn().mockResolvedValue({ id: 'k1', keyHash: '' }) },
    job: { findUnique: jest.fn(), create: jest.fn() },
  },
}));
jest.mock('@forge-engine/redis', () => require('../../src/__mocks__/redis'));
jest.mock('@forge-engine/kafka', () => require('../../src/__mocks__/kafka'));

const { prisma } = require('@forge-engine/prisma');
const { produceMessage } = require('@forge-engine/kafka');

describe('POST /jobs', () => {
  let server: any;

  beforeAll(async () => { server = await buildServer(); });
  afterAll(async () => { await server.close(); });
  beforeEach(() => { jest.clearAllMocks(); });

  test('creates a job and produces Kafka event', async () => {
    prisma.apiKey.findUnique.mockResolvedValue({ id: 'k1', keyHash: 'h1' });
    prisma.job.findUnique.mockResolvedValue(null); // no idempotency key collision
    prisma.job.create.mockResolvedValue({ id: 'job-uuid' });

    const res = await server.inject({
      method: 'POST',
      url: '/jobs',
      headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'send-email', payload: { to: 'a@b.com' } }),
    });

    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body)).toHaveProperty('jobId');
    expect(prisma.job.create).toHaveBeenCalledTimes(1);
    expect(produceMessage).toHaveBeenCalledWith('job.submitted', expect.objectContaining({ type: 'send-email' }), expect.any(String));
  });

  test('returns existing job for duplicate idempotency key', async () => {
    prisma.apiKey.findUnique.mockResolvedValue({ id: 'k1', keyHash: 'h1' });
    prisma.job.findUnique.mockResolvedValue({ id: 'existing-id' });

    const res = await server.inject({
      method: 'POST',
      url: '/jobs',
      headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'send-email', payload: {}, idempotencyKey: 'my-key' }),
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).jobId).toBe('existing-id');
    expect(prisma.job.create).not.toHaveBeenCalled();
  });
});
```

---

## 5. Unit Tests — Worker

### `apps/worker/src/__tests__/consumer.test.ts`

```typescript
import { JobContext } from '../context';

describe('JobContext', () => {
  const mockRedis = { set: jest.fn(), rpush: jest.fn(), expire: jest.fn() };
  jest.mock('@forge-engine/redis', () => ({ redis: mockRedis, RedisKeys: { jobProgress: (id: string) => `job:progress:${id}`, jobLogs: (id: string) => `job:logs:${id}` }, RedisTTL: { JOB_STATE: 604800 } }));

  test('progress clamps to 0-100', async () => {
    const ctx = new JobContext({ jobId: 'j1', data: {}, type: 't', attempt: 0 });
    await ctx.progress(150);
    expect(mockRedis.set).toHaveBeenCalledWith('job:progress:j1', 100, 'EX', 604800);
  });

  test('log appends timestamped entry', async () => {
    const ctx = new JobContext({ jobId: 'j1', data: {}, type: 't', attempt: 0 });
    await ctx.log('hello');
    expect(mockRedis.rpush).toHaveBeenCalledWith('job:logs:j1', expect.stringContaining('hello'));
  });
});
```

---

## 6. Integration Test — Full Job Flow

### `apps/worker/src/__tests__/integration/job-flow.integration.test.ts`

```typescript
/**
 * Integration test: validates the full job submission → execution → completion flow.
 * Requires running Docker Compose services (postgres, kafka, redis).
 * Run with: npm run test:integration
 *
 * Uses testcontainers if real services are not available.
 */

// ⚠️ This test requires real Kafka, Redis, and Postgres.
// Set TEST_INTEGRATION=true to run.

const RUN_INTEGRATION = process.env.TEST_INTEGRATION === 'true';

(RUN_INTEGRATION ? describe : describe.skip)('Full job flow (integration)', () => {
  let engine: any;
  let worker: any;

  beforeAll(async () => {
    // Initialize real connections
    const { JobEngine } = await import('@forge-engine/sdk');
    const { Worker } = await import('@forge-engine/sdk');

    engine = new JobEngine({
      apiUrl: process.env.API_BASE_URL ?? 'http://localhost:3000',
      apiKey: process.env.API_KEY ?? 'forge-dev-api-key-12345',
    });

    worker = new Worker();
    worker.register('test-job', async (ctx: any) => {
      await ctx.progress(100);
      return { done: true };
    });

    worker.start({ kafkaBrokers: ['localhost:9092'] });
    await new Promise((r) => setTimeout(r, 2000)); // let worker connect
  }, 30_000);

  test('submitted job completes within 5 seconds', async () => {
    const { jobId } = await engine.submitJob({
      type: 'test-job',
      payload: { foo: 'bar' },
    });

    // Poll for completion
    let status = 'pending';
    const deadline = Date.now() + 5000;
    while (status !== 'completed' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      const job = await engine.getJob(jobId);
      status = job.status;
    }

    expect(status).toBe('completed');
  }, 10_000);
});
```

---

## 7. Test Scripts in `package.json`

Add to root `package.json`:

```json
{
  "scripts": {
    "test": "turbo run test",
    "test:unit": "turbo run test -- --testPathPattern=__tests__/(?!integration)",
    "test:integration": "TEST_INTEGRATION=true turbo run test -- --testPathPattern=integration",
    "test:coverage": "turbo run test -- --coverage"
  }
}
```

---

## 8. Coverage Targets

| Service | Target Coverage |
|---|---|
| `apps/orchestrator` | 85% (critical business logic) |
| `apps/api` | 80% |
| `apps/worker` | 80% |
| `apps/scheduler` | 75% |
| `packages/types` | 60% (mostly types) |
| `packages/kafka` | 70% |
| `packages/redis` | 70% |
