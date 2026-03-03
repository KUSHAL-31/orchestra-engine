// ── Redis Pub/Sub channel names
// ── API Service subscribes to these; workers/orchestrator publish to them

export const PubSubChannels = {
  JOB_EVENTS: 'job.events',
  WORKFLOW_EVENTS: 'workflow.events',
} as const;
