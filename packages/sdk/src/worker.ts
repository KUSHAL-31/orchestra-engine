import { kafka, Topics, produceMessage } from '@node-forge-engine/kafka';
import { redis, withLock, RedisKeys, RedisTTL } from '@node-forge-engine/redis';
import type { JobHandlerFn, WorkerJobContext, WorkerOptions } from './types';
import type { JobSubmittedEvent, JobRetryEvent, JobStartedEvent, JobCompletedEvent, JobFailedEvent } from '@node-forge-engine/types';
import os from 'os';

type AnyJobEvent = (JobSubmittedEvent | JobRetryEvent) & { attempt: number };

export class Worker {
  private handlers = new Map<string, JobHandlerFn>();
  private workerId = `sdk-worker-${os.hostname()}-${process.pid}`;

  /**
   * Register a handler function for a specific job type.
   * Call this before worker.start().
   */
  register(jobType: string, handler: JobHandlerFn): this {
    this.handlers.set(jobType, handler);
    return this;
  }

  /**
   * Start consuming jobs from Kafka. Blocks until stop() is called.
   */
  async start(options: WorkerOptions): Promise<void> {
    await redis.connect();

    const consumer = kafka.consumer({
      groupId: options.groupId ?? 'workers',
    });
    await consumer.connect();
    await consumer.subscribe({
      topics: [Topics.JOB_SUBMITTED, Topics.JOB_RETRY],
      fromBeginning: false,
    });

    const workerId = this.workerId;
    const handlers = this.handlers;

    await consumer.run({
      eachMessage: async ({ message }) => {
        if (!message.value) return;
        const event = JSON.parse(message.value.toString()) as AnyJobEvent;

        const handler = handlers.get(event.type);
        if (!handler) return;

        if ('retryAfterMs' in event && event.retryAfterMs > 0) {
          await new Promise((r) => setTimeout(r, event.retryAfterMs));
        }

        try {
          await withLock(RedisKeys.lockJob(event.jobId), RedisTTL.LOCK_JOB * 1000, async () => {
            await redis.set(RedisKeys.jobState(event.jobId), 'running', 'EX', RedisTTL.JOB_STATE);
            await produceMessage<JobStartedEvent>(Topics.JOB_STARTED, {
              jobId: event.jobId, workerId, startedAt: new Date().toISOString(),
            }, event.jobId);

            const ctx: WorkerJobContext = {
              jobId: event.jobId,
              data: event.payload,
              type: event.type,
              attempt: event.attempt,
              progress: async (n: number) => {
                await redis.set(RedisKeys.jobProgress(event.jobId), Math.min(100, Math.max(0, n)), 'EX', RedisTTL.JOB_STATE);
              },
              log: async (msg: string) => {
                await redis.rpush(RedisKeys.jobLogs(event.jobId), `[${new Date().toISOString()}] ${msg}`);
                await redis.expire(RedisKeys.jobLogs(event.jobId), RedisTTL.JOB_STATE);
              },
            };

            try {
              const result = await handler(ctx);
              await redis.set(RedisKeys.jobState(event.jobId), 'completed', 'EX', RedisTTL.JOB_STATE);
              await produceMessage<JobCompletedEvent>(Topics.JOB_COMPLETED, {
                jobId: event.jobId, workerId, result, completedAt: new Date().toISOString(),
                workflowId: event.workflowId, stepId: event.stepId,
              }, event.jobId);
            } catch (err: unknown) {
              const errorMessage = err instanceof Error ? err.message : String(err);
              await redis.set(RedisKeys.jobState(event.jobId), 'failed', 'EX', RedisTTL.JOB_STATE);
              await produceMessage<JobFailedEvent>(Topics.JOB_FAILED, {
                jobId: event.jobId, workerId, error: errorMessage,
                attempt: event.attempt, maxAttempts: event.maxAttempts,
                workflowId: event.workflowId, stepId: event.stepId,
              }, event.jobId);
            }
          });
        } catch {
          // Lock not acquired — another worker handling this job
        }
      },
    });
  }
}
