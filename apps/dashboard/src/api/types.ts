export interface Job {
  id: string;
  type: string;
  status: string;
  progress: number;
  attempts: number;
  maxAttempts: number;
  result: unknown;
  error: string | null;
  logs?: unknown;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  [key: string]: unknown;
}

export interface WorkflowStep {
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
}

export interface Workflow {
  id: string;
  name: string;
  status: string;
  definition: unknown;
  steps: unknown;
  createdAt: string;
  completedAt: string | null;
  [key: string]: unknown;
}

export interface Schedule {
  id: string;
  name: string;
  type: string;
  cronExpr: string | null;
  jobType: string;
  payload: unknown;
  active: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  createdAt: string;
}

export interface DLQEntry {
  id: string;
  jobId: string;
  jobType: string;
  payload: unknown;
  errorHistory: string[];
  movedAt: string;
  replayedAt: string | null;
}

export interface Worker {
  id: string;
  jobTypes: string[];
  status: string;
  isAlive: boolean;
  lastHeartbeat: string;
  registeredAt: string;
}
