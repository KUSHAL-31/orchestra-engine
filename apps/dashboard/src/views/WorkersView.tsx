import React, { useEffect, useState } from 'react';
import { api } from '../api/client';
import { StatusBadge } from '../components/StatusBadge';

export function WorkersView() {
  const [workers, setWorkers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = () =>
      api.getWorkers().then((data) => setWorkers(data)).catch(console.error).finally(() => setLoading(false));
    load();
    const interval = setInterval(load, 10000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div className="loader">
        <div className="spinner" />
        Loading workers…
      </div>
    );
  }

  return (
    <div className="view">
      <div className="page-header">
        <h1 className="page-title">Workers</h1>
        {workers.length > 0 && <span className="page-count">{workers.length}</span>}
      </div>
      <div className="table-card">
        <table className="data-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Job Types</th>
              <th>Status</th>
              <th>Alive</th>
              <th>Last Heartbeat</th>
              <th>Registered</th>
            </tr>
          </thead>
          <tbody>
            {workers.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  <div className="empty-state">
                    <span className="empty-state-icon">⚙</span>
                    <div>No workers registered</div>
                    <div className="empty-state-text">Workers will appear here once they connect.</div>
                  </div>
                </td>
              </tr>
            ) : (
              workers.map((w) => (
                <tr key={w.id}>
                  <td><code>{w.id}</code></td>
                  <td style={{ color: 'var(--text-muted)' }}>{w.jobTypes?.join(', ') ?? '—'}</td>
                  <td><StatusBadge status={w.status?.toLowerCase() ?? 'dead'} /></td>
                  <td>
                    <span className={`alive-dot ${w.isAlive ? 'alive' : 'dead'}`}>
                      {w.isAlive ? 'Alive' : 'Dead'}
                    </span>
                  </td>
                  <td style={{ color: 'var(--text-muted)' }}>{new Date(w.lastHeartbeat).toLocaleString()}</td>
                  <td style={{ color: 'var(--text-muted)' }}>{new Date(w.registeredAt).toLocaleString()}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
