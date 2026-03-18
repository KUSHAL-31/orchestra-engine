import { kafka, Topics } from '@node-forge-engine/kafka';
import { redis, PubSubChannels } from '@node-forge-engine/redis';

export async function startJobEventsConsumer() {
  const consumer = kafka.consumer({ groupId: process.env.KAFKA_GROUP_ID_API ?? 'api-consumers' });
  await consumer.connect();

  await consumer.subscribe({
    topics: [Topics.JOB_STARTED, Topics.JOB_COMPLETED, Topics.JOB_FAILED],
    fromBeginning: false,
  });

  await consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      // Forward raw JSON to Redis pub/sub for SSE clients
      await redis.publish(PubSubChannels.JOB_EVENTS, message.value.toString());
    },
  });
}
