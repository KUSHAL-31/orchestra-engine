import { kafka } from './client';
import { Topics } from './topics';

export async function initKafkaTopics(): Promise<void> {
  const admin = kafka.admin();
  await admin.connect();
  try {
    const existing = await admin.listTopics();
    const toCreate = Object.values(Topics)
      .filter((t) => !existing.includes(t))
      .map((topic) => ({
        topic,
        numPartitions: 3,
        replicationFactor: 1,
      }));

    if (toCreate.length > 0) {
      await admin.createTopics({ topics: toCreate, waitForLeaders: true });
    }
  } finally {
    await admin.disconnect();
  }
}
