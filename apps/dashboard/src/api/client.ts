const API_BASE = '/api';
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
  if (res.status === 204) return undefined as T;
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
