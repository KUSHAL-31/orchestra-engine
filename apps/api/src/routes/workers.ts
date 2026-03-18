import { FastifyInstance } from 'fastify';
import { prisma } from '@node-forge-engine/prisma';

export async function workerRoutes(server: FastifyInstance) {
  server.get('/workers', async (_req, reply) => {
    const workers = await prisma.worker.findMany({ orderBy: { registeredAt: 'desc' } });
    // A worker is "dead" if lastHeartbeat > 30s ago
    const HEARTBEAT_THRESHOLD_MS = 30_000;
    const now = Date.now();
    const enriched = workers.map((w) => ({
      ...w,
      isAlive: now - w.lastHeartbeat.getTime() < HEARTBEAT_THRESHOLD_MS,
    }));
    return reply.send(enriched);
  });
}
