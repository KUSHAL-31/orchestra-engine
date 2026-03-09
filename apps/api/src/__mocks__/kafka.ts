export const produceMessageMock = jest.fn();
export const produceMessage = produceMessageMock;
export const Topics = {
  JOB_SUBMITTED: 'job.submitted',
  JOB_RETRY: 'job.retry',
  JOB_STARTED: 'job.started',
  JOB_COMPLETED: 'job.completed',
  JOB_FAILED: 'job.failed',
  JOB_DLQ: 'job.dlq',
  WORKFLOW_CREATED: 'workflow.created',
  WORKFLOW_STEP_DONE: 'workflow.step.done',
  WORKFLOW_COMPLETED: 'workflow.completed',
  SCHEDULE_TICK: 'schedule.tick',
};
export const kafka = {
  consumer: jest.fn(() => ({
    connect: jest.fn(),
    subscribe: jest.fn(),
    run: jest.fn(),
    disconnect: jest.fn(),
  })),
};
export const initKafkaTopics = jest.fn();
