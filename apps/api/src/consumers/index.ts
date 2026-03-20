import { startJobEventsConsumer } from './job-events';
import { startWorkflowEventsConsumer } from './workflow-events';
import { startDlqConsumer } from './dlq-consumer';
import { startScheduleAuditConsumer } from './schedule-audit';

export async function startApiConsumers() {
  await Promise.all([
    startJobEventsConsumer(),
    startWorkflowEventsConsumer(),
    startDlqConsumer(),
    startScheduleAuditConsumer(),
  ]);
}
