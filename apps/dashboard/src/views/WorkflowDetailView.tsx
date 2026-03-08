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

  if (!workflow) return <div className="loader">Loading workflow...</div>;

  return (
    <div className="view">
      <div className="view-header">
        <h1>{workflow.name}</h1>
        <StatusBadge status={workflow.status} />
      </div>

      <section>
        <h2>Step Graph</h2>
        <StepGraph steps={workflow.steps} />
      </section>

      <section>
        <h2>Steps ({workflow.steps.length})</h2>
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th><th>Type</th><th>Status</th><th>Depends On</th><th>Group</th><th>Executed</th>
            </tr>
          </thead>
          <tbody>
            {workflow.steps.map((step: any) => (
              <tr key={step.id}>
                <td><strong>{step.name}</strong></td>
                <td><code>{step.jobType}</code></td>
                <td><StatusBadge status={step.status} /></td>
                <td>{step.dependsOn.join(', ') || '—'}</td>
                <td>{step.parallelGroup ?? '—'}</td>
                <td>{step.executedAt ? new Date(step.executedAt).toLocaleString() : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {workflow.status === 'failed' && (
        <button
          className="btn btn-primary"
          onClick={() => api.resumeWorkflow(workflow.id).then(() => api.getWorkflow(id!).then(setWorkflow))}
        >
          Resume Workflow
        </button>
      )}
    </div>
  );
}
