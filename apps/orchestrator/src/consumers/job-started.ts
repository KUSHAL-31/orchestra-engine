import { kafka, Topics } from '@node-forge-engine/kafka';
import { prisma } from '@node-forge-engine/prisma';
import { writeAuditLog } from '@node-forge-engine/prisma';
import type { JobStartedEvent } from '@node-forge-engine/types';

export async function startJobStartedConsumer() {
  const consumer = kafka.consumer({
    groupId: `${process.env.KAFKA_GROUP_ID_ORCHESTRATOR ?? 'orchestrator'}-audit`,
  });
  await consumer.connect();
  await consumer.subscribe({ topics: [Topics.JOB_STARTED], fromBeginning: false });

  await consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      const event: JobStartedEvent = JSON.parse(message.value.toString());

      await prisma.job.update({
        where: { id: event.jobId },
        data: { status: 'RUNNING', startedAt: new Date(event.startedAt), attempts: { increment: 1 } },
      });

      await writeAuditLog({ entityType: 'JOB', entityId: event.jobId, fromStatus: 'PENDING', toStatus: 'RUNNING' });
    },
  });
}
