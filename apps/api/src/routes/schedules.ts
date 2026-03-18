import { FastifyInstance } from 'fastify';
import parser from 'cron-parser';
import { prisma } from '@node-forge-engine/prisma';
import type { CreateScheduleRequest, UpdateScheduleRequest } from '@node-forge-engine/types';

export async function scheduleRoutes(server: FastifyInstance) {
  server.get('/schedules', async (_req, reply) => {
    const schedules = await prisma.schedule.findMany({ orderBy: { createdAt: 'desc' } });
    return reply.send(schedules);
  });

  server.post<{ Body: CreateScheduleRequest }>('/schedules', async (request, reply) => {
    const { name, type, cronExpr, runAt, jobType, payload } = request.body;

    let nextRunAt: Date;
    if (type === 'cron') {
      if (!cronExpr) return reply.code(400).send({ error: 'cronExpr required for cron schedule' });
      nextRunAt = parser.parseExpression(cronExpr).next().toDate();
    } else {
      if (!runAt) return reply.code(400).send({ error: 'runAt required for one-shot schedule' });
      nextRunAt = new Date(runAt);
    }

    const schedule = await prisma.schedule.create({
      data: {
        name, type: type === 'cron' ? 'CRON' : 'ONE_SHOT',
        cronExpr, runAt: runAt ? new Date(runAt) : undefined,
        nextRunAt, jobType, payload: payload as any,
      },
    });

    return reply.code(201).send(schedule);
  });

  server.patch<{ Params: { id: string }; Body: UpdateScheduleRequest }>(
    '/schedules/:id', async (request, reply) => {
      const schedule = await prisma.schedule.update({
        where: { id: request.params.id },
        data: {
          ...(request.body.cronExpr && { cronExpr: request.body.cronExpr }),
          ...(request.body.payload && { payload: request.body.payload as object }),
          ...(request.body.active !== undefined && { active: request.body.active }),
        },
      });
      return reply.send(schedule);
    }
  );

  server.delete<{ Params: { id: string } }>('/schedules/:id', async (request, reply) => {
    await prisma.schedule.delete({ where: { id: request.params.id } });
    return reply.code(204).send();
  });
}
