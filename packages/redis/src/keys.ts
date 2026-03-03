// ── ALL Redis key patterns in the system.
// ── Always use these builder functions. Never use raw strings.

export const RedisKeys = {
  // Distributed locks
  lockJob: (jobId: string) => `lock:job:${jobId}`,
  lockWorkflow: (workflowId: string) => `lock:workflow:${workflowId}`,
  lockSchedulerTick: () => `lock:scheduler:tick`,

  // Job state cache
  jobState: (jobId: string) => `job:state:${jobId}`,
  jobProgress: (jobId: string) => `job:progress:${jobId}`,
  jobLogs: (jobId: string) => `job:logs:${jobId}`,

  // Parallel group fan-in counters
  groupTotal: (workflowId: string, group: string) =>
    `workflow:${workflowId}:group:${group}:total`,
  groupCompleted: (workflowId: string, group: string) =>
    `workflow:${workflowId}:group:${group}:completed`,

  // Rate limiting
  rateLimitKey: (apiKeyId: string) => `ratelimit:${apiKeyId}`,

  // Worker heartbeats
  heartbeat: (workerId: string) => `heartbeat:${workerId}`,
};

// TTL constants in seconds
export const RedisTTL = {
  LOCK_JOB: 30,
  LOCK_WORKFLOW: 10,
  LOCK_SCHEDULER: 70,
  JOB_STATE: 7 * 24 * 60 * 60, // 7 days
  HEARTBEAT: 30,
  RATE_LIMIT: 60,
};
