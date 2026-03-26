import { Kafka, Producer, Consumer, CompressionTypes, logLevel } from 'kafkajs';
import Redis from 'ioredis';
import Redlock from 'redlock';
import os from 'os';
import type { JobHandlerFn, WorkerOptions, WorkerJobContext } from './types';

// ─── Kafka topic names (mirrors the engine internals) ─────────────────────────
const Topics = {
  JOB_SUBMITTED: 'job.submitted',
  JOB_RETRY:     'job.retry',
  JOB_STARTED:   'job.started',
  JOB_COMPLETED: 'job.completed',
  JOB_FAILED:    'job.failed',
} as const;

// ─── Redis key builders (mirrors the engine internals) ────────────────────────
const Keys = {
  lockJob:     (id: string) => `lock:job:${id}`,
  jobState:    (id: string) => `job:state:${id}`,
  jobProgress: (id: string) => `job:progress:${id}`,
  jobLogs:     (id: string) => `job:logs:${id}`,
};

const JOB_STATE_TTL_S  = 7 * 24 * 60 * 60; // 7 days
const LOCK_JOB_TTL_MS  = 30_000;            // 30 seconds

type JobEvent = {
  jobId:        string;
  type:         string;
  payload:      Record<string, unknown>;
  attempt:      number;
  maxAttempts:  number;
  retryAfterMs?: number;
  workflowId?:  string;
  stepId?:      string;
};

export class Worker {
  private readonly handlers = new Map<string, JobHandlerFn>();
  private readonly workerId: string;

  private consumer: Consumer | null = null;
  private producer: Producer | null = null;
  private redisMain: Redis | null = null;
  private redisLock: Redis | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private apiUrl: string | null = null;
  private apiHeaders: Record<string, string> | null = null;

  constructor() {
    this.workerId = `sdk-worker-${os.hostname()}-${process.pid}`;
  }

