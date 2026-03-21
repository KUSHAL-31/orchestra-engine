import { buildServer } from '../server';
import crypto from 'crypto';

// Mock prisma
jest.mock('@orchestra-engine/prisma', () => ({
  prisma: {
    apiKey: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    job: { findUnique: jest.fn(), create: jest.fn() },
  },
}));
jest.mock('@orchestra-engine/redis', () => require('../../src/__mocks__/redis'));
jest.mock('@orchestra-engine/kafka', () => require('../../src/__mocks__/kafka'));

const { prisma } = require('@orchestra-engine/prisma');

describe('Auth middleware', () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    server = await buildServer();
  });

  afterAll(async () => {
    await server.close();
  });

  test('returns 401 when no Authorization header', async () => {
    const res = await server.inject({ method: 'GET', url: '/jobs/123' });
    expect(res.statusCode).toBe(401);
  });

  test('returns 401 for invalid API key', async () => {
    prisma.apiKey.findUnique.mockResolvedValue(null);
    const res = await server.inject({
      method: 'GET', url: '/jobs/123',
      headers: { Authorization: 'Bearer bad-key' },
    });
    expect(res.statusCode).toBe(401);
  });

  test('allows request with valid API key', async () => {
    const keyHash = crypto.createHash('sha256').update('good-key').digest('hex');
    prisma.apiKey.findUnique.mockResolvedValue({ id: 'key1', keyHash });
    prisma.job.findUnique.mockResolvedValue(null);

    const res = await server.inject({
      method: 'GET', url: '/jobs/nonexistent',
      headers: { Authorization: 'Bearer good-key' },
    });
    expect(res.statusCode).toBe(404);
  });
});
