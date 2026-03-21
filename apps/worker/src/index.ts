import 'dotenv/config';
import { initKafkaTopics } from '@orchestra-engine/kafka';
import { redis } from '@orchestra-engine/redis';
import { startWorkerConsumer } from './consumer';
import { registerWorker, startHeartbeat, deregisterWorker } from './heartbeat';
import { createLogger } from '@orchestra-engine/types';
import { JobHandler } from './context';

// ─── Register your job handlers here ─────────────────────────────────────────
import { sendEmailHandler } from './handlers/send-email';
import { generateReportHandler } from './handlers/generate-report';
import { validateOrderHandler } from './handlers/validate-order';
import { chargePaymentHandler } from './handlers/charge-payment';
import { updateInventoryHandler } from './handlers/update-inventory';
import { notifyWarehouseHandler } from './handlers/notify-warehouse';

const logger = createLogger('worker');

const handlers = new Map<string, JobHandler>([
  ['send-email', sendEmailHandler],
  ['generate-report', generateReportHandler],
  ['validate-order', validateOrderHandler],
  ['charge-payment', chargePaymentHandler],
  ['update-inventory', updateInventoryHandler],
  ['notify-warehouse', notifyWarehouseHandler],
]);

async function main() {
  await initKafkaTopics();
  await redis.connect();

  const jobTypes = Array.from(handlers.keys());
  await registerWorker(jobTypes);
  startHeartbeat(jobTypes);

  const consumer = await startWorkerConsumer(handlers);

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down worker...');
    await consumer.disconnect();
    await deregisterWorker();
    await redis.quit();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  logger.info({ jobTypes }, 'Worker Service started');
}

main().catch((err) => {
  logger.error(err, 'Failed to start Worker');
  process.exit(1);
});
