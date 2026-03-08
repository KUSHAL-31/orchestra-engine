import { create } from 'zustand';

interface JobRecord {
  id: string;
  type: string;
  status: string;
  progress: number;
  attempts: number;
  maxAttempts: number;
  result: unknown;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  [key: string]: unknown;
}

interface JobStore {
  jobs: Map<string, JobRecord>;
  setJobs: (jobs: JobRecord[]) => void;
  updateJob: (id: string, patch: Partial<JobRecord>) => void;
}

export const useJobStore = create<JobStore>((set) => ({
  jobs: new Map(),
  setJobs: (jobs) =>
    set({ jobs: new Map(jobs.map((j) => [j.id, j])) }),
  updateJob: (id, patch) =>
    set((state) => {
      const existing = state.jobs.get(id) ?? { id } as JobRecord;
      const updated = new Map(state.jobs);
      updated.set(id, { ...existing, ...patch });
      return { jobs: updated };
    }),
}));
