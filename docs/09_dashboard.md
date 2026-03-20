# 09 — Dashboard (`apps/dashboard`)

> **Claude Code Instruction**: The dashboard is a React + Vite SPA. It connects to the API Service SSE endpoint on load and maintains the connection for real-time updates. NO polling — all UI state changes are driven by SSE events. Implement all 7 views exactly as specified. Use React + TypeScript + Vite. Do NOT use Next.js.

---

## Folder Structure

```
apps/dashboard/
  package.json
  vite.config.ts
  tsconfig.json
  index.html
  src/
    main.tsx              ← React entry point
    App.tsx               ← Router + Layout
    api/
      client.ts           ← typed HTTP API client (wraps fetch)
      types.ts            ← API response types (mirrors API)
    hooks/
      useSSE.ts           ← SSE connection hook
      useJobs.ts          ← jobs list state management
      useWorkflows.ts     ← workflows list state management
    store/
      jobs.ts             ← Map<jobId, Job> state using zustand
      workflows.ts        ← Map<workflowId, Workflow> state
    views/
      JobsView.tsx        ← Jobs list with status badges + progress
      JobDetailView.tsx   ← Full job detail: logs, result, timeline
      WorkflowsView.tsx   ← Workflows list
      WorkflowDetailView.tsx ← Step graph with status colors
      SchedulesView.tsx   ← Schedules table with pause/delete
      DLQView.tsx         ← DLQ table with replay/delete
      WorkersView.tsx     ← Workers table with heartbeat status
    components/
      StatusBadge.tsx     ← Color-coded status badge
      ProgressBar.tsx     ← 0-100 progress bar
      Sidebar.tsx         ← Navigation sidebar
      StepGraph.tsx       ← Workflow step dependency visualizer
    styles/
      global.css          ← global styles
    index.css             ← Vite entry CSS
```

---

## `apps/dashboard/package.json`

```json
{
  "name": "@forge-engine/dashboard",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "react-router-dom": "^6.23.0",
    "zustand": "^4.5.0",
    "date-fns": "^3.6.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "vite": "^5.2.0",
    "typescript": "^5.4.0"
  }
}
```

---

## `vite.config.ts`

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
```

---

## `src/api/client.ts`

```typescript
const API_BASE = '/api'; // Proxied by Vite to localhost:3000
const API_KEY = import.meta.env.VITE_API_KEY ?? 'forge-dev-api-key-12345';

const headers = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${API_KEY}`,
};

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

export const api = {
  getJobs: () => request<any[]>('GET', '/jobs'),
  getJob: (id: string) => request<any>('GET', `/jobs/${id}`),
  getWorkflows: () => request<any[]>('GET', '/workflows'),
  getWorkflow: (id: string) => request<any>('GET', `/workflows/${id}`),
  resumeWorkflow: (id: string) => request<any>('POST', `/workflows/${id}/resume`),
  getDLQ: () => request<any[]>('GET', '/dlq'),
  replayDLQ: (id: string) => request<any>('POST', `/dlq/${id}/replay`),
  deleteDLQ: (id: string) => request<any>('DELETE', `/dlq/${id}`),
  getSchedules: () => request<any[]>('GET', '/schedules'),
  deleteSchedule: (id: string) => request<any>('DELETE', `/schedules/${id}`),
  pauseSchedule: (id: string, active: boolean) =>
    request<any>('PATCH', `/schedules/${id}`, { active }),
  getWorkers: () => request<any[]>('GET', '/workers'),
};
```

---

## `src/hooks/useSSE.ts`

```typescript
import { useEffect } from 'react';
import { useJobStore } from '../store/jobs';
import { useWorkflowStore } from '../store/workflows';

const SSE_URL = '/api/events';
const API_KEY = import.meta.env.VITE_API_KEY ?? 'forge-dev-api-key-12345';

export function useSSE() {
  const updateJob = useJobStore((s) => s.updateJob);
  const updateWorkflow = useWorkflowStore((s) => s.updateWorkflow);

  useEffect(() => {
    // NOTE: EventSource doesn't support custom headers.
    // Pass API key as query param; the API service must read from ?key= as fallback.
    const es = new EventSource(`${SSE_URL}?key=${encodeURIComponent(API_KEY)}`);

    es.addEventListener('job.events', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        // Update job in store based on event type
        if (data.jobId) {
          updateJob(data.jobId, data);
        }
      } catch {}
    });

    es.addEventListener('workflow.events', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        if (data.workflowId) {
          updateWorkflow(data.workflowId, data);
        }
      } catch {}
    });

    es.onerror = () => {
      // Browser will auto-reconnect on SSE connection loss
    };

    return () => es.close();
  }, []);
}
```

