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
