import { create } from 'zustand';

interface WorkflowRecord {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
  [key: string]: unknown;
}

interface WorkflowStore {
  workflows: Map<string, WorkflowRecord>;
  setWorkflows: (workflows: WorkflowRecord[]) => void;
  updateWorkflow: (id: string, patch: Partial<WorkflowRecord>) => void;
}

export const useWorkflowStore = create<WorkflowStore>((set) => ({
  workflows: new Map(),
  setWorkflows: (workflows) =>
    set({ workflows: new Map(workflows.map((w) => [w.id, w])) }),
  updateWorkflow: (id, patch) =>
    set((state) => {
      const existing = state.workflows.get(id) ?? { id } as WorkflowRecord;
      const updated = new Map(state.workflows);
      updated.set(id, { ...existing, ...patch });
      return { workflows: updated };
    }),
}));
