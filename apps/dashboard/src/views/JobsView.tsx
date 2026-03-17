import React from 'react';
import { Link } from 'react-router-dom';
import { useJobs } from '../hooks/useJobs';
import { StatusBadge } from '../components/StatusBadge';
import { ProgressBar } from '../components/ProgressBar';

export function JobsView() {
  const { jobs, loading } = useJobs();

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
          {jobs.map((job) => (
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
