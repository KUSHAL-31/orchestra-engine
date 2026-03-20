import React, { useEffect, useState } from 'react';
import { api } from '../api/client';
import { StatusBadge } from '../components/StatusBadge';

export function SchedulesView() {
  const [schedules, setSchedules] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const load = () => api.getSchedules().then((data) => setSchedules(data)).catch(console.error).finally(() => setLoading(false));

  useEffect(() => { load(); }, []);

  if (loading) return <div className="loader">Loading schedules...</div>;

  return (
    <div className="view">
      <h1>Schedules</h1>
      <table className="data-table">
        <thead>
          <tr>
            <th>Name</th><th>Type</th><th>Cron</th><th>Job Type</th><th>Active</th><th>Next Run</th><th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {schedules.map((s) => (
            <tr key={s.id}>
              <td>{s.name}</td>
              <td>{s.type}</td>
              <td><code>{s.cronExpr ?? '—'}</code></td>
              <td><code>{s.jobType}</code></td>
              <td><StatusBadge status={s.active ? 'active' : 'pending'} /></td>
              <td>{new Date(s.nextRunAt).toLocaleString()}</td>
              <td>
                <button className="btn btn-sm" onClick={() => api.pauseSchedule(s.id, !s.active).then(load)}>
                  {s.active ? 'Pause' : 'Resume'}
                </button>
                <button className="btn btn-sm btn-danger" onClick={() => api.deleteSchedule(s.id).then(load)}>
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
