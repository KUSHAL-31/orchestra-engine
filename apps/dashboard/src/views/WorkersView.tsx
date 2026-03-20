import React, { useEffect, useState } from 'react';
import { api } from '../api/client';
import { StatusBadge } from '../components/StatusBadge';

export function WorkersView() {
  const [workers, setWorkers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = () => api.getWorkers().then((data) => setWorkers(data)).catch(console.error).finally(() => setLoading(false));
    load();
    const interval = setInterval(load, 10000);
    return () => clearInterval(interval);
  }, []);

  if (loading) return <div className="loader">Loading workers...</div>;

  return (
    <div className="view">
      <h1>Workers</h1>
      <table className="data-table">
        <thead>
          <tr>
            <th>ID</th><th>Job Types</th><th>Status</th><th>Alive</th><th>Last Heartbeat</th><th>Registered</th>
          </tr>
        </thead>
        <tbody>
          {workers.map((w) => (
            <tr key={w.id}>
              <td><code>{w.id}</code></td>
              <td>{w.jobTypes?.join(', ') ?? '—'}</td>
              <td><StatusBadge status={w.status?.toLowerCase() ?? 'dead'} /></td>
              <td>{w.isAlive ? 'Yes' : 'No'}</td>
              <td>{new Date(w.lastHeartbeat).toLocaleString()}</td>
              <td>{new Date(w.registeredAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
