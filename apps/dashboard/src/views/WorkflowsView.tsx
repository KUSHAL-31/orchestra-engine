import React from 'react';
import { Link } from 'react-router-dom';
import { useWorkflows } from '../hooks/useWorkflows';
import { StatusBadge } from '../components/StatusBadge';

export function WorkflowsView() {
  const { workflows, loading } = useWorkflows();

  if (loading) return <div className="loader">Loading workflows...</div>;

  return (
    <div className="view">
      <h1>Workflows</h1>
      <table className="data-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Name</th>
            <th>Status</th>
            <th>Created</th>
            <th>Completed</th>
          </tr>
        </thead>
        <tbody>
          {workflows.map((wf) => (
            <tr key={wf.id}>
              <td>
                <Link to={`/workflows/${wf.id}`} className="id-link">
                  {wf.id.slice(0, 8)}...
                </Link>
              </td>
              <td>{wf.name}</td>
              <td><StatusBadge status={wf.status} /></td>
              <td>{new Date(wf.createdAt).toLocaleString()}</td>
              <td>{wf.completedAt ? new Date(wf.completedAt).toLocaleString() : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
