import { useEffect } from 'react';
import { useJobStore } from '../store/jobs';
import { useWorkflowStore } from '../store/workflows';

const SSE_URL = '/api/events';
const API_KEY = (import.meta as any).env?.VITE_API_KEY ?? 'forge-dev-api-key-12345';

export function useSSE() {
  const updateJob = useJobStore((s) => s.updateJob);
  const updateWorkflow = useWorkflowStore((s) => s.updateWorkflow);

  useEffect(() => {
    const es = new EventSource(`${SSE_URL}?key=${encodeURIComponent(API_KEY)}`);

    es.addEventListener('job.events', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        if (data.jobId) {
          updateJob(data.jobId, data);
        }
      } catch { /* ignore */ }
    });

    es.addEventListener('workflow.events', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        if (data.workflowId) {
          updateWorkflow(data.workflowId, data);
        }
      } catch { /* ignore */ }
    });

    es.onerror = () => {};

    return () => es.close();
  }, []);
}
