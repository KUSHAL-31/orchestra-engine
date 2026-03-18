import 'dotenv/config';
import { initKafkaTopics } from '@node-forge-engine/kafka';
import { redis } from '@node-forge-engine/redis';
import { runSchedulerPoll } from './poll';
import { createLogger } from '@node-forge-engine/types';

const logger = createLogger('scheduler');

const POLL_INTERVAL_MS = parseInt(
  process.env.SCHEDULER_POLL_INTERVAL_MS ?? '60000', 10
);

async function main() {
  await initKafkaTopics();
  await redis.connect();

  logger.info({ pollIntervalMs: POLL_INTERVAL_MS }, 'Scheduler Service starting');

  // Run immediately on startup, then on interval
  await runSchedulerPoll();
  const interval = setInterval(runSchedulerPoll, POLL_INTERVAL_MS);

  const shutdown = async () => {
    logger.info('Shutting down scheduler...');
    clearInterval(interval);
    await redis.quit();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  logger.info('Scheduler Service started');
}

main().catch((err) => {
  logger.error(err, 'Failed to start Scheduler');
  process.exit(1);
});
