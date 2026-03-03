// ── NEVER use raw strings for topic names in service code.
// ── Always import from this module.

export const Topics = {
  JOB_SUBMITTED: 'job.submitted',
  JOB_RETRY: 'job.retry',
  JOB_STARTED: 'job.started',
  JOB_COMPLETED: 'job.completed',
  JOB_FAILED: 'job.failed',
  JOB_DLQ: 'job.dlq',
  WORKFLOW_CREATED: 'workflow.created',
  WORKFLOW_STEP_DONE: 'workflow.step.done',
  WORKFLOW_COMPLETED: 'workflow.completed',
  SCHEDULE_TICK: 'schedule.tick',
} as const;

export type TopicName = (typeof Topics)[keyof typeof Topics];