---

## `src/store/jobs.ts`

```typescript
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
```

---

## `src/views/JobsView.tsx`

```tsx
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { useJobStore } from '../store/jobs';
import { StatusBadge } from '../components/StatusBadge';
import { ProgressBar } from '../components/ProgressBar';

export function JobsView() {
  const { jobs, setJobs } = useJobStore();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getJobs().then((data) => {
      setJobs(data);
      setLoading(false);
    });
  }, []);

  const jobList = Array.from(jobs.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  if (loading) return <div className="loader">Loading jobs...</div>;

  return (
    <div className="view">
      <h1>Jobs</h1>
      <table className="data-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Type</th>
            <th>Status</th>
            <th>Progress</th>
            <th>Attempts</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {jobList.map((job) => (
            <tr key={job.id}>
              <td>
                <Link to={`/jobs/${job.id}`} className="id-link">
                  {job.id.slice(0, 8)}...
                </Link>
              </td>
              <td><code>{job.type}</code></td>
              <td><StatusBadge status={job.status} /></td>
              <td><ProgressBar value={job.progress ?? 0} /></td>
              <td>{job.attempts}/{job.maxAttempts}</td>
              <td>{new Date(job.createdAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

---

## `src/views/WorkflowDetailView.tsx`

```tsx
import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api/client';
import { StepGraph } from '../components/StepGraph';
import { StatusBadge } from '../components/StatusBadge';

