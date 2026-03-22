import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useJobStore } from '../store/jobs';
import type { Job } from '../api/types';

export const PAGE_SIZE = 50;

export function useJobs() {
  const { jobs, setJobs } = useJobStore();
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);

  useEffect(() => {
    setLoading(true);
    api.getJobs(PAGE_SIZE, page * PAGE_SIZE)
      .then(({ data, total: t }) => { setJobs(data as Job[]); setTotal(t); })
      .catch(console.error)
      .finally(() => setLoading(false));

    const interval = setInterval(() => {
      api.getJobs(PAGE_SIZE, page * PAGE_SIZE)
        .then(({ data, total: t }) => { setJobs(data as Job[]); setTotal(t); })
        .catch(console.error);
    }, 5000);
    return () => clearInterval(interval);
  }, [page]);

  const jobList = Array.from(jobs.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  ) as Job[];

  return { jobs: jobList, loading, total, page, setPage, pageSize: PAGE_SIZE };
}
