import { FastifyInstance } from 'fastify';
import { prisma } from '@orchestra-engine/prisma';

export async function analyticsRoutes(server: FastifyInstance) {

  // GET /analytics/stats?from=<ISO>&to=<ISO>
  // Returns DB-accurate counts for KPIs — no row fetching, just COUNT queries.
  server.get<{ Querystring: { from?: string; to?: string } }>('/analytics/stats', async (request, reply) => {
    const from = request.query.from ? new Date(request.query.from) : undefined;
    const to   = request.query.to   ? new Date(request.query.to)   : undefined;

    const dateFilter = {
      ...(from || to ? {
        createdAt: {
          ...(from ? { gte: from } : {}),
          ...(to   ? { lte: to   } : {}),
        },
      } : {}),
    };

    const [
      jobTotal,
      jobCompleted,
      jobFailed,
      jobRunning,
      jobPending,
      jobRetrying,
      jobDead,
      wfTotal,
      wfCompleted,
      wfFailed,
      wfRunning,
      wfPending,
    ] = await Promise.all([
      prisma.job.count({ where: dateFilter }),
      prisma.job.count({ where: { ...dateFilter, status: 'COMPLETED' } }),
      prisma.job.count({ where: { ...dateFilter, status: 'FAILED' } }),
      prisma.job.count({ where: { ...dateFilter, status: 'RUNNING' } }),
      prisma.job.count({ where: { ...dateFilter, status: 'PENDING' } }),
      prisma.job.count({ where: { ...dateFilter, status: 'RETRYING' } }),
      prisma.job.count({ where: { ...dateFilter, status: 'DEAD' } }),
      prisma.workflow.count({ where: dateFilter }),
      prisma.workflow.count({ where: { ...dateFilter, status: 'COMPLETED' } }),
      prisma.workflow.count({ where: { ...dateFilter, status: 'FAILED' } }),
      prisma.workflow.count({ where: { ...dateFilter, status: 'RUNNING' } }),
      prisma.workflow.count({ where: { ...dateFilter, status: 'PENDING' } }),
    ]);

    return reply.send({
      jobs: {
        total:     jobTotal,
        completed: jobCompleted,
        failed:    jobFailed + jobDead,
        running:   jobRunning,
        pending:   jobPending,
        retrying:  jobRetrying,
      },
      workflows: {
        total:     wfTotal,
        completed: wfCompleted,
        failed:    wfFailed,
        running:   wfRunning,
        pending:   wfPending,
      },
    });
  });
}
