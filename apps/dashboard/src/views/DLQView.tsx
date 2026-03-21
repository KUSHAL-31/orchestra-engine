import React, { useEffect, useState } from 'react';
import { api } from '../api/client';

export function DLQView() {
  const [entries, setEntries] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const load = () =>
    api.getDLQ().then((data) => setEntries(data)).catch(console.error).finally(() => setLoading(false));

  useEffect(() => { load(); }, []);

  if (loading) {
    return (
      <div className="loader">
        <div className="spinner" />
        Loading dead letter queue…
      </div>
    );
  }

  return (
    <div className="view">
      <div className="page-header">
        <h1 className="page-title">Dead Letter Queue</h1>
        {entries.length > 0 && <span className="page-count">{entries.length}</span>}
      </div>
      <div className="table-card">
        <table className="data-table">
          <thead>
            <tr>
              <th>Job ID</th>
              <th>Job Type</th>
              <th>Errors</th>
              <th>Moved At</th>
              <th>Replayed</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  <div className="empty-state">
                    <span className="empty-state-icon">✓</span>
                    <div>Dead letter queue is empty</div>
                    <div className="empty-state-text">Failed jobs that exhaust retries will appear here.</div>
                  </div>
                </td>
              </tr>
            ) : (
              entries.map((e) => (
                <tr key={e.id}>
                  <td><code>{e.jobId.slice(0, 8)}…</code></td>
                  <td><code>{e.jobType}</code></td>
                  <td style={{ color: 'var(--danger)', fontWeight: 600 }}>
                    {Array.isArray(e.errorHistory) ? e.errorHistory.length : 0}
                  </td>
                  <td style={{ color: 'var(--text-muted)' }}>{new Date(e.movedAt).toLocaleString()}</td>
                  <td style={{ color: 'var(--text-muted)' }}>
                    {e.replayedAt ? new Date(e.replayedAt).toLocaleString() : '—'}
                  </td>
                  <td>
                    <div className="actions-cell">
                      <button className="btn btn-sm" onClick={() => api.replayDLQ(e.id).then(load)}>
                        Replay
                      </button>
                      <button className="btn btn-sm btn-danger" onClick={() => api.deleteDLQ(e.id).then(load)}>
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
