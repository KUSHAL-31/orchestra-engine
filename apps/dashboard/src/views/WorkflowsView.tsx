import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { useWorkflowStore } from '../store/workflows';
import { StatusBadge } from '../components/StatusBadge';

export function WorkflowsView() {
  const { workflows, setWorkflows } = useWorkflowStore();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getWorkflows().then((data) => {
      setWorkflows(data);
      setLoading(false);
    });
  }, []);

  const wfList = Array.from(workflows.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

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
          {wfList.map((wf) => (
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
