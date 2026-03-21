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

  if (!job) {
    return (
      <div className="loader">
        <div className="spinner" />
        Loading job…
      </div>
    );
  }

  return (
    <div className="view">
      <div className="view-header">
        <h1 className="page-title" style={{ fontFamily: 'var(--mono)', fontSize: '1.1rem' }}>
          {job.id}
        </h1>
        <StatusBadge status={job.status} />
      </div>

      <div className="detail-grid">
        <div className="detail-item">
          <div className="detail-label">Type</div>
          <div className="detail-value"><code>{job.type}</code></div>
        </div>
        <div className="detail-item">
          <div className="detail-label">Attempts</div>
          <div className="detail-value">{job.attempts} / {job.maxAttempts}</div>
        </div>
        <div className="detail-item">
          <div className="detail-label">Created</div>
          <div className="detail-value" style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
            {new Date(job.createdAt).toLocaleString()}
          </div>
        </div>
        {job.startedAt && (
          <div className="detail-item">
            <div className="detail-label">Started</div>
            <div className="detail-value" style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
              {new Date(job.startedAt).toLocaleString()}
            </div>
          </div>
        )}
        {job.completedAt && (
          <div className="detail-item">
            <div className="detail-label">Completed</div>
            <div className="detail-value" style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
              {new Date(job.completedAt).toLocaleString()}
            </div>
          </div>
        )}
      </div>

      <div className="section">
        <div className="section-title">Progress</div>
        <ProgressBar value={job.progress ?? 0} />
      </div>

      {job.result && (
        <div className="section">
          <div className="section-title">Result</div>
          <pre className="code-block">{JSON.stringify(job.result, null, 2)}</pre>
        </div>
      )}

      {job.error && (
        <div className="section">
          <div className="section-title">Error</div>
          <pre className="code-block error">{job.error}</pre>
        </div>
      )}

      {job.logs?.length > 0 && (
        <div className="section">
          <div className="section-title">Logs ({job.logs.length})</div>
          <div className="log-container">
            {job.logs.map((line: string, i: number) => (
              <div key={i} className="log-line">{line}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
