import Redis from 'ioredis';

function createRedisClient(name: string): Redis {
  return new Redis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    lazyConnect: true,
    retryStrategy: (times) => Math.min(times * 100, 3000),
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    connectionName: name,
  });
}

// Main client — for general operations
export const redis = createRedisClient('orchestra-main');

// Separate subscriber client — ioredis subscriber clients cannot run other commands
export const redisSubscriber = createRedisClient('orchestra-sub');

// Redlock requires its own client instances
export const redlockClients = [createRedisClient('orchestra-lock')];