  private async apiPost(path: string, body?: unknown): Promise<void> {
    if (!this.apiUrl || !this.apiHeaders) return;
    try {
      await fetch(`${this.apiUrl}${path}`, {
        method:  'POST',
        headers: this.apiHeaders,
        body:    body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      // Heartbeat failures are non-fatal — worker continues running
    }
  }

  /**
   * Register a handler for a job type.
   * Must be called before start().
   * Returns `this` so calls can be chained.
   */
  register(jobType: string, handler: JobHandlerFn): this {
    this.handlers.set(jobType, handler);
    return this;
  }

  /**
   * Connect to Kafka and Redis then start consuming jobs.
   * This call does not block — the consumer runs in the background.
   * Call stop() for graceful shutdown.
   */
  async start(options: WorkerOptions): Promise<void> {
    if (options.apiUrl && options.apiKey) {
      this.apiUrl = options.apiUrl.replace(/\/$/, '');
      this.apiHeaders = {
        'Content-Type': 'application/json',
        Authorization:  `Bearer ${options.apiKey}`,
      };

      // Register worker and start heartbeat
      await this.apiPost('/workers/register', {
        workerId: this.workerId,
        jobTypes: Array.from(this.handlers.keys()),
      });

      this.heartbeatTimer = setInterval(() => {
        this.apiPost(`/workers/${this.workerId}/heartbeat`);
      }, 10_000);
    }

    const redisConfig = {
      host:     options.redisHost ?? 'localhost',
      port:     options.redisPort ?? 6379,
      password: options.redisPassword,
      lazyConnect: true,
      retryStrategy: (times: number) => Math.min(times * 100, 3_000),
    };

    this.redisMain = new Redis(redisConfig);
    this.redisLock = new Redis(redisConfig);
    await this.redisMain.connect();
    await this.redisLock.connect();

    const redlock = new Redlock([this.redisLock], {
      driftFactor: 0.01,
      retryCount:  3,
      retryDelay:  200,
      retryJitter: 100,
    });

    redlock.on('error', (err: Error) => {
      if (!err.message.includes('quorum')) {
        console.error('[orchestra-engine-sdk] redlock error:', err.message);
      }
    });

    const kafka = new Kafka({
      clientId: options.clientId ?? 'orchestra-engine-sdk-worker',
      brokers:  options.kafkaBrokers,
      logLevel: logLevel.WARN,
      retry:    { initialRetryTime: 300, retries: 10 },
    });

    this.producer = kafka.producer({ allowAutoTopicCreation: false });
    await this.producer.connect();

    this.consumer = kafka.consumer({
      groupId: options.groupId ?? 'orchestra-sdk-workers',
    });
    await this.consumer.connect();
    await this.consumer.subscribe({
      topics:        [Topics.JOB_SUBMITTED, Topics.JOB_RETRY],
      fromBeginning: false,
    });

    const { workerId, handlers } = this;
    const redis    = this.redisMain;
    const producer = this.producer;

    await this.consumer.run({
      eachMessage: async ({ message }) => {
        if (!message.value) return;

        const event = JSON.parse(message.value.toString()) as JobEvent;
        const handler = handlers.get(event.type);
        if (!handler) return; // not our job type — skip

        // Honour retry delay before processing
        if (event.retryAfterMs && event.retryAfterMs > 0) {
          await new Promise((r) => setTimeout(r, event.retryAfterMs));
        }

        try {
          const lock = await redlock.acquire([Keys.lockJob(event.jobId)], LOCK_JOB_TTL_MS);

          try {
            // Mark job as running
            await redis.set(Keys.jobState(event.jobId), 'running', 'EX', JOB_STATE_TTL_S);
            await producer.send({
              topic:       Topics.JOB_STARTED,
              compression: CompressionTypes.GZIP,
              messages: [{
                key:   event.jobId,
                value: JSON.stringify({
                  jobId: event.jobId,
                  workerId,
                  startedAt: new Date().toISOString(),
                }),
              }],
            });

            // Build the context object the handler receives
            const ctx: WorkerJobContext = {
              jobId:   event.jobId,
              data:    event.payload,
              type:    event.type,
              attempt: event.attempt,

              progress: async (n: number) => {
                await redis.set(
                  Keys.jobProgress(event.jobId),
                  Math.min(100, Math.max(0, n)),
                  'EX',
                  JOB_STATE_TTL_S
                );
              },

              log: async (msg: string) => {
                const line = `[${new Date().toISOString()}] ${msg}`;
                await redis.rpush(Keys.jobLogs(event.jobId), line);
                await redis.expire(Keys.jobLogs(event.jobId), JOB_STATE_TTL_S);
              },
            };

            try {
              const result = await handler(ctx);

              await redis.set(Keys.jobState(event.jobId), 'completed', 'EX', JOB_STATE_TTL_S);
              await producer.send({
                topic:       Topics.JOB_COMPLETED,
                compression: CompressionTypes.GZIP,
                messages: [{
                  key:   event.jobId,
                  value: JSON.stringify({
                    jobId:       event.jobId,
                    workerId,
                    result,
                    completedAt: new Date().toISOString(),
                    workflowId:  event.workflowId,
                    stepId:      event.stepId,
                  }),
                }],
              });

            } catch (err: unknown) {
              const error = err instanceof Error ? err.message : String(err);

              await redis.set(Keys.jobState(event.jobId), 'failed', 'EX', JOB_STATE_TTL_S);
              await producer.send({
                topic:       Topics.JOB_FAILED,
                compression: CompressionTypes.GZIP,
                messages: [{
                  key:   event.jobId,
                  value: JSON.stringify({
                    jobId:       event.jobId,
                    workerId,
                    error,
                    attempt:     event.attempt,
                    maxAttempts: event.maxAttempts,
                    workflowId:  event.workflowId,
                    stepId:      event.stepId,
                  }),
                }],
              });
            }

          } finally {
            await lock.release().catch(() => {
              // Lock may have expired — safe to ignore
            });
          }

        } catch {
          // Could not acquire lock — another worker instance is handling this job
        }
      },
    });
  }

  /**
   * Gracefully disconnect Kafka consumer/producer and Redis clients.
   * Call this on SIGTERM / SIGINT.
   */
  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    await this.apiPost(`/workers/${this.workerId}/deregister`);
    await this.consumer?.disconnect();
    await this.producer?.disconnect();
    await this.redisMain?.quit();
    await this.redisLock?.quit();
  }
}
