import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api/client';
import { StepGraph } from '../components/StepGraph';
import { StatusBadge } from '../components/StatusBadge';

export function WorkflowDetailView() {
  const { id } = useParams<{ id: string }>();
  const [workflow, setWorkflow] = useState<any>(null);

  useEffect(() => {
    if (!id) return;
    api.getWorkflow(id).then(setWorkflow);
    const interval = setInterval(() => api.getWorkflow(id).then(setWorkflow), 5000);
    return () => clearInterval(interval);
  }, [id]);

  if (!workflow) {
    return (
      <div className="loader">
        <div className="spinner" />
        Loading workflow…
      </div>
    );
  }

  return (
    <div className="view">
      <div className="view-header">
        <h1 className="page-title">{workflow.name}</h1>
        <StatusBadge status={workflow.status} />
        {workflow.status === 'failed' && (
          <button
            className="btn btn-primary"
            style={{ marginLeft: 'auto' }}
            onClick={() => api.resumeWorkflow(workflow.id).then(() => api.getWorkflow(id!).then(setWorkflow))}
          >
            Resume Workflow
          </button>
        )}
      </div>

      <div className="section">
        <div className="section-title">Step Graph</div>
        <StepGraph steps={workflow.steps} />
      </div>

      <div className="section">
        <div className="section-title">Steps ({workflow.steps.length})</div>
        <div className="table-card">
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Status</th>
                <th>Depends On</th>
                <th>Group</th>
                <th>Executed</th>
              </tr>
            </thead>
            <tbody>
              {workflow.steps.map((step: any) => (
                <tr key={step.id}>
                  <td style={{ fontWeight: 600 }}>{step.name}</td>
                  <td><code>{step.jobType}</code></td>
                  <td><StatusBadge status={step.status} /></td>
                  <td style={{ color: 'var(--text-muted)' }}>{step.dependsOn.join(', ') || '—'}</td>
                  <td style={{ color: 'var(--text-muted)' }}>{step.parallelGroup ?? '—'}</td>
                  <td style={{ color: 'var(--text-muted)' }}>
                    {step.executedAt ? new Date(step.executedAt).toLocaleString() : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
