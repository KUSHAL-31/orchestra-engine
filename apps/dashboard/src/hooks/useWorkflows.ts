import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useWorkflowStore } from '../store/workflows';
import type { Workflow } from '../api/types';

export function useWorkflows() {
  const { workflows, setWorkflows } = useWorkflowStore();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getWorkflows()
      .then((data: Workflow[]) => setWorkflows(data))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const workflowList = Array.from(workflows.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  ) as unknown as Workflow[];

  return { workflows: workflowList, loading };
}
