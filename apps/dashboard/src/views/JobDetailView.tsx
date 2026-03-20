import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api/client';
import { StatusBadge } from '../components/StatusBadge';
import { ProgressBar } from '../components/ProgressBar';

export function JobDetailView() {
  const { id } = useParams<{ id: string }>();
  const [job, setJob] = useState<any>(null);

  useEffect(() => {
    if (!id) return;
    api.getJob(id).then(setJob);
    const interval = setInterval(() => api.getJob(id).then(setJob), 3000);
    return () => clearInterval(interval);
  }, [id]);

  if (!job) return <div className="loader">Loading job...</div>;

  return (
    <div className="view">
      <div className="view-header">
        <h1>Job: {job.id.slice(0, 8)}...</h1>
        <StatusBadge status={job.status} />
      </div>
      <div className="detail-grid">
        <div><strong>Type:</strong> <code>{job.type}</code></div>
        <div><strong>Attempts:</strong> {job.attempts}/{job.maxAttempts}</div>
        <div><strong>Created:</strong> {new Date(job.createdAt).toLocaleString()}</div>
        {job.startedAt && <div><strong>Started:</strong> {new Date(job.startedAt).toLocaleString()}</div>}
        {job.completedAt && <div><strong>Completed:</strong> {new Date(job.completedAt).toLocaleString()}</div>}
      </div>
      <section>
        <h2>Progress</h2>
        <ProgressBar value={job.progress ?? 0} />
      </section>
      {job.result && (
        <section>
          <h2>Result</h2>
          <pre className="code-block">{JSON.stringify(job.result, null, 2)}</pre>
        </section>
      )}
      {job.error && (
        <section>
          <h2>Error</h2>
          <pre className="code-block error">{job.error}</pre>
        </section>
      )}
      {job.logs?.length > 0 && (
        <section>
          <h2>Logs</h2>
          <div className="log-container">
            {job.logs.map((line: string, i: number) => (
              <div key={i} className="log-line">{line}</div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
