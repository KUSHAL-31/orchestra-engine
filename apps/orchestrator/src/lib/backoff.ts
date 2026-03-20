const MAX_BACKOFF_MS = 5 * 60 * 1000; // 5 minutes

export function computeBackoffMs(
  strategy: string,
  attempt: number,
  baseDelayMs = 1000
): number {
  switch (strategy.toLowerCase()) {
    case 'fixed':
      return baseDelayMs;
    case 'linear':
      return attempt * baseDelayMs;
    case 'exponential':
      return Math.min(Math.pow(2, attempt) * baseDelayMs, MAX_BACKOFF_MS);
    default:
      return baseDelayMs;
  }
}
