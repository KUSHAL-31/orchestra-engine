export const redisMock = {
  get: jest.fn(),
  set: jest.fn(),
  incr: jest.fn(),
  expire: jest.fn(),
  exists: jest.fn(),
  publish: jest.fn(),
  rpush: jest.fn(),
  lrange: jest.fn(),
  quit: jest.fn(),
  connect: jest.fn(),
};

export const redis = redisMock;
export const redisSubscriber = { ...redisMock, subscribe: jest.fn(), on: jest.fn(), off: jest.fn() };
export const RedisKeys = {
  lockJob: (id: string) => `lock:job:${id}`,
  lockWorkflow: (id: string) => `lock:workflow:${id}`,
  lockSchedulerTick: () => 'lock:scheduler:tick',
  jobState: (id: string) => `job:state:${id}`,
  jobProgress: (id: string) => `job:progress:${id}`,
  jobLogs: (id: string) => `job:logs:${id}`,
  groupTotal: (wId: string, g: string) => `workflow:${wId}:group:${g}:total`,
  groupCompleted: (wId: string, g: string) => `workflow:${wId}:group:${g}:completed`,
  rateLimitKey: (id: string) => `ratelimit:${id}`,
  heartbeat: (id: string) => `heartbeat:${id}`,
};
export const RedisTTL = {
  LOCK_JOB: 30, LOCK_WORKFLOW: 10, LOCK_SCHEDULER: 70,
  JOB_STATE: 604800, HEARTBEAT: 30, RATE_LIMIT: 60,
};
export const withLock = jest.fn(async (_key: string, _ttl: number, fn: () => Promise<unknown>) => fn());
