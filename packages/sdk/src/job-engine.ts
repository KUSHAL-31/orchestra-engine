import type {
  JobEngineOptions,
  SubmitJobOptions,
  SubmitWorkflowOptions,
  JobStatus,
  WorkflowStatus,
} from './types';

export class JobEngine {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(options: JobEngineOptions) {
    this.baseUrl = options.apiUrl.replace(/\/$/, '');
    this.headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${options.apiKey}`,
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(
        `ForgeEngine API error [${res.status}]: ${(err as Record<string, string>).error}`
      );
    }

    return res.json() as Promise<T>;
  }

  /** Submit a background job. Returns the jobId. */
  async submitJob(options: SubmitJobOptions): Promise<{ jobId: string }> {
    return this.request<{ jobId: string }>('POST', '/jobs', {
      type: options.type,
      payload: options.payload,
      retries: options.retries,
      backoff: options.backoff,
      delay: options.delayMs,
      priority: options.priority,
      idempotencyKey: options.idempotencyKey,
    });
  }

  /** Get full job status including progress, logs, and result. */
  async getJob(jobId: string): Promise<JobStatus> {
    return this.request<JobStatus>('GET', `/jobs/${jobId}`);
  }

  /** Submit a workflow definition. Returns the workflowId. */
  async submitWorkflow(options: SubmitWorkflowOptions): Promise<{ workflowId: string }> {
    return this.request<{ workflowId: string }>('POST', '/workflows', options);
  }

  /** Get workflow status including all step statuses. */
  async getWorkflow(workflowId: string): Promise<WorkflowStatus> {
    return this.request<WorkflowStatus>('GET', `/workflows/${workflowId}`);
  }

  /** Resume a failed workflow from the failed step. */
  async resumeWorkflow(workflowId: string): Promise<{ message: string }> {
    return this.request<{ message: string }>('POST', `/workflows/${workflowId}/resume`);
  }

  /**
   * Listen to real-time job/workflow events via Server-Sent Events.
   * Returns a cleanup function — call it to close the connection.
   *
   * Note: requires EventSource to be available (browsers natively,
   * Node.js via the `eventsource` npm package).
   */
  onEvent(callback: (event: { type: string; data: unknown }) => void): () => void {
    const apiKey = this.headers['Authorization'].slice(7);
    const url = `${this.baseUrl}/events?key=${encodeURIComponent(apiKey)}`;
    const source = new EventSource(url);

    source.onmessage = (e) => {
      try {
        callback({ type: e.type || 'message', data: JSON.parse(e.data as string) });
      } catch {
        // ignore unparseable messages
      }
    };

    return () => source.close();
  }
}
