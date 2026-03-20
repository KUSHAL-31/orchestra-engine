import Redlock from 'redlock';
import { redlockClients } from './client';

export const redlock = new Redlock(redlockClients, {
  driftFactor: 0.01,        // clock drift multiplier
  retryCount: 3,
  retryDelay: 200,          // ms between retry attempts
  retryJitter: 100,
  automaticExtensionThreshold: 500,
});

redlock.on('error', (err) => {
  // Suppress expected lock contention errors; log unexpected ones
  if (!err.message.includes('The operation was unable to achieve a quorum')) {
    // eslint-disable-next-line no-console
    console.error('[Redlock] unexpected error:', err);
  }
});

/**
 * Acquire a Redlock lock, run the callback, then release.
 * Throws if lock cannot be acquired (caller should skip/retry).
 */
export async function withLock<T>(
  resource: string,
  ttlMs: number,
  fn: () => Promise<T>
): Promise<T> {
  const lock = await redlock.acquire([resource], ttlMs);
  try {
    return await fn();
  } finally {
    await lock.release().catch(() => {
      // Lock may have expired; safe to ignore
    });
  }
}
