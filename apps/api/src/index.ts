import 'dotenv/config';
import { buildServer } from './server';
import { startApiConsumers } from './consumers';
import { initKafkaTopics } from '@orchestra-engine/kafka';
import { redis, redisSubscriber } from '@orchestra-engine/redis';
import { createLogger } from '@orchestra-engine/types';

const logger = createLogger('api');

async function main() {
  await initKafkaTopics();
  await redis.connect();
  await redisSubscriber.connect();

  await startApiConsumers(); // start Kafka → pub/sub bridge

  const server = await buildServer();
  const port = parseInt(process.env.API_PORT ?? '3000', 10);

  await server.listen({ port, host: '0.0.0.0' });
  logger.info({ port }, 'API Service started');
}

main().catch((err) => {
  logger.error(err, 'Failed to start API service');
  process.exit(1);
});
