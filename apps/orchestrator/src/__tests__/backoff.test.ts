import { computeBackoffMs } from '../lib/backoff';

describe('computeBackoffMs', () => {
  test('fixed: always returns baseDelay', () => {
    expect(computeBackoffMs('fixed', 1, 1000)).toBe(1000);
    expect(computeBackoffMs('fixed', 5, 1000)).toBe(1000);
  });

  test('linear: returns attempt * baseDelay', () => {
    expect(computeBackoffMs('linear', 1, 1000)).toBe(1000);
    expect(computeBackoffMs('linear', 3, 1000)).toBe(3000);
  });

  test('exponential: doubles each attempt, capped at 5 minutes', () => {
    expect(computeBackoffMs('exponential', 1, 1000)).toBe(2000);
    expect(computeBackoffMs('exponential', 2, 1000)).toBe(4000);
    expect(computeBackoffMs('exponential', 10, 1000)).toBe(300_000); // capped
  });
});
