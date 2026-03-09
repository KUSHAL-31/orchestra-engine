import { buildServer } from '../server';

jest.mock('@forge-engine/prisma', () => ({
  prisma: {
    apiKey: { findUnique: jest.fn().mockResolvedValue({ id: 'k1', keyHash: '' }) },
    job: { findUnique: jest.fn(), create: jest.fn() },
  },
}));
jest.mock('@forge-engine/redis', () => require('../../src/__mocks__/redis'));
jest.mock('@forge-engine/kafka', () => require('../../src/__mocks__/kafka'));

const { prisma } = require('@forge-engine/prisma');
const { produceMessage } = require('@forge-engine/kafka');

describe('POST /jobs', () => {
  let server: any;

  beforeAll(async () => { server = await buildServer(); });
  afterAll(async () => { await server.close(); });
  beforeEach(() => { jest.clearAllMocks(); });

  test('creates a job and produces Kafka event', async () => {
    prisma.apiKey.findUnique.mockResolvedValue({ id: 'k1', keyHash: 'h1' });
    prisma.job.findUnique.mockResolvedValue(null);
    prisma.job.create.mockResolvedValue({ id: 'job-uuid' });

    const res = await server.inject({
      method: 'POST',
      url: '/jobs',
      headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'send-email', payload: { to: 'a@b.com' } }),
    });

    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body)).toHaveProperty('jobId');
    expect(prisma.job.create).toHaveBeenCalledTimes(1);
    expect(produceMessage).toHaveBeenCalledWith('job.submitted', expect.objectContaining({ type: 'send-email' }), expect.any(String));
  });

  test('returns existing job for duplicate idempotency key', async () => {
    prisma.apiKey.findUnique.mockResolvedValue({ id: 'k1', keyHash: 'h1' });
    prisma.job.findUnique.mockResolvedValue({ id: 'existing-id' });

    const res = await server.inject({
      method: 'POST',
      url: '/jobs',
      headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'send-email', payload: {}, idempotencyKey: 'my-key' }),
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).jobId).toBe('existing-id');
    expect(prisma.job.create).not.toHaveBeenCalled();
  });
});
