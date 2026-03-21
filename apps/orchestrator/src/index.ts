import 'dotenv/config';
import { initKafkaTopics } from '@orchestra-engine/kafka';
import { redis } from '@orchestra-engine/redis';
import { startWorkflowCreatedConsumer } from './consumers/workflow-created';
import { startJobCompletedConsumer } from './consumers/job-completed';
import { startJobFailedConsumer } from './consumers/job-failed';
import { startJobStartedConsumer } from './consumers/job-started';
import { createLogger } from '@orchestra-engine/types';

const logger = createLogger('orchestrator');

async function main() {
  await initKafkaTopics();
  await redis.connect();

  await Promise.all([
    startWorkflowCreatedConsumer(),
    startJobCompletedConsumer(),
    startJobFailedConsumer(),
    startJobStartedConsumer(),
  ]);

  logger.info('Orchestrator Service started');
}

main().catch((err) => {
  logger.error(err, 'Failed to start Orchestrator');
  process.exit(1);
});
