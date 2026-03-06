import { redis, RedisKeys, RedisTTL } from '@forge-engine/redis';

export interface JobContextData {
  jobId: string;
  data: Record<string, unknown>;
  type: string;
  attempt: number;
}

export class JobContext {
  readonly jobId: string;
  readonly data: Record<string, unknown>;
  readonly type: string;
  readonly attempt: number;

  constructor(params: JobContextData) {
    this.jobId = params.jobId;
    this.data = params.data;
    this.type = params.type;
    this.attempt = params.attempt;
  }

  /**
   * Update job progress (0-100). Stored in Redis immediately.
   */
  async progress(percent: number): Promise<void> {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    await redis.set(
      RedisKeys.jobProgress(this.jobId),
      clamped,
      'EX',
      RedisTTL.JOB_STATE
    );
  }

  /**
   * Append a log message to the job's Redis log list.
   */
  async log(message: string): Promise<void> {
    const entry = `[${new Date().toISOString()}] ${message}`;
    await redis.rpush(RedisKeys.jobLogs(this.jobId), entry);
    await redis.expire(RedisKeys.jobLogs(this.jobId), RedisTTL.JOB_STATE);
  }
}

export type JobHandler = (ctx: JobContext) => Promise<unknown>;
