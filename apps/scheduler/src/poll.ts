import { prisma } from '@node-forge-engine/prisma';
import { withLock, RedisKeys, RedisTTL } from '@node-forge-engine/redis';
import { produceMessage, Topics } from '@node-forge-engine/kafka';
import { getNextCronDate } from './cron-utils';
import { createLogger } from '@node-forge-engine/types';
import type { ScheduleTickEvent } from '@node-forge-engine/types';

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
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('quorum')) {
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
