import React from 'react';
import { Link } from 'react-router-dom';
import { useWorkflows } from '../hooks/useWorkflows';
import { StatusBadge } from '../components/StatusBadge';

export function WorkflowsView() {
  const { workflows, loading, total, page, setPage, pageSize } = useWorkflows();

  if (loading) {
    return (
      <div className="loader">
        <div className="spinner" />
        Loading workflows…
      </div>
    );
  }

  return (
    <div className="view">
      <div className="page-header">
        <h1 className="page-title">Workflows</h1>
        {total > 0 && <span className="page-count">{total.toLocaleString()} total</span>}
      </div>
      <div className="table-card">
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
            {workflows.length === 0 ? (
              <tr>
                <td colSpan={5}>
                  <div className="empty-state">
                    <span className="empty-state-icon">⬡</span>
                    <div>No workflows yet</div>
                    <div className="empty-state-text">Workflows will appear here once they are started.</div>
                  </div>
                </td>
              </tr>
            ) : (
              workflows.map((wf) => (
                <tr key={wf.id}>
                  <td>
                    <Link to={`/workflows/${wf.id}`} className="id-link">
                      {wf.id}
                    </Link>
                  </td>
                  <td style={{ fontWeight: 500 }}>{wf.name}</td>
                  <td><StatusBadge status={wf.status} /></td>
                  <td style={{ color: 'var(--text-muted)' }}>{new Date(wf.createdAt).toLocaleString()}</td>
                  <td style={{ color: 'var(--text-muted)' }}>
                    {wf.completedAt ? new Date(wf.completedAt).toLocaleString() : '—'}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* ── Pagination ── */}
      {total > pageSize && (
        <div className="pagination">
          <button
            className="btn btn-sm"
            onClick={() => setPage(p => Math.max(0, p - 1))}
            disabled={page === 0}
          >
            ← Prev
          </button>
          <span className="pagination-info">
            Page {page + 1} of {Math.ceil(total / pageSize)} &nbsp;·&nbsp; {total.toLocaleString()} workflows
          </span>
          <button
            className="btn btn-sm"
            onClick={() => setPage(p => p + 1)}
            disabled={(page + 1) * pageSize >= total}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
