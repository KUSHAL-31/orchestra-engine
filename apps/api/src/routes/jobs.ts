import { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '@forge-engine/prisma';
import { produceMessage, Topics } from '@forge-engine/kafka';
import { redis, RedisKeys } from '@forge-engine/redis';
import type { SubmitJobRequest, JobSubmittedEvent } from '@forge-engine/types';

export async function jobRoutes(server: FastifyInstance) {

  // POST /jobs — Submit a new job
  server.post<{ Body: SubmitJobRequest }>('/jobs', async (request, reply) => {
    const { type, payload, retries = 3, backoff = 'exponential',
            delay = 0, priority = 'normal', idempotencyKey } = request.body;

    if (!type || !payload) {
      return reply.code(400).send({ error: 'type and payload are required' });
    }

    // Idempotency check
    if (idempotencyKey) {
      const existing = await prisma.job.findUnique({ where: { idempotencyKey } });
      if (existing) return reply.code(200).send({ jobId: existing.id });
    }

    const jobId = uuidv4();

    // RULE-5: Write to Postgres BEFORE producing to Kafka
    await prisma.job.create({
      data: {
        id: jobId,
        type,
        payload,
        status: 'PENDING',
        priority: priority.toUpperCase() as 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL',
        maxAttempts: retries,
        backoff: backoff.toUpperCase() as 'FIXED' | 'LINEAR' | 'EXPONENTIAL',
        delayMs: delay,
        idempotencyKey,
      },
    });

    const event: JobSubmittedEvent = {
      jobId, type, payload, priority, delayMs: delay,
      maxAttempts: retries, backoff, attempt: 0,
    };
    await produceMessage(Topics.JOB_SUBMITTED, event, jobId);

    return reply.code(202).send({ jobId });
  });

  // GET /jobs/:id — Get job status (Redis cache first, Postgres fallback)
  server.get<{ Params: { id: string } }>('/jobs/:id', async (request, reply) => {
    const { id } = request.params;

    // Try Redis cache first
    const [cachedStatus, cachedProgress] = await Promise.all([
      redis.get(RedisKeys.jobState(id)),
      redis.get(RedisKeys.jobProgress(id)),
    ]);
    const logs = await redis.lrange(RedisKeys.jobLogs(id), 0, -1);

    // Always hit Postgres for full record
    const job = await prisma.job.findUnique({ where: { id } });
    if (!job) return reply.code(404).send({ error: 'Job not found' });

    return reply.send({
      id: job.id,
      type: job.type,
      status: cachedStatus ?? job.status.toLowerCase(),
      progress: cachedProgress ? parseInt(cachedProgress, 10) : 0,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      result: job.result,
      error: job.error,
      logs,
      createdAt: job.createdAt.toISOString(),
      startedAt: job.startedAt?.toISOString() ?? null,
      completedAt: job.completedAt?.toISOString() ?? null,
    });
  });
}
