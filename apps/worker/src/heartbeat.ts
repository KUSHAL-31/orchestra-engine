import os from 'os';
import { prisma } from '@node-forge-engine/prisma';
import { redis, RedisKeys, RedisTTL } from '@node-forge-engine/redis';
import { createLogger } from '@node-forge-engine/types';

const logger = createLogger('worker:heartbeat');

export function getWorkerId(): string {
  return `${os.hostname()}-${process.pid}`;
}

export async function registerWorker(jobTypes: string[]): Promise<void> {
  const workerId = getWorkerId();
  await prisma.worker.upsert({
    where: { id: workerId },
    update: { status: 'ACTIVE', lastHeartbeat: new Date(), jobTypes },
    create: { id: workerId, jobTypes, status: 'ACTIVE', lastHeartbeat: new Date() },
  });
  logger.info({ workerId, jobTypes }, 'Worker registered');
}

export function startHeartbeat(jobTypes: string[]): NodeJS.Timeout {
  const workerId = getWorkerId();

  // Run immediately, then every 10s
  const beat = async () => {
    try {
      await redis.set(RedisKeys.heartbeat(workerId), 'alive', 'EX', RedisTTL.HEARTBEAT);
      await prisma.worker.update({
        where: { id: workerId },
        data: { lastHeartbeat: new Date() },
      });
    } catch (err) {
      logger.error(err, 'Heartbeat failed');
    }
  };

  beat(); // immediate
  return setInterval(beat, 10_000);
}

export async function deregisterWorker(): Promise<void> {
  const workerId = getWorkerId();
  await prisma.worker.update({
    where: { id: workerId },
    data: { status: 'DEAD' },
  });
  logger.info({ workerId }, 'Worker deregistered');
}
