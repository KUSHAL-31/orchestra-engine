import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useJobs } from '../hooks/useJobs';
import { StatusBadge } from '../components/StatusBadge';
import { ProgressBar } from '../components/ProgressBar';

const ALL_STATUSES = ['pending', 'running', 'completed', 'failed', 'retrying', 'dead', 'skipped'];

const TIME_PRESETS = [
  { label: 'Any time',    value: 'any' },
  { label: 'Last 30 min', value: '30m' },
  { label: 'Last 1 hour', value: '1h' },
  { label: 'Last 6 hours', value: '6h' },
  { label: 'Last 24 hours', value: '24h' },
  { label: 'Custom range', value: 'custom' },
];

function getPresetCutoff(value: string): Date | null {
  const now = Date.now();
  if (value === '30m')  return new Date(now - 30 * 60 * 1000);
  if (value === '1h')   return new Date(now - 60 * 60 * 1000);
  if (value === '6h')   return new Date(now - 6 * 60 * 60 * 1000);
  if (value === '24h')  return new Date(now - 24 * 60 * 60 * 1000);
  return null;
}

export function JobsView() {
  const { jobs, loading, total, page, setPage, pageSize } = useJobs();

  const [idFilter, setIdFilter]           = useState('');
  const [statusFilter, setStatusFilter]   = useState<string[]>([]);
  const [timePreset, setTimePreset]       = useState('any');
  const [customFrom, setCustomFrom]       = useState('');
  const [customTo, setCustomTo]           = useState('');

  const isFiltered =
    idFilter.trim() !== '' ||
    statusFilter.length > 0 ||
    timePreset !== 'any';

  function toggleStatus(s: string) {
    setStatusFilter(prev =>
      prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s]
    );
  }

  function clearFilters() {
    setIdFilter('');
    setStatusFilter([]);
    setTimePreset('any');
    setCustomFrom('');
    setCustomTo('');
  }

  const filtered = useMemo(() => {
    return jobs.filter(job => {
      if (idFilter.trim() && !job.id.toLowerCase().includes(idFilter.trim().toLowerCase())) return false;

      if (statusFilter.length > 0 && !statusFilter.includes(job.status)) return false;

      const created = new Date(job.createdAt).getTime();
      if (timePreset === 'custom') {
        if (customFrom && created < new Date(customFrom).getTime()) return false;
        if (customTo   && created > new Date(customTo).getTime())   return false;
      } else {
        const cutoff = getPresetCutoff(timePreset);
        if (cutoff && created < cutoff.getTime()) return false;
      }

      return true;
    });
  }, [jobs, idFilter, statusFilter, timePreset, customFrom, customTo]);

  if (loading) {
    return (
      <div className="loader">
        <div className="spinner" />
        Loading jobs…
      </div>
    );
  }

  return (
    <div className="view">
      <div className="page-header">
        <h1 className="page-title">Jobs</h1>
        {total > 0 && (
          <span className="page-count">
            {isFiltered ? `${filtered.length} / ${jobs.length}` : `${total.toLocaleString()} total`}
          </span>
        )}
      </div>

      {/* ── Filter Bar ── */}
      <div className="filter-bar">
        {/* ID search */}
        <div className="filter-field">
          <label className="filter-label">Job ID</label>
          <input
            className="filter-input"
            type="text"
            placeholder="Search by exact or partial ID…"
            value={idFilter}
            onChange={e => setIdFilter(e.target.value)}
            spellCheck={false}
          />
        </div>

        {/* Time range */}
        <div className="filter-field">
          <label className="filter-label">Time range</label>
          <select
            className="filter-select"
            value={timePreset}
            onChange={e => setTimePreset(e.target.value)}
          >
            {TIME_PRESETS.map(p => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </div>

        {/* Custom date range */}
        {timePreset === 'custom' && (
          <div className="filter-field filter-field--daterange">
            <label className="filter-label">From</label>
            <input
              className="filter-input"
              type="datetime-local"
              value={customFrom}
              onChange={e => setCustomFrom(e.target.value)}
            />
            <label className="filter-label" style={{ marginTop: '0.5rem' }}>To</label>
            <input
              className="filter-input"
              type="datetime-local"
              value={customTo}
              onChange={e => setCustomTo(e.target.value)}
            />
          </div>
        )}

        {/* Clear */}
        {isFiltered && (
          <button className="btn btn-sm filter-clear" onClick={clearFilters}>
            ✕ Clear
          </button>
        )}
      </div>

      {/* ── Status pills ── */}
      <div className="filter-status-row">
        <span className="filter-label">Status</span>
        <div className="filter-status-pills">
          {ALL_STATUSES.map(s => (
            <button
              key={s}
              className={`status-pill status-pill--${s}${statusFilter.includes(s) ? ' status-pill--active' : ''}`}
              onClick={() => toggleStatus(s)}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      <div className="table-card">
        <table className="data-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Type</th>
              <th>Status</th>
              <th>Progress</th>
              <th>Attempts</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  <div className="empty-state">
                    <span className="empty-state-icon">◈</span>
                    <div>{isFiltered ? 'No jobs match the current filters' : 'No jobs yet'}</div>
                    <div className="empty-state-text">
                      {isFiltered
                        ? 'Try adjusting or clearing your filters.'
                        : 'Jobs will appear here once they are enqueued.'}
                    </div>
                  </div>
                </td>
              </tr>
            ) : (
              filtered.map((job) => (
                <tr key={job.id}>
                  <td>
                    <Link to={`/jobs/${job.id}`} className="id-link">
                      {job.id}
                    </Link>
                  </td>
                  <td><code>{job.type}</code></td>
                  <td><StatusBadge status={job.status} /></td>
                  <td><ProgressBar value={job.progress ?? 0} /></td>
                  <td style={{ color: 'var(--text-muted)' }}>{job.attempts}/{job.maxAttempts}</td>
                  <td style={{ color: 'var(--text-muted)' }}>{new Date(job.createdAt).toLocaleString()}</td>
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
            Page {page + 1} of {Math.ceil(total / pageSize)} &nbsp;·&nbsp; {total.toLocaleString()} jobs
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
