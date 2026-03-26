import { FastifyInstance } from 'fastify';
import { prisma } from '@orchestra-engine/prisma';

const HEARTBEAT_THRESHOLD_MS = 30_000;
const STALE_THRESHOLD_MS     = 60_000;

export async function workerRoutes(server: FastifyInstance) {
  // GET /workers — list all workers with live/dead status
  server.get('/workers', async (_req, reply) => {
    const workers = await prisma.worker.findMany({ orderBy: { registeredAt: 'desc' } });
    const now = Date.now();
    const enriched = workers.map((w) => ({
      ...w,
      isAlive: now - w.lastHeartbeat.getTime() < HEARTBEAT_THRESHOLD_MS,
    }));
    return reply.send(enriched);
  });

  // POST /workers/register — called by SDK worker on start()
  server.post<{ Body: { workerId: string; jobTypes: string[] } }>(
    '/workers/register',
    async (request, reply) => {
      const { workerId, jobTypes } = request.body;

      // Prune stale workers
      const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MS);
      await prisma.worker.deleteMany({
        where: {
          id: { not: workerId },
          OR: [
            { status: 'DEAD' },
            { lastHeartbeat: { lt: staleThreshold } },
          ],
        },
      });

      await prisma.worker.upsert({
        where:  { id: workerId },
        update: { status: 'ACTIVE', lastHeartbeat: new Date(), jobTypes },
        create: { id: workerId, jobTypes, status: 'ACTIVE', lastHeartbeat: new Date() },
      });

      return reply.code(200).send({ ok: true });
    }
  );

  // POST /workers/:id/heartbeat — called by SDK worker every 10s
  server.post<{ Params: { id: string } }>(
    '/workers/:id/heartbeat',
    async (request, reply) => {
      await prisma.worker.update({
        where: { id: request.params.id },
        data:  { lastHeartbeat: new Date() },
      });
      return reply.code(200).send({ ok: true });
    }
  );

  // POST /workers/:id/deregister — called by SDK worker on stop()
  server.post<{ Params: { id: string } }>(
    '/workers/:id/deregister',
    async (request, reply) => {
      await prisma.worker.update({
        where: { id: request.params.id },
        data:  { status: 'DEAD' },
      });
      return reply.code(200).send({ ok: true });
    }
  );
}
