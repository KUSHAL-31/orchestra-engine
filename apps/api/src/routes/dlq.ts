import { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '@forge-engine/prisma';
import { produceMessage, Topics } from '@forge-engine/kafka';

export async function dlqRoutes(server: FastifyInstance) {

  server.get('/dlq', async (_req, reply) => {
    const entries = await prisma.deadLetterQueue.findMany({
      orderBy: { movedAt: 'desc' },
      take: 100,
    });
    return reply.send(entries);
  });

  // POST /dlq/:id/replay — Resubmit as fresh job (attempt = 0)
  server.post<{ Params: { id: string } }>('/dlq/:id/replay', async (request, reply) => {
    const dlqEntry = await prisma.deadLetterQueue.findUnique({
      where: { id: request.params.id },
    });
    if (!dlqEntry) return reply.code(404).send({ error: 'DLQ entry not found' });

    const newJobId = uuidv4();
    await prisma.job.create({
      data: {
        id: newJobId,
        type: dlqEntry.jobType,
        payload: dlqEntry.payload,
        status: 'PENDING',
        maxAttempts: 3,
        backoff: 'EXPONENTIAL',
      },
    });

    await produceMessage(
      Topics.JOB_SUBMITTED,
      { jobId: newJobId, type: dlqEntry.jobType, payload: dlqEntry.payload as Record<string, unknown>,
        priority: 'normal', delayMs: 0, maxAttempts: 3, backoff: 'exponential', attempt: 0 },
      newJobId
    );

    await prisma.deadLetterQueue.update({
      where: { id: request.params.id },
      data: { replayedAt: new Date() },
    });

    return reply.send({ jobId: newJobId });
  });

  server.delete<{ Params: { id: string } }>('/dlq/:id', async (request, reply) => {
    await prisma.deadLetterQueue.delete({ where: { id: request.params.id } });
    return reply.code(204).send();
  });
}
