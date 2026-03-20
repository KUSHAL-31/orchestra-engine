import React, { useEffect, useState } from 'react';
import { api } from '../api/client';

export function DLQView() {
  const [entries, setEntries] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const load = () => api.getDLQ().then((data) => setEntries(data)).catch(console.error).finally(() => setLoading(false));

  useEffect(() => { load(); }, []);

  if (loading) return <div className="loader">Loading DLQ...</div>;

  return (
    <div className="view">
      <h1>Dead Letter Queue</h1>
      <table className="data-table">
        <thead>
          <tr>
            <th>Job ID</th><th>Job Type</th><th>Errors</th><th>Moved At</th><th>Replayed</th><th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id}>
              <td><code>{e.jobId.slice(0, 8)}...</code></td>
              <td><code>{e.jobType}</code></td>
              <td>{Array.isArray(e.errorHistory) ? e.errorHistory.length : 0}</td>
              <td>{new Date(e.movedAt).toLocaleString()}</td>
              <td>{e.replayedAt ? new Date(e.replayedAt).toLocaleString() : '—'}</td>
              <td>
                <button className="btn btn-sm" onClick={() => api.replayDLQ(e.id).then(load)}>
                  Replay
                </button>
                <button className="btn btn-sm btn-danger" onClick={() => api.deleteDLQ(e.id).then(load)}>
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
