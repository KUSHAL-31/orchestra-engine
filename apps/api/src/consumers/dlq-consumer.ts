import { kafka, Topics } from '@orchestra-engine/kafka';
import { prisma } from '@orchestra-engine/prisma';
import type { JobDlqEvent } from '@orchestra-engine/types';

export async function startDlqConsumer() {
  const consumer = kafka.consumer({ groupId: 'api-dlq-consumer' });
  await consumer.connect();
  await consumer.subscribe({ topics: [Topics.JOB_DLQ], fromBeginning: false });

  await consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      const event: JobDlqEvent = JSON.parse(message.value.toString());

      await prisma.deadLetterQueue.upsert({
        where: { jobId: event.jobId },
        update: { errorHistory: event.errorHistory as object[] },
        create: {
          jobId: event.jobId,
          jobType: event.type,
          payload: event.payload as any,
          errorHistory: event.errorHistory as object[],
        },
      });
    },
  });
}