export function WorkflowDetailView() {
  const { id } = useParams<{ id: string }>();
  const [workflow, setWorkflow] = useState<any>(null);

  useEffect(() => {
    if (!id) return;
    api.getWorkflow(id).then(setWorkflow);
    // Refresh every 5s for this view (supplement to SSE)
    const interval = setInterval(() => api.getWorkflow(id).then(setWorkflow), 5000);
    return () => clearInterval(interval);
  }, [id]);

  if (!workflow) return <div className="loader">Loading workflow...</div>;

  return (
    <div className="view">
      <div className="view-header">
        <h1>{workflow.name}</h1>
        <StatusBadge status={workflow.status} />
      </div>

      <section>
        <h2>Step Graph</h2>
        <StepGraph steps={workflow.steps} />
      </section>

      <section>
        <h2>Steps ({workflow.steps.length})</h2>
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th><th>Type</th><th>Status</th><th>Depends On</th><th>Group</th><th>Executed</th>
            </tr>
          </thead>
          <tbody>
            {workflow.steps.map((step: any) => (
              <tr key={step.id}>
                <td><strong>{step.name}</strong></td>
                <td><code>{step.jobType}</code></td>
                <td><StatusBadge status={step.status} /></td>
                <td>{step.dependsOn.join(', ') || '—'}</td>
                <td>{step.parallelGroup ?? '—'}</td>
                <td>{step.executedAt ? new Date(step.executedAt).toLocaleString() : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {workflow.status === 'failed' && (
        <button
          className="btn btn-primary"
          onClick={() => api.resumeWorkflow(workflow.id).then(() => api.getWorkflow(id!).then(setWorkflow))}
        >
          Resume Workflow
        </button>
      )}
    </div>
  );
}
```

---

## `src/components/StepGraph.tsx`

```tsx
import React from 'react';

interface Step {
  id: string;
  name: string;
  status: string;
  dependsOn: string[];
  parallelGroup: string | null;
  position: number;
}

const STATUS_COLORS: Record<string, string> = {
  pending: '#6b7280',
  running: '#3b82f6',
  completed: '#22c55e',
  failed: '#ef4444',
  skipped: '#9ca3af',
};

interface Props {
  steps: Step[];
}

export function StepGraph({ steps }: Props) {
  // Simple visual layout: group by parallelGroup, show as columns per group
  return (
    <div className="step-graph">
      {steps.map((step) => (
        <div
          key={step.id}
          className="step-node"
          style={{ borderColor: STATUS_COLORS[step.status] ?? '#6b7280' }}
        >
          <div className="step-name">{step.name}</div>
          <div className="step-status" style={{ color: STATUS_COLORS[step.status] }}>{step.status}</div>
          {step.parallelGroup && (
            <div className="step-group">Group: {step.parallelGroup}</div>
          )}
        </div>
      ))}
    </div>
  );
}
```

---

## `src/components/StatusBadge.tsx`

```tsx
import React from 'react';

const BADGE_STYLES: Record<string, { bg: string; color: string }> = {
  pending:   { bg: '#f3f4f6', color: '#374151' },
  running:   { bg: '#dbeafe', color: '#1d4ed8' },
  completed: { bg: '#dcfce7', color: '#15803d' },
  failed:    { bg: '#fee2e2', color: '#b91c1c' },
  retrying:  { bg: '#fef3c7', color: '#b45309' },
  dead:      { bg: '#f3f4f6', color: '#6b7280' },
  skipped:   { bg: '#f3f4f6', color: '#6b7280' },
  active:    { bg: '#dcfce7', color: '#15803d' },
};

export function StatusBadge({ status }: { status: string }) {
  const style = BADGE_STYLES[status.toLowerCase()] ?? { bg: '#f3f4f6', color: '#374151' };
  return (
    <span
      className="status-badge"
      style={{ backgroundColor: style.bg, color: style.color }}
    >
      {status}
    </span>
  );
}
```

---

## `src/App.tsx`

```tsx
import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Sidebar } from './components/Sidebar';
import { JobsView } from './views/JobsView';
import { JobDetailView } from './views/JobDetailView';
import { WorkflowsView } from './views/WorkflowsView';
import { WorkflowDetailView } from './views/WorkflowDetailView';
import { SchedulesView } from './views/SchedulesView';
import { DLQView } from './views/DLQView';
import { WorkersView } from './views/WorkersView';
import { useSSE } from './hooks/useSSE';

export function App() {
  useSSE(); // Connect SSE on mount, maintain for app lifetime

  return (
    <BrowserRouter>
      <div className="app-layout">
        <Sidebar />
        <main className="app-main">
          <Routes>
            <Route path="/" element={<Navigate to="/jobs" replace />} />
            <Route path="/jobs" element={<JobsView />} />
            <Route path="/jobs/:id" element={<JobDetailView />} />
            <Route path="/workflows" element={<WorkflowsView />} />
            <Route path="/workflows/:id" element={<WorkflowDetailView />} />
            <Route path="/schedules" element={<SchedulesView />} />
            <Route path="/dlq" element={<DLQView />} />
            <Route path="/workers" element={<WorkersView />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
```

---

## All Views — Implementation Summary

| View | Route | Data Source | Real-time? |
|---|---|---|---|
| `JobsView` | `/jobs` | `GET /jobs` on load + SSE updates | ✅ SSE |
| `JobDetailView` | `/jobs/:id` | `GET /jobs/:id` on load + SSE | ✅ SSE |
| `WorkflowsView` | `/workflows` | `GET /workflows` on load + SSE | ✅ SSE |
| `WorkflowDetailView` | `/workflows/:id` | `GET /workflows/:id` + poll every 5s | ✅ SSE + poll |
| `SchedulesView` | `/schedules` | `GET /schedules` on load | ❌ manual refresh |
| `DLQView` | `/dlq` | `GET /dlq` on load | ❌ manual refresh |
| `WorkersView` | `/workers` | `GET /workers` on load + poll every 10s | ⚠️ poll |

> **Note on SSE + custom headers**: Browsers' `EventSource` API does not support custom headers. Pass the API key as a query parameter (`?key=...`). The API Service auth middleware must be updated to also read from `request.query.key` for the `/events` endpoint.

---

## `.env` for Dashboard

```dotenv
VITE_API_KEY=forge-dev-api-key-12345
VITE_API_BASE_URL=http://localhost:3000
```
