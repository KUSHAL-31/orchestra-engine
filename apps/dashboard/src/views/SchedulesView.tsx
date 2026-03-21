import React, { useEffect, useState } from 'react';
import { api } from '../api/client';
import { StatusBadge } from '../components/StatusBadge';

export function SchedulesView() {
  const [schedules, setSchedules] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const load = () =>
    api.getSchedules().then((data) => setSchedules(data)).catch(console.error).finally(() => setLoading(false));

  useEffect(() => { load(); }, []);

  if (loading) {
    return (
      <div className="loader">
        <div className="spinner" />
        Loading schedules…
      </div>
    );
  }

  return (
    <div className="view">
      <div className="page-header">
        <h1 className="page-title">Schedules</h1>
        {schedules.length > 0 && <span className="page-count">{schedules.length}</span>}
      </div>
      <div className="table-card">
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Cron</th>
              <th>Job Type</th>
              <th>Status</th>
              <th>Next Run</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {schedules.length === 0 ? (
              <tr>
                <td colSpan={7}>
                  <div className="empty-state">
                    <span className="empty-state-icon">◷</span>
                    <div>No schedules configured</div>
                    <div className="empty-state-text">Schedules will appear here once created.</div>
                  </div>
                </td>
              </tr>
            ) : (
              schedules.map((s) => (
                <tr key={s.id}>
                  <td style={{ fontWeight: 500 }}>{s.name}</td>
                  <td style={{ color: 'var(--text-muted)' }}>{s.type}</td>
                  <td><code>{s.cronExpr ?? '—'}</code></td>
                  <td><code>{s.jobType}</code></td>
                  <td><StatusBadge status={s.active ? 'active' : 'inactive'} /></td>
                  <td style={{ color: 'var(--text-muted)' }}>{new Date(s.nextRunAt).toLocaleString()}</td>
                  <td>
                    <div className="actions-cell">
                      <button
                        className="btn btn-sm"
                        onClick={() => api.pauseSchedule(s.id, !s.active).then(load)}
                      >
                        {s.active ? 'Pause' : 'Resume'}
                      </button>
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={() => api.deleteSchedule(s.id).then(load)}
                      >
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
