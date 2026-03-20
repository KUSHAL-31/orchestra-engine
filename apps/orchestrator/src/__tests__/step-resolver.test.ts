import { resolveReadySteps, resolveFirstSteps } from '../lib/step-resolver';

const makeStep = (id: string, dependsOn: string[], status = 'PENDING') => ({
  id, dependsOn, status,
  workflowId: 'wf1', name: id, jobType: id,
  parallelGroup: null, position: 0, result: null, error: null, executedAt: null,
} as any);

describe('resolveFirstSteps', () => {
  test('returns steps with empty dependsOn', () => {
    const steps = [
      makeStep('s1', []),
      makeStep('s2', ['s1']),
      makeStep('s3', []),
    ];
    const first = resolveFirstSteps(steps);
    expect(first.map(s => s.id)).toEqual(['s1', 's3']);
  });
});

describe('resolveReadySteps', () => {
  test('returns step whose single dependency just completed', () => {
    const steps = [
      makeStep('s1', [], 'COMPLETED'),
      makeStep('s2', ['s1'], 'PENDING'),
      makeStep('s3', ['s2'], 'PENDING'),
    ];
    const ready = resolveReadySteps(steps, 's1');
    expect(ready.map(s => s.id)).toEqual(['s2']);
  });

  test('does not return step whose dependencies are not all completed', () => {
    const steps = [
      makeStep('s1', [], 'COMPLETED'),
      makeStep('s2', [], 'PENDING'),
      makeStep('s3', ['s1', 's2'], 'PENDING'),
    ];
    const ready = resolveReadySteps(steps, 's1');
    expect(ready).toHaveLength(0);
  });

  test('returns multiple fan-out steps simultaneously', () => {
    const steps = [
      makeStep('s1', [], 'COMPLETED'),
      makeStep('s2', ['s1'], 'PENDING'),
      makeStep('s3', ['s1'], 'PENDING'),
    ];
    const ready = resolveReadySteps(steps, 's1');
    expect(ready.map(s => s.id)).toEqual(expect.arrayContaining(['s2', 's3']));
  });
});
