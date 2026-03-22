const API_BASE = '/api';
const API_KEY = import.meta.env.VITE_API_KEY ?? 'orchestra-dev-api-key-12345';

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
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  getJobs: (limit = 50, offset = 0) =>
    request<{ data: any[]; total: number }>('GET', `/jobs?limit=${limit}&offset=${offset}`),
  getJob: (id: string) => request<any>('GET', `/jobs/${id}`),
  getWorkflows: (limit = 50, offset = 0) =>
    request<{ data: any[]; total: number }>('GET', `/workflows?limit=${limit}&offset=${offset}`),
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
  getAnalyticsStats: (from: string, to?: string) => {
    const params = new URLSearchParams({ from });
    if (to) params.set('to', to);
    return request<{
      jobs:      { total: number; completed: number; failed: number; running: number; pending: number; retrying: number };
      workflows: { total: number; completed: number; failed: number; running: number; pending: number };
    }>('GET', `/analytics/stats?${params}`);
  },
};
