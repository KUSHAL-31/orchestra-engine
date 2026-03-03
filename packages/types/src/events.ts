// ─── Kafka Event Payloads ────────────────────────────────────────────────────
// These are the exact shapes for every Kafka message in the system.

export interface JobSubmittedEvent {
  jobId: string;
  type: string;
  payload: Record<string, unknown>;
  priority: string;
  delayMs: number;
  maxAttempts: number;
  backoff: string;
  workflowId?: string;
  stepId?: string;
  attempt: number;
}

export interface JobRetryEvent {
  jobId: string;
  type: string;
  payload: Record<string, unknown>;
  attempt: number;
  retryAfterMs: number;
  workflowId?: string;
  stepId?: string;
}

export interface JobStartedEvent {
  jobId: string;
  workerId: string;
  startedAt: string; // ISO 8601
}

export interface JobCompletedEvent {
  jobId: string;
  workerId: string;
  result: unknown;
  completedAt: string; // ISO 8601
  workflowId?: string;
  stepId?: string;
}

export interface JobFailedEvent {
  jobId: string;
  workerId: string;
  error: string;
  attempt: number;
  maxAttempts: number;
  workflowId?: string;
  stepId?: string;
}

export interface JobDlqEvent {
  jobId: string;
  type: string;
  payload: Record<string, unknown>;
  errorHistory: Array<{
    attempt: number;
    error: string;
    failedAt: string;
  }>;
}

export interface WorkflowCreatedEvent {
  workflowId: string;
  definition: WorkflowDefinition;
}

export interface WorkflowStepDoneEvent {
  workflowId: string;
  stepId: string;
  stepName: string;
  status: string;
  parallelGroup?: string;
}

export interface WorkflowCompletedEvent {
  workflowId: string;
  status: string;
  completedAt: string; // ISO 8601
}

export interface ScheduleTickEvent {
  scheduleId: string;
  jobType: string;
  firedAt: string; // ISO 8601
}

// ─── Workflow Definition ─────────────────────────────────────────────────────

export interface WorkflowDefinition {
  name: string;
  steps: WorkflowStepDefinition[];
  onFailure?: {
    type: string;
    payload: Record<string, unknown>;
  };
}

export interface WorkflowStepDefinition {
  name: string;
  type: string;
  payload: Record<string, unknown>;
  dependsOn?: string[];        // array of step names (not IDs at definition time)
  parallelGroup?: string;
}
