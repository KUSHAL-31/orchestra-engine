import { Producer, CompressionTypes } from 'kafkajs';
import { kafka } from './client';
import { TopicName } from './topics';

let producerInstance: Producer | null = null;

export async function getProducer(): Promise<Producer> {
  if (!producerInstance) {
    producerInstance = kafka.producer({
      allowAutoTopicCreation: false,
      transactionTimeout: 30000,
    });
    await producerInstance.connect();
  }
  return producerInstance;
}

export async function produceMessage<T>(topic: TopicName, value: T, key?: string) {
  const producer = await getProducer();
  await producer.send({
    topic,
    compression: CompressionTypes.GZIP,
    messages: [
      {
        key: key ?? null,
        value: JSON.stringify(value),
        timestamp: Date.now().toString(),
      },
    ],
  });
}

export async function disconnectProducer() {
  if (producerInstance) {
    await producerInstance.disconnect();
    producerInstance = null;
  }
}
