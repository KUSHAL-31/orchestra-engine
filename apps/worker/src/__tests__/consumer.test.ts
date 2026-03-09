import { JobContext } from '../context';

describe('JobContext', () => {
  const mockRedis = { set: jest.fn(), rpush: jest.fn(), expire: jest.fn() };
  jest.mock('@forge-engine/redis', () => ({ redis: mockRedis, RedisKeys: { jobProgress: (id: string) => `job:progress:${id}`, jobLogs: (id: string) => `job:logs:${id}` }, RedisTTL: { JOB_STATE: 604800 } }));

  test('progress clamps to 0-100', async () => {
    const ctx = new JobContext({ jobId: 'j1', data: {}, type: 't', attempt: 0 });
    await ctx.progress(150);
    expect(mockRedis.set).toHaveBeenCalledWith('job:progress:j1', 100, 'EX', 604800);
  });

  test('log appends timestamped entry', async () => {
    const ctx = new JobContext({ jobId: 'j1', data: {}, type: 't', attempt: 0 });
    await ctx.log('hello');
    expect(mockRedis.rpush).toHaveBeenCalledWith('job:logs:j1', expect.stringContaining('hello'));
  });
});
