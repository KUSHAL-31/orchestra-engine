import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useWorkflowStore } from '../store/workflows';
import type { Workflow } from '../api/types';

export const PAGE_SIZE = 50;

export function useWorkflows() {
  const { workflows, setWorkflows } = useWorkflowStore();
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);

  useEffect(() => {
    setLoading(true);
    api.getWorkflows(PAGE_SIZE, page * PAGE_SIZE)
      .then(({ data, total: t }) => { setWorkflows(data as Workflow[]); setTotal(t); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [page]);

  const workflowList = Array.from(workflows.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  ) as unknown as Workflow[];

  return { workflows: workflowList, loading, total, page, setPage, pageSize: PAGE_SIZE };
}
