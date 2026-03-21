import { kafka, Topics } from '@node-forge-engine/kafka';
import { prisma } from '@node-forge-engine/prisma';
import type { ScheduleTickEvent } from '@node-forge-engine/types';

export async function startScheduleAuditConsumer() {
  const consumer = kafka.consumer({ groupId: 'api-schedule-audit' });
  await consumer.connect();
  await consumer.subscribe({ topics: [Topics.SCHEDULE_TICK], fromBeginning: false });

  await consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      const event: ScheduleTickEvent = JSON.parse(message.value.toString());

      await prisma.auditLog.create({
        data: {
          entityType: 'SCHEDULE',
          entityId: event.scheduleId,
          toStatus: 'FIRED',
          metadata: { jobType: event.jobType, firedAt: event.firedAt },
        },
      });
    },
  });
}
