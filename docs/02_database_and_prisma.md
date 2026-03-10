# 02 — Database Schema & Prisma Setup

> **Claude Code Instruction**: Implement the entire `packages/prisma` package from this document. Use exactly the field names and types specified. Do not add or remove fields. All services import the Prisma client from this shared package.

---

## 1. Package Structure

```
packages/prisma/
  package.json
  tsconfig.json
  prisma/
    schema.prisma       ← single source of truth
    seed.ts             ← seed initial API key
  src/
    index.ts            ← exports PrismaClient instance
```

## 2. `packages/prisma/package.json`

```json
{
  "name": "@forge-engine/prisma",
  "version": "1.0.0",
  "private": true,
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "generate": "prisma generate",
    "migrate": "prisma migrate dev",
    "migrate:deploy": "prisma migrate deploy",
    "seed": "ts-node prisma/seed.ts",
    "build": "tsc",
    "studio": "prisma studio"
  },
  "dependencies": {
    "@prisma/client": "^5.13.0"
  },
  "devDependencies": {
    "prisma": "^5.13.0",
    "ts-node": "^10.9.0"
  }
}
```

---

## 3. Prisma Schema (`packages/prisma/prisma/schema.prisma`)

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// ─── Jobs ──────────────────────────────────────────────────────────────────

model Job {
  id              String    @id @default(uuid())
  type            String
  payload         Json
  status          JobStatus @default(PENDING)
  priority        Priority  @default(NORMAL)
  attempts        Int       @default(0)
  maxAttempts     Int       @default(3)
  backoff         Backoff   @default(EXPONENTIAL)
  delayMs         Int       @default(0)
  idempotencyKey  String?   @unique
  result          Json?
  error           String?
  workflowId      String?
  stepId          String?
  createdAt       DateTime  @default(now())
  startedAt       DateTime?
  completedAt     DateTime?

  workflow        Workflow?     @relation(fields: [workflowId], references: [id])
  step            WorkflowStep? @relation(fields: [stepId], references: [id])
  deadLetterEntry DeadLetterQueue?

  @@index([status])
  @@index([workflowId])
  @@index([idempotencyKey])
  @@index([createdAt])
  @@map("jobs")
}

enum JobStatus {
  PENDING
  RUNNING
  COMPLETED
  FAILED
  RETRYING
  DEAD

  @@map("job_status")
}

enum Priority {
  LOW
  NORMAL
  HIGH
  CRITICAL

  @@map("priority")
}

enum Backoff {
  FIXED
  LINEAR
  EXPONENTIAL

  @@map("backoff")
}

// ─── Workflows ─────────────────────────────────────────────────────────────

model Workflow {
  id          String          @id @default(uuid())
  name        String
  status      WorkflowStatus  @default(PENDING)
  definition  Json
  createdAt   DateTime        @default(now())
  completedAt DateTime?

  steps       WorkflowStep[]
  jobs        Job[]

  @@index([status])
  @@index([createdAt])
  @@map("workflows")
}

enum WorkflowStatus {
  PENDING
  RUNNING
  COMPLETED
  FAILED

  @@map("workflow_status")
}

// ─── Workflow Steps ─────────────────────────────────────────────────────────

model WorkflowStep {
  id            String      @id @default(uuid())
  workflowId    String
  name          String
  jobType       String
  status        StepStatus  @default(PENDING)
  dependsOn     String[]    @default([])
  parallelGroup String?
  position      Int
  result        Json?
  error         String?
  executedAt    DateTime?

  workflow      Workflow    @relation(fields: [workflowId], references: [id])
  jobs          Job[]

  @@index([workflowId])
  @@index([status])
  @@map("workflow_steps")
}

enum StepStatus {
  PENDING
  RUNNING
  COMPLETED
  FAILED
  SKIPPED

  @@map("step_status")
}

// ─── Schedules ──────────────────────────────────────────────────────────────

model Schedule {
  id         String       @id @default(uuid())
  name       String
  type       ScheduleType
  cronExpr   String?
  runAt      DateTime?
  nextRunAt  DateTime
  jobType    String
  payload    Json
  active     Boolean      @default(true)
  createdAt  DateTime     @default(now())
  lastRunAt  DateTime?

  @@index([active, nextRunAt])
  @@map("schedules")
}

enum ScheduleType {
  CRON
  ONE_SHOT

  @@map("schedule_type")
}

// ─── Dead Letter Queue ──────────────────────────────────────────────────────

model DeadLetterQueue {
  id           String    @id @default(uuid())
  jobId        String    @unique
  jobType      String
  payload      Json
  errorHistory Json[]    @default([])
  movedAt      DateTime  @default(now())
  replayedAt   DateTime?

  job          Job       @relation(fields: [jobId], references: [id])

  @@index([movedAt])
  @@map("dead_letter_queue")
}

