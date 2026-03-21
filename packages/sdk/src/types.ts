// ─── JobEngine (client-side) ──────────────────────────────────────────────────

export interface JobEngineOptions {
  /** Base URL of the Forge Engine API, e.g. 'http://localhost:3000' */
  apiUrl: string;
  /** API key — sent as Bearer token on every request */
  apiKey: string;
}

export interface SubmitJobOptions {
  /** The job type — must match a registered handler in your worker */
  type: string;
  /** Arbitrary data passed to the handler via ctx.data */
  payload: Record<string, unknown>;
  /** Number of retry attempts on failure (default: 3) */
  retries?: number;
  /** Backoff strategy between retries */
  backoff?: 'fixed' | 'linear' | 'exponential';
  /** Delay before the first execution in milliseconds */
  delayMs?: number;
  /** Job priority */
  priority?: 'low' | 'normal' | 'high' | 'critical';
  /**
   * Unique key to deduplicate submissions.
   * Submitting the same key twice returns the existing job, no duplicate created.
   */
  idempotencyKey?: string;
}

export interface SubmitWorkflowOptions {
  /** Human-readable name for the workflow */
  name: string;
  steps: Array<{
    /** Unique step name within this workflow */
    name: string;
    /** Job type — must match a registered handler */
    type: string;
    /** Payload passed to the handler for this step */
    payload: Record<string, unknown>;
    /** Step names this step must wait for before running */
    dependsOn?: string[];
    /** Steps sharing the same group run in parallel */
    parallelGroup?: string;
  }>;
  /** Job to run automatically if the workflow reaches failed state */
  onFailure?: {
    type: string;
    payload: Record<string, unknown>;
  };
}

export interface JobStatus {
  id: string;
  type: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'retrying' | 'dead';
  progress: number;
  attempts: number;
  maxAttempts: number;
  result: unknown;
  error: string | null;
  logs: string[];
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface WorkflowStatus {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  steps: Array<{
    id: string;
    name: string;
    jobType: string;
    status: string;
    dependsOn: string[];
    parallelGroup: string | null;
    executedAt: string | null;
  }>;
  createdAt: string;
  completedAt: string | null;
}

export type CreateScheduleOptions =
  | {
      /** Human-readable name for this schedule */
      name: string;
      type: 'cron';
      /** Standard 5-part cron expression, e.g. "0 8 * * *" */
      cronExpr: string;
      /** Job type to submit on each tick */
      jobType: string;
      /** Payload passed to the job handler */
      payload?: Record<string, unknown>;
    }
  | {
      name: string;
      type: 'one_shot';
      /** ISO 8601 datetime — fires once at this exact time */
      runAt: string;
      jobType: string;
      payload?: Record<string, unknown>;
    };

export interface ScheduleStatus {
  id: string;
  name: string;
  type: 'CRON' | 'ONE_SHOT';
  cronExpr: string | null;
  runAt: string | null;
  nextRunAt: string;
  jobType: string;
  payload: Record<string, unknown>;
  active: boolean;
  createdAt: string;
}

// ─── Worker (server-side) ─────────────────────────────────────────────────────

export interface WorkerOptions {
  /** Kafka broker addresses, e.g. ['localhost:9092'] */
  kafkaBrokers: string[];
  /** Redis host (default: 'localhost') */
  redisHost?: string;
  /** Redis port (default: 6379) */
  redisPort?: number;
  /** Redis password if auth is enabled */
  redisPassword?: string;
  /** Kafka consumer group ID (default: 'forge-sdk-workers') */
  groupId?: string;
  /** Kafka client ID (default: 'forge-engine-sdk-worker') */
  clientId?: string;
}

export type JobHandlerFn = (ctx: WorkerJobContext) => Promise<unknown>;

export interface WorkerJobContext {
  /** The unique job ID */
  jobId: string;
  /** The payload submitted with the job */
  data: Record<string, unknown>;
  /** The job type string */
  type: string;
  /** Which attempt this is, starting at 1 */
  attempt: number;
  /** Report progress 0–100. Visible in the dashboard in real time. */
  progress(percent: number): Promise<void>;
  /** Append a log line. Visible in the job detail view. */
  log(message: string): Promise<void>;
}
