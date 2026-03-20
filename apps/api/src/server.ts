import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { healthRoutes } from './routes/health';
import { jobRoutes } from './routes/jobs';
import { workflowRoutes } from './routes/workflows';
import { dlqRoutes } from './routes/dlq';
import { scheduleRoutes } from './routes/schedules';
import { workerRoutes } from './routes/workers';
import { eventsRoutes } from './routes/events';
import { authHook } from './middleware/auth';

export async function buildServer(): Promise<FastifyInstance> {
  const server = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

  await server.register(cors, { origin: true });

  // Auth hook applies to all routes EXCEPT /health
  server.addHook('preHandler', authHook);

  // Register all route modules
  await server.register(healthRoutes);          // GET /health  (no auth)
  await server.register(jobRoutes);             // /jobs
  await server.register(workflowRoutes);        // /workflows
  await server.register(dlqRoutes);             // /dlq
  await server.register(scheduleRoutes);        // /schedules
  await server.register(workerRoutes);          // /workers
  await server.register(eventsRoutes);          // /events

  return server;
}