// ─── Audit Log ──────────────────────────────────────────────────────────────

model AuditLog {
  id          String     @id @default(uuid())
  entityType  EntityType
  entityId    String
  fromStatus  String?
  toStatus    String
  metadata    Json?
  occurredAt  DateTime   @default(now())

  @@index([entityId])
  @@index([occurredAt])
  @@map("audit_log")
}

enum EntityType {
  JOB
  WORKFLOW
  SCHEDULE

  @@map("entity_type")
}

// ─── Workers ────────────────────────────────────────────────────────────────

model Worker {
  id            String       @id
  jobTypes      String[]     @default([])
  status        WorkerStatus @default(ACTIVE)
  lastHeartbeat DateTime
  registeredAt  DateTime     @default(now())

  @@index([status])
  @@map("workers")
}

enum WorkerStatus {
  ACTIVE
  DEAD

  @@map("worker_status")
}

// ─── API Keys ────────────────────────────────────────────────────────────────

model ApiKey {
  id         String    @id @default(uuid())
  keyHash    String    @unique
  label      String
  createdAt  DateTime  @default(now())
  lastUsedAt DateTime?

  @@map("api_keys")
}
```

---

## 4. Prisma Client Singleton (`packages/prisma/src/index.ts`)

```typescript
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === 'development'
        ? ['query', 'info', 'warn', 'error']
        : ['warn', 'error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export * from '@prisma/client';
```

---

## 5. Seed Script (`packages/prisma/prisma/seed.ts`)

```typescript
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

const prisma = new PrismaClient();

async function main() {
  const rawKey = 'forge-dev-api-key-12345';
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

  await prisma.apiKey.upsert({
    where: { keyHash },
    update: {},
    create: {
      keyHash,
      label: 'Development API Key',
    },
  });

  console.log('✅ Seeded database');
  console.log(`📋 Dev API Key: Bearer ${rawKey}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
```

---

## 6. Important Schema Notes for Claude Code

- **Enum naming**: Prisma enums use SCREAMING_SNAKE_CASE. The `@@map` annotations map them to snake_case in Postgres (e.g., `JobStatus.PENDING` maps to `job_status.PENDING`).
- **`dependsOn` field**: Stored as `String[]` (Postgres array of step UUIDs). The Orchestrator resolves these at runtime.
- **`errorHistory` in DeadLetterQueue**: Stored as `Json[]`. Each element has shape: `{ attempt: number, error: string, failedAt: string }`.
- **`definition` in Workflow**: Full submitted definition stored as JSON for audit purposes.
- **`payload` in WorkflowStep**: Step-specific payload comes from the workflow definition at submit time; the step itself doesn't store payload (it comes from the `Job` record).
- **Indexes**: All status fields and `createdAt` are indexed. `workflowId` on jobs is indexed. `(active, nextRunAt)` on schedules is composite-indexed for Scheduler poll query.

---

## 7. Audit Log Helper Function

Create `packages/prisma/src/audit.ts`:

```typescript
import { prisma } from './index';
import { EntityType } from '@prisma/client';

export async function writeAuditLog(params: {
  entityType: EntityType;
  entityId: string;
  fromStatus?: string;
  toStatus: string;
  metadata?: Record<string, unknown>;
}) {
  await prisma.auditLog.create({
    data: {
      entityType: params.entityType,
      entityId: params.entityId,
      fromStatus: params.fromStatus,
      toStatus: params.toStatus,
      metadata: params.metadata,
    },
  });
}
```

This must be called by the Orchestrator and API Service on **every** status transition.

---

## 8. Database Operations Reference

### Query patterns used across services:

```typescript
// Scheduler: find due schedules
const dueSchedules = await prisma.schedule.findMany({
  where: {
    active: true,
    nextRunAt: { lte: new Date() },
  },
});

// Orchestrator: find next workflow steps
const nextSteps = await prisma.workflowStep.findMany({
  where: {
    workflowId: workflowId,
    status: 'PENDING',
    dependsOn: { hasSome: [completedStepId] },
  },
});
// Note: "hasSome" checks if the array overlaps. Additional filtering
// needed to check ALL dependsOn are completed — see orchestrator doc.

// API: job status (cache-first)
// 1. Try Redis GET job:state:{jobId}
// 2. If miss: prisma.job.findUnique({ where: { id: jobId } })

// Worker: register on startup
await prisma.worker.upsert({
  where: { id: workerId },
  update: { status: 'ACTIVE', lastHeartbeat: new Date() },
  create: {
    id: workerId,
    jobTypes: registeredHandlerNames,
    status: 'ACTIVE',
    lastHeartbeat: new Date(),
  },
});
```
