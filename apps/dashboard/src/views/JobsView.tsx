import React from 'react';
import { Link } from 'react-router-dom';
import { useJobs } from '../hooks/useJobs';
import { StatusBadge } from '../components/StatusBadge';
import { ProgressBar } from '../components/ProgressBar';

export function JobsView() {
  const { jobs, loading } = useJobs();

  if (loading) {
    return (
      <div className="loader">
        <div className="spinner" />
        Loading jobs…
      </div>
    );
  }

  return (
    <div className="view">
      <div className="page-header">
        <h1 className="page-title">Jobs</h1>
        {jobs.length > 0 && <span className="page-count">{jobs.length}</span>}
      </div>
      <div className="table-card">
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
            {jobs.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  <div className="empty-state">
                    <span className="empty-state-icon">◈</span>
                    <div>No jobs yet</div>
                    <div className="empty-state-text">Jobs will appear here once they are enqueued.</div>
                  </div>
                </td>
              </tr>
            ) : (
              jobs.map((job) => (
                <tr key={job.id}>
                  <td>
                    <Link to={`/jobs/${job.id}`} className="id-link">
                      {job.id.slice(0, 8)}…
                    </Link>
                  </td>
                  <td><code>{job.type}</code></td>
                  <td><StatusBadge status={job.status} /></td>
                  <td><ProgressBar value={job.progress ?? 0} /></td>
                  <td style={{ color: 'var(--text-muted)' }}>{job.attempts}/{job.maxAttempts}</td>
                  <td style={{ color: 'var(--text-muted)' }}>{new Date(job.createdAt).toLocaleString()}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
