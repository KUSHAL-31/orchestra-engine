export interface JobEngineOptions {
  apiUrl: string;       // Base URL of the API service, e.g. 'http://localhost:3000'
  apiKey: string;       // Raw API key (will be sent as Bearer token)
}

export interface SubmitJobOptions {
  type: string;
  payload: Record<string, unknown>;
  retries?: number;
  backoff?: 'fixed' | 'linear' | 'exponential';
  delayMs?: number;
  priority?: 'low' | 'normal' | 'high' | 'critical';
  idempotencyKey?: string;
}

export interface SubmitWorkflowOptions {
  name: string;
  steps: Array<{
    name: string;
    type: string;
    payload: Record<string, unknown>;
    dependsOn?: string[];
    parallelGroup?: string;
  }>;
  onFailure?: {
    type: string;
    payload: Record<string, unknown>;
  };
}

export interface JobStatus {
  id: string;
  type: string;
  status: string;
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
  status: string;
  steps: Array<{
    id: string;
    name: string;
    jobType: string;
    status: string;
    dependsOn: string[];
    parallelGroup: string | null;
  }>;
  createdAt: string;
  completedAt: string | null;
}

export type JobHandlerFn = (ctx: WorkerJobContext) => Promise<unknown>;

export interface WorkerJobContext {
  jobId: string;
  data: Record<string, unknown>;
  type: string;
  attempt: number;
  progress(percent: number): Promise<void>;
  log(message: string): Promise<void>;
}

export interface WorkerOptions {
  kafkaBrokers: string[];
  redisHost?: string;
  redisPort?: number;
  groupId?: string;
  concurrency?: number;
}
