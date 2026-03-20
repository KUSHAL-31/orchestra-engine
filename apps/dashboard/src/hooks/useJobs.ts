import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useJobStore } from '../store/jobs';
import type { Job } from '../api/types';

export function useJobs() {
  const { jobs, setJobs } = useJobStore();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getJobs()
      .then((data: Job[]) => setJobs(data))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const jobList = Array.from(jobs.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  ) as Job[];

  return { jobs: jobList, loading };
}
