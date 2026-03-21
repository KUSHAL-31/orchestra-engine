/**
 * Integration test: validates the full job submission -> execution -> completion flow.
 * Requires running Docker Compose services (postgres, kafka, redis).
 * Run with: npm run test:integration
 *
 * Uses testcontainers if real services are not available.
 */

// Set TEST_INTEGRATION=true to run.

const RUN_INTEGRATION = process.env.TEST_INTEGRATION === 'true';

(RUN_INTEGRATION ? describe : describe.skip)('Full job flow (integration)', () => {
  let engine: any;
  let worker: any;

  beforeAll(async () => {
    // Initialize real connections
    const { JobEngine } = await import('@orchestra-engine/sdk');
    const { Worker } = await import('@orchestra-engine/sdk');

    engine = new JobEngine({
      apiUrl: process.env.API_BASE_URL ?? 'http://localhost:3000',
      apiKey: process.env.API_KEY ?? 'orchestra-dev-api-key-12345',
    });

    worker = new Worker();
    worker.register('test-job', async (ctx: any) => {
      await ctx.progress(100);
      return { done: true };
    });

    worker.start({ kafkaBrokers: ['localhost:9092'] });
    await new Promise((r) => setTimeout(r, 2000)); // let worker connect
  }, 30_000);

  test('submitted job completes within 5 seconds', async () => {
    const { jobId } = await engine.submitJob({
      type: 'test-job',
      payload: { foo: 'bar' },
    });

    // Poll for completion
    let status = 'pending';
    const deadline = Date.now() + 5000;
    while (status !== 'completed' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      const job = await engine.getJob(jobId);
      status = job.status;
    }

    expect(status).toBe('completed');
  }, 10_000);
});
