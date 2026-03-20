import { kafka, Topics } from '@forge-engine/kafka';
import { redis, PubSubChannels } from '@forge-engine/redis';

export async function startWorkflowEventsConsumer() {
  const consumer = kafka.consumer({ groupId: `${process.env.KAFKA_GROUP_ID_API ?? 'api-consumers'}-workflow` });
  await consumer.connect();

  await consumer.subscribe({
    topics: [Topics.WORKFLOW_STEP_DONE, Topics.WORKFLOW_COMPLETED],
    fromBeginning: false,
  });

  await consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      await redis.publish(PubSubChannels.WORKFLOW_EVENTS, message.value.toString());
    },
  });
}
