import { kafka, Topics, produceMessage } from '@forge-engine/kafka';
import { redis, withLock, RedisKeys, RedisTTL } from '@forge-engine/redis';
import { JobContext, JobHandler } from './context';
import { getWorkerId } from './heartbeat';
import { createLogger } from '@forge-engine/types';
import type { JobSubmittedEvent, JobRetryEvent, JobStartedEvent, JobCompletedEvent, JobFailedEvent } from '@forge-engine/types';

const logger = createLogger('worker:consumer');

type AnyJobEvent = (JobSubmittedEvent | JobRetryEvent) & { attempt: number };

export async function startWorkerConsumer(handlers: Map<string, JobHandler>) {
  const consumer = kafka.consumer({ groupId: process.env.KAFKA_GROUP_ID_WORKER ?? 'workers' });
  await consumer.connect();

  await consumer.subscribe({
    topics: [Topics.JOB_SUBMITTED, Topics.JOB_RETRY],
    fromBeginning: false,
  });

  const workerId = getWorkerId();

  await consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;

      const event = JSON.parse(message.value.toString()) as AnyJobEvent;

      // Step 1: Check if this worker has a handler for this job type
      const handler = handlers.get(event.type);
      if (!handler) {
        logger.debug({ type: event.type }, 'No handler registered — skipping');
        return;
      }

      // Step 2: Handle delayed jobs (job.retry with retryAfterMs)
      if ('retryAfterMs' in event && event.retryAfterMs > 0) {
        await new Promise((res) => setTimeout(res, event.retryAfterMs));
      }

      // Step 3: Acquire Redlock — RULE-6: second layer of safety
      const lockKey = RedisKeys.lockJob(event.jobId);

      try {
        await withLock(lockKey, RedisTTL.LOCK_JOB * 1000, async () => {
          // Step 4: Emit job.started
          await redis.set(RedisKeys.jobState(event.jobId), 'running', 'EX', RedisTTL.JOB_STATE);
          await produceMessage<JobStartedEvent>(Topics.JOB_STARTED, {
            jobId: event.jobId,
            workerId,
            startedAt: new Date().toISOString(),
          }, event.jobId);

          // Step 5: Execute handler with JobContext
          const ctx = new JobContext({
            jobId: event.jobId,
            data: event.payload,
            type: event.type,
            attempt: event.attempt,
          });

          try {
            const result = await handler(ctx);

            // Step 6: On success
            await redis.set(RedisKeys.jobState(event.jobId), 'completed', 'EX', RedisTTL.JOB_STATE);
            await produceMessage<JobCompletedEvent>(Topics.JOB_COMPLETED, {
              jobId: event.jobId,
              workerId,
              result,
              completedAt: new Date().toISOString(),
              workflowId: event.workflowId,
              stepId: event.stepId,
            }, event.jobId);

            logger.info({ jobId: event.jobId, type: event.type }, 'Job completed');
          } catch (err: unknown) {
            // Step 7: On handler throw
            const errorMessage = err instanceof Error ? err.message : String(err);
            await redis.set(RedisKeys.jobState(event.jobId), 'failed', 'EX', RedisTTL.JOB_STATE);
            await produceMessage<JobFailedEvent>(Topics.JOB_FAILED, {
              jobId: event.jobId,
              workerId,
              error: errorMessage,
              attempt: event.attempt,
              maxAttempts: event.maxAttempts,
              workflowId: event.workflowId,
              stepId: event.stepId,
            }, event.jobId);

            logger.warn({ jobId: event.jobId, error: errorMessage }, 'Job failed');
          }
        });
      } catch {
        // Lock acquisition failed — another worker is executing this job
        logger.debug({ jobId: event.jobId }, 'Could not acquire lock — skipping');
      }
    },
  });

  return consumer;
}
