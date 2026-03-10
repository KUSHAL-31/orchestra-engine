# 07 — Scheduler Service (`apps/scheduler`)

> **Claude Code Instruction**: The Scheduler polls Postgres every 60 seconds for due schedules and fires them as jobs via HTTP to the API Service. It uses a Redis distributed lock to guarantee exactly one scheduler instance fires due jobs across all replicas. Implement the poll loop precisely as specified.

---

## Folder Structure

```
apps/scheduler/
  package.json
  tsconfig.json
  src/
    index.ts          ← entry point + poll loop
    poll.ts           ← poll logic: query schedules, submit jobs, update next_run_at
    cron-utils.ts     ← cron expression next-run calculation
```

---

## `apps/scheduler/package.json`

```json
{
  "name": "@forge-engine/scheduler",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "ts-node-dev --respawn --transpile-only src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@forge-engine/types": "*",
    "@forge-engine/kafka": "*",
    "@forge-engine/redis": "*",
    "@forge-engine/prisma": "*",
    "cron-parser": "^4.9.0",
    "node-fetch": "^3.3.2",
    "pino": "^8.19.0",
    "pino-pretty": "^11.0.0"
  },
  "devDependencies": {
    "@types/node-fetch": "^2.6.11"
  }
}
```

---

## `src/cron-utils.ts`

```typescript
import parser from 'cron-parser';

/**
 * Given a 5-part cron expression, compute the next run date after `from`.
 */
export function getNextCronDate(cronExpr: string, from: Date = new Date()): Date {
  const interval = parser.parseExpression(cronExpr, { currentDate: from, iterator: false });
  return interval.next().toDate();
}
```

---

## `src/poll.ts`

```typescript
import { prisma } from '@forge-engine/prisma';
import { withLock, RedisKeys, RedisTTL } from '@forge-engine/redis';
import { produceMessage, Topics } from '@forge-engine/kafka';
import { getNextCronDate } from './cron-utils';
import { createLogger } from '@forge-engine/types';
import type { ScheduleTickEvent } from '@forge-engine/types';

const logger = createLogger('scheduler:poll');

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3000';
const INTERNAL_API_KEY = process.env.API_KEY_SEED ?? 'forge-dev-api-key-12345';

export async function runSchedulerPoll(): Promise<void> {
  // RULE: Acquire Redis lock BEFORE polling — INVARIANT-005
  // TTL is 70s (slightly longer than the 60s poll interval)
  try {
    await withLock(
      RedisKeys.lockSchedulerTick(),
      RedisTTL.LOCK_SCHEDULER * 1000,
      async () => {
        await executeSchedulerPoll();
      }
    );
  } catch (err: any) {
    if (err.message?.includes('quorum')) {
      // Another scheduler instance holds the lock — this is expected
      logger.debug('Scheduler lock held by another instance — skipping tick');
    } else {
      logger.error(err, 'Unexpected scheduler error');
    }
  }
}

async function executeSchedulerPoll(): Promise<void> {
  const now = new Date();

  // Query all due schedules
  const dueSchedules = await prisma.schedule.findMany({
    where: {
      active: true,
      nextRunAt: { lte: now },
    },
  });

  if (dueSchedules.length === 0) {
    logger.debug('No due schedules');
    return;
  }

  logger.info({ count: dueSchedules.length }, 'Firing due schedules');

  for (const schedule of dueSchedules) {
    try {
      // Submit job via HTTP to API Service
      const response = await fetch(`${API_BASE_URL}/jobs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${INTERNAL_API_KEY}`,
        },
        body: JSON.stringify({
          type: schedule.jobType,
          payload: schedule.payload,
          idempotencyKey: `schedule:${schedule.id}:${now.toISOString()}`,
        }),
      });

      if (!response.ok) {
        logger.error({ scheduleId: schedule.id, status: response.status }, 'Failed to submit schedule job');
        continue;
      }

      // Emit schedule.tick to Kafka for audit
      await produceMessage<ScheduleTickEvent>(
        Topics.SCHEDULE_TICK,
        { scheduleId: schedule.id, jobType: schedule.jobType, firedAt: now.toISOString() },
        schedule.id
      );

      // Update schedule state
      if (schedule.type === 'CRON' && schedule.cronExpr) {
        const nextRunAt = getNextCronDate(schedule.cronExpr, now);
        await prisma.schedule.update({
          where: { id: schedule.id },
          data: { lastRunAt: now, nextRunAt },
        });
      } else {
        // ONE_SHOT: deactivate after firing
        await prisma.schedule.update({
          where: { id: schedule.id },
          data: { lastRunAt: now, active: false },
        });
      }

      logger.info({ scheduleId: schedule.id, jobType: schedule.jobType }, 'Schedule fired');
    } catch (err) {
      logger.error({ err, scheduleId: schedule.id }, 'Error processing schedule');
    }
  }
}
```

---

## `src/index.ts`

```typescript
import 'dotenv/config';
import { initKafkaTopics } from '@forge-engine/kafka';
import { redis } from '@forge-engine/redis';
import { runSchedulerPoll } from './poll';
import { createLogger } from '@forge-engine/types';

const logger = createLogger('scheduler');

const POLL_INTERVAL_MS = parseInt(
  process.env.SCHEDULER_POLL_INTERVAL_MS ?? '60000', 10
);

async function main() {
  await initKafkaTopics();
  await redis.connect();

  logger.info({ pollIntervalMs: POLL_INTERVAL_MS }, 'Scheduler Service starting');

  // Run immediately on startup, then on interval
  await runSchedulerPoll();
  const interval = setInterval(runSchedulerPoll, POLL_INTERVAL_MS);

  const shutdown = async () => {
    logger.info('Shutting down scheduler...');
    clearInterval(interval);
    await redis.quit();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  logger.info('Scheduler Service started');
}

main().catch((err) => {
  logger.error(err, 'Failed to start Scheduler');
  process.exit(1);
});
```

---

## Key Implementation Rules

1. **Lock before poll**: `lock:scheduler:tick` with TTL 70s. If the previous poll is still running when the next interval fires, the lock prevents duplicate execution.
2. **Idempotency key**: Each schedule submission includes `schedule:{id}:{timestamp}` as idempotency key to prevent double-firing if the scheduler restarts mid-poll.
3. **Direct HTTP vs Kafka**: The Scheduler submits jobs via HTTP to the API Service (not directly to Kafka). This reuses the API's validation logic and ensures Postgres write happens before Kafka produce (INVARIANT-001).
4. **Cron next_run_at**: After firing, immediately compute the next scheduled time using `cron-parser`. This prevents clock drift from accumulating.
5. **One-shot cleanup**: One-shot schedules are deactivated (`active = false`) after firing, not deleted. This preserves the audit trail.
