// ─── API Request Bodies ──────────────────────────────────────────────────────

export interface SubmitJobRequest {
  type: string;
  payload: Record<string, unknown>;
  retries?: number;             // defaults to 3
  backoff?: 'fixed' | 'linear' | 'exponential';
  delay?: number;               // ms, defaults to 0
  priority?: 'low' | 'normal' | 'high' | 'critical';
  idempotencyKey?: string;
}

export interface SubmitWorkflowRequest {
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

export interface CreateScheduleRequest {
  name: string;
  type: 'cron' | 'one-shot';
  cronExpr?: string;            // required for cron
  runAt?: string;               // ISO 8601, required for one-shot
  jobType: string;
  payload: Record<string, unknown>;
}

export interface UpdateScheduleRequest {
  cronExpr?: string;
  payload?: Record<string, unknown>;
  active?: boolean;
}

// ─── API Response Bodies ─────────────────────────────────────────────────────

export interface SubmitJobResponse {
  jobId: string;
}

export interface SubmitWorkflowResponse {
  workflowId: string;
}

export interface JobDetailResponse {
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

export interface WorkflowDetailResponse {
  id: string;
  name: string;
  status: string;
  definition: unknown;
  createdAt: string;
  completedAt: string | null;
  steps: Array<{
    id: string;
    name: string;
    jobType: string;
    status: string;
    dependsOn: string[];
    parallelGroup: string | null;
    position: number;
    result: unknown;
    error: string | null;
    executedAt: string | null;
  }>;
}
