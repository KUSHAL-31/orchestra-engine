import React, { useEffect, useState, useMemo } from 'react';
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import {
  format, subHours, subDays, formatDistanceToNow,
} from 'date-fns';
import { api } from '../api/client';
import type { Worker, DLQEntry } from '../api/types';

/* ─── Types ─────────────────────────────────────────────────── */
type TimeRange = '1H' | '6H' | '24H' | '7D' | '30D';

interface StatusCount {
  name: string;
  value: number;
  fill: string;
}

type DbStats = {
  jobs:      { total: number; completed: number; failed: number; running: number; pending: number; retrying: number };
  workflows: { total: number; completed: number; failed: number; running: number; pending: number };
};

type ChartData = {
  timeseries:        Array<{ bucket: string; created: number; completed: number; failed: number }>;
  durationByType:    Array<{ type: string; avgMs: number }>;
  topFailingTypes:   Array<{ type: string; failures: number }>;
  retryDistribution: Array<{ label: string; count: number }>;
  hourlyActivity:    Array<{ hour: string; count: number }>;
  jobTypeVolume:     Array<{ type: string; count: number }>;
  recentFailures:    Array<{ id: string; type: string; status: string; error: string | null; createdAt: string }>;
  performance:       { p50: number; p95: number; p99: number; avg: number };
  retryRate:         number;
  uniqueTypes:       number;
};

/* ─── Constants ──────────────────────────────────────────────── */
const TIME_RANGES: TimeRange[] = ['1H', '6H', '24H', '7D', '30D'];

const RANGE_HOURS: Record<TimeRange, number> = {
  '1H': 1, '6H': 6, '24H': 24, '7D': 168, '30D': 720,
};

/* ─── Helpers ────────────────────────────────────────────────── */
function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

function pct(num: number, total: number): number {
  return total > 0 ? Math.round((num / total) * 100) : 0;
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + '…' : str;
}

function getStartDate(range: TimeRange): Date {
  const now = new Date();
  switch (range) {
    case '1H': return subHours(now, 1);
    case '6H': return subHours(now, 6);
    case '24H': return subHours(now, 24);
    case '7D': return subDays(now, 7);
    case '30D': return subDays(now, 30);
  }
}

function formatBucketLabel(bucket: string, range: TimeRange): string {
  const d = new Date(bucket);
  switch (range) {
    case '1H':
    case '6H':  return format(d, 'HH:mm');
    case '24H': return format(d, 'HH:00');
    case '7D':
    case '30D': return format(d, 'MMM d');
  }
}

/* ─── Custom Tooltip ─────────────────────────────────────────── */
function ChartTooltip({ active, payload, label, valueFormatter }: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color?: string; fill?: string }>;
  label?: string;
  valueFormatter?: (v: number, name: string) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      {label && <div className="chart-tooltip-label">{label}</div>}
      {payload.map((p, i) => (
        <div key={i} className="chart-tooltip-row">
          <span className="chart-tooltip-dot" style={{ background: p.color || p.fill }} />
          <span className="chart-tooltip-name">{p.name}</span>
          <span className="chart-tooltip-value">
            {valueFormatter ? valueFormatter(p.value, p.name) : p.value}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ─── KPI Card ───────────────────────────────────────────────── */
function KpiCard({ label, value, sub, accent }: {
  label: string;
  value: string | number;
  sub?: string;
  accent?: 'primary' | 'success' | 'warning' | 'danger' | 'purple' | 'cyan';
}) {
  return (
    <div className={`kpi-card${accent ? ` kpi-card--${accent}` : ''}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

/* ─── Chart Card Wrapper ─────────────────────────────────────── */
function ChartCard({ title, subtitle, children }: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="chart-card">
      <div className="chart-card-header">
        <div>
          <div className="chart-title">{title}</div>
          {subtitle && <div className="chart-subtitle">{subtitle}</div>}
        </div>
      </div>
      {children}
    </div>
  );
}

/* ─── Empty Chart State ──────────────────────────────────────── */
function ChartEmpty({ icon, text }: { icon: string; text: string }) {
  return (
    <div className="empty-state" style={{ padding: '3rem 1rem' }}>
      <span className="empty-state-icon">{icon}</span>
      <div>{text}</div>
    </div>
  );
}

/* ─── Main View ──────────────────────────────────────────────── */
export function AnalyticsView() {
  const [timeRange, setTimeRange] = useState<TimeRange>('24H');
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [dlq, setDlq] = useState<DLQEntry[]>([]);
  const [dbStats, setDbStats] = useState<DbStats | null>(null);
  const [chartData, setChartData] = useState<ChartData | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState(new Date());

  // Fetch DB-accurate counts + server-side chart aggregations — refreshes every 30s
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const from = getStartDate(timeRange).toISOString();
        const [w, d, s, c] = await Promise.all([
          api.getWorkers(),
          api.getDLQ(),
          api.getAnalyticsStats(from),
          api.getAnalyticsCharts(timeRange),
        ]);
        if (!cancelled) {
          setWorkers((w as Worker[]) || []);
          setDlq((d as DLQEntry[]) || []);
          setDbStats(s);
          setChartData(c);
          setLastUpdated(new Date());
        }
      } catch (e) {
        console.error('Analytics fetch error:', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    const interval = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [timeRange]);

  /* ─── Derived KPI values from DB counts ──────────────────────── */
  const jobTotal     = dbStats?.jobs.total     ?? 0;
  const jobCompleted = dbStats?.jobs.completed ?? 0;
  const jobFailed    = dbStats?.jobs.failed    ?? 0;
  const jobRunning   = dbStats?.jobs.running   ?? 0;
  const jobPending   = dbStats?.jobs.pending   ?? 0;
  const jobRetrying  = dbStats?.jobs.retrying  ?? 0;
  const wfTotal      = dbStats?.workflows.total     ?? 0;
  const wfCompleted  = dbStats?.workflows.completed ?? 0;
  const wfFailed     = dbStats?.workflows.failed    ?? 0;
  const wfRunning    = dbStats?.workflows.running   ?? 0;
  const wfPending    = dbStats?.workflows.pending   ?? 0;

  const aliveWorkers = workers.filter(w => w.isAlive).length;
  const successRate  = pct(jobCompleted, jobTotal);
  const errorRate    = pct(jobFailed, jobTotal);
  const wfSuccessRate = pct(wfCompleted, wfTotal);
  const throughput   = RANGE_HOURS[timeRange] > 0
    ? (jobTotal / RANGE_HOURS[timeRange]).toFixed(1)
    : '0';

  const perf = chartData?.performance ?? { p50: 0, p95: 0, p99: 0, avg: 0 };

  /* ─── Peak hour from hourly activity ────────────────────────── */
  const peak = useMemo(() => {
    const activity = chartData?.hourlyActivity ?? [];
    if (!activity.length) return { hour: -1, count: 0 };
    let maxCount = 0, maxHour = -1;
    activity.forEach((h, i) => {
      if (h.count > maxCount) { maxCount = h.count; maxHour = i; }
    });
    return { hour: maxHour, count: maxCount };
  }, [chartData]);

  /* ─── Status pie counts ──────────────────────────────────────── */
  const jobStatusCounts = useMemo((): StatusCount[] => [
    { name: 'Completed', value: jobCompleted, fill: '#4ade80' },
    { name: 'Failed',    value: jobFailed,    fill: '#f87171' },
    { name: 'Running',   value: jobRunning,   fill: '#60a5fa' },
    { name: 'Pending',   value: jobPending,   fill: '#94a3b8' },
    { name: 'Retrying',  value: jobRetrying,  fill: '#fbbf24' },
  ].filter(s => s.value > 0), [dbStats]); // eslint-disable-line react-hooks/exhaustive-deps

  const wfStatusCounts = useMemo((): StatusCount[] => [
    { name: 'Completed', value: wfCompleted, fill: '#4ade80' },
    { name: 'Failed',    value: wfFailed,    fill: '#f87171' },
    { name: 'Running',   value: wfRunning,   fill: '#60a5fa' },
    { name: 'Pending',   value: wfPending,   fill: '#94a3b8' },
  ].filter(s => s.value > 0), [dbStats]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ─── Chart data derived from server response ────────────────── */
  const timeSeriesData = useMemo(() =>
    (chartData?.timeseries ?? []).map(b => ({
      label:     formatBucketLabel(b.bucket, timeRange),
      created:   b.created,
      completed: b.completed,
      failed:    b.failed,
    })),
  [chartData, timeRange]);

  const durationData = useMemo(() =>
    (chartData?.durationByType ?? []).map(d => ({ ...d, type: truncate(d.type, 13) })),
  [chartData]);

  const topFailingTypes = useMemo(() =>
    (chartData?.topFailingTypes ?? []).map(d => ({ ...d, type: truncate(d.type, 13) })),
  [chartData]);

  const retryData = chartData?.retryDistribution ?? [];

  const topTypes = useMemo(() => {
    const vol = chartData?.jobTypeVolume ?? [];
    if (!vol.length) return [];
    const max = vol[0].count;
    return vol.map(t => ({ ...t, rate: max > 0 ? t.count / max : 0 }));
  }, [chartData]);

  const hourlyActivity = useMemo(() =>
    (chartData?.hourlyActivity ?? []).map((d, i) => ({
      ...d,
      fill: i === peak.hour && d.count > 0 ? '#f59e0b' : '#1e3a5f',
    })),
  [chartData, peak]);

  const recentFailures = chartData?.recentFailures ?? [];

  if (loading) {
    return (
      <div className="view">
        <div className="loader"><span className="spinner" />Loading analytics…</div>
      </div>
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const durationTooltip = (props: any) => (
    <ChartTooltip {...props} valueFormatter={(v: number) => formatDuration(v)} />
  );

  return (
    <div className="view analytics-view">

      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="analytics-header">
        <div>
          <h1 className="page-title">Analytics</h1>
          <div className="analytics-header-sub">
            {jobTotal.toLocaleString()} jobs in window · refreshed at {format(lastUpdated, 'HH:mm:ss')}
          </div>
        </div>
        <div className="time-range-pills">
          {TIME_RANGES.map(r => (
            <button
              key={r}
              className={`time-range-pill${timeRange === r ? ' time-range-pill--active' : ''}`}
              onClick={() => setTimeRange(r)}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {/* ── KPI Cards ──────────────────────────────────────────── */}
      <div className="kpi-grid">
        <KpiCard
          label="Total Jobs"
          value={jobTotal.toLocaleString()}
          sub={`${throughput} jobs/hr avg`}
          accent="primary"
        />
        <KpiCard
          label="Success Rate"
          value={`${successRate}%`}
          sub={`${jobCompleted.toLocaleString()} completed`}
          accent={successRate >= 90 ? 'success' : successRate >= 70 ? 'warning' : 'danger'}
        />
        <KpiCard
          label="Avg Duration"
          value={formatDuration(perf.avg)}
          sub="mean execution time"
        />
        <KpiCard
          label="Active Workers"
          value={aliveWorkers}
          sub={`of ${workers.length} total`}
          accent={aliveWorkers > 0 ? 'success' : workers.length > 0 ? 'danger' : undefined}
        />
        <KpiCard
          label="Running Now"
          value={jobRunning.toLocaleString()}
          sub={`${jobPending.toLocaleString()} queued`}
          accent="cyan"
        />
        <KpiCard
          label="DLQ Failures"
          value={dlq.length}
          sub={dlq.length > 0 ? 'needs attention' : 'queue clear'}
          accent={dlq.length > 0 ? 'danger' : undefined}
        />
        <KpiCard
          label="Total Workflows"
          value={wfTotal.toLocaleString()}
          sub={`${wfRunning} running`}
          accent="purple"
        />
        <KpiCard
          label="Workflow Success"
          value={`${wfSuccessRate}%`}
          sub={`${wfCompleted} completed`}
          accent={wfTotal === 0 ? undefined : wfSuccessRate >= 90 ? 'success' : wfSuccessRate >= 70 ? 'warning' : 'danger'}
        />
      </div>

      {/* ── Job Activity Timeline ──────────────────────────────── */}
      <ChartCard
        title="Job Activity"
        subtitle="Created, completed and failed jobs over selected period"
      >
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={timeSeriesData} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
            <defs>
              <linearGradient id="gCreated" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="gCompleted" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#22c55e" stopOpacity={0.25} />
                <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="gFailed" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#ef4444" stopOpacity={0.2} />
                <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#1e2d47" vertical={false} />
            <XAxis dataKey="label" tick={{ fill: '#64748b', fontSize: 11 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
            <YAxis tick={{ fill: '#64748b', fontSize: 11 }} tickLine={false} axisLine={false} allowDecimals={false} />
            <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
            <Legend iconType="circle" iconSize={7} wrapperStyle={{ fontSize: '0.72rem', color: '#64748b', paddingTop: '0.5rem' }} />
            <Area type="monotone" dataKey="created"   name="Created"   stroke="#3b82f6" strokeWidth={1.5} fill="url(#gCreated)"   dot={false} activeDot={{ r: 3 }} />
            <Area type="monotone" dataKey="completed" name="Completed" stroke="#22c55e" strokeWidth={1.5} fill="url(#gCompleted)" dot={false} activeDot={{ r: 3 }} />
            <Area type="monotone" dataKey="failed"    name="Failed"    stroke="#ef4444" strokeWidth={1.5} fill="url(#gFailed)"    dot={false} activeDot={{ r: 3 }} />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* ── Status Distribution + Workflow Status + Duration ─────── */}
      <div className="charts-3col">
        <ChartCard title="Job Status" subtitle={`${jobTotal.toLocaleString()} jobs in range`}>
          {jobStatusCounts.length > 0 ? (
            <ResponsiveContainer width="100%" height={230}>
              <PieChart>
                <Pie
                  data={jobStatusCounts}
                  cx="50%"
                  cy="48%"
                  innerRadius={58}
                  outerRadius={82}
                  paddingAngle={3}
                  dataKey="value"
                />
                <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                <Legend
                  iconType="circle"
                  iconSize={7}
                  wrapperStyle={{ fontSize: '0.72rem', color: '#64748b' }}
                />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <ChartEmpty icon="◎" text="No jobs in selected range" />
          )}
        </ChartCard>

        <ChartCard title="Workflow Status" subtitle={`${wfTotal.toLocaleString()} workflows in range`}>
          {wfStatusCounts.length > 0 ? (
            <ResponsiveContainer width="100%" height={230}>
              <PieChart>
                <Pie
                  data={wfStatusCounts}
                  cx="50%"
                  cy="48%"
                  innerRadius={58}
                  outerRadius={82}
                  paddingAngle={3}
                  dataKey="value"
                />
                <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                <Legend iconType="circle" iconSize={7} wrapperStyle={{ fontSize: '0.72rem', color: '#64748b' }} />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <ChartEmpty icon="⬡" text="No workflows in selected range" />
          )}
        </ChartCard>

        <ChartCard title="Avg Duration by Job Type" subtitle="Mean execution time per type">
          {durationData.length > 0 ? (
            <ResponsiveContainer width="100%" height={230}>
              <BarChart data={durationData} layout="vertical" margin={{ top: 0, right: 30, left: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e2d47" horizontal={false} />
                <XAxis
                  type="number"
                  tick={{ fill: '#64748b', fontSize: 10 }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v) => formatDuration(v)}
                />
                <YAxis
                  type="category"
                  dataKey="type"
                  tick={{ fill: '#64748b', fontSize: 10 }}
                  tickLine={false}
                  axisLine={false}
                  width={88}
                />
                <Tooltip content={durationTooltip} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                <Bar dataKey="avgMs" name="Avg Duration" fill="#3b82f6" radius={[0, 3, 3, 0]} maxBarSize={16} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <ChartEmpty icon="⏱" text="No completed jobs with duration data" />
          )}
        </ChartCard>
      </div>

      {/* ── Top Failing Types + Retry Distribution ────────────── */}
      <div className="charts-2col">
        <ChartCard title="Top Failing Job Types" subtitle="Job types with highest failure count">
          {topFailingTypes.length > 0 ? (
            <ResponsiveContainer width="100%" height={210}>
              <BarChart data={topFailingTypes} layout="vertical" margin={{ top: 0, right: 30, left: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e2d47" horizontal={false} />
                <XAxis type="number" tick={{ fill: '#64748b', fontSize: 10 }} tickLine={false} axisLine={false} allowDecimals={false} />
                <YAxis type="category" dataKey="type" tick={{ fill: '#64748b', fontSize: 10 }} tickLine={false} axisLine={false} width={88} />
                <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                <Bar dataKey="failures" name="Failures" fill="#ef4444" radius={[0, 3, 3, 0]} maxBarSize={16} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <ChartEmpty icon="✓" text="No failures in this range" />
          )}
        </ChartCard>

        <ChartCard title="Retry Distribution" subtitle="Jobs grouped by number of execution attempts">
          {retryData.length > 0 ? (
            <ResponsiveContainer width="100%" height={210}>
              <BarChart data={retryData} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e2d47" vertical={false} />
                <XAxis dataKey="label" tick={{ fill: '#64748b', fontSize: 11 }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fill: '#64748b', fontSize: 11 }} tickLine={false} axisLine={false} allowDecimals={false} />
                <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                <Bar dataKey="count" name="Jobs" fill="#8b5cf6" radius={[3, 3, 0, 0]} maxBarSize={40} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <ChartEmpty icon="↻" text="No retry data available" />
          )}
        </ChartCard>
      </div>

      {/* ── Activity by Hour ───────────────────────────────────── */}
      <ChartCard title="Activity by Hour of Day" subtitle="Job creation volume broken down by hour (based on filtered range)">
        <ResponsiveContainer width="100%" height={160}>
          <BarChart data={hourlyActivity} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1e2d47" vertical={false} />
            <XAxis
              dataKey="hour"
              tick={{ fill: '#64748b', fontSize: 10 }}
              tickLine={false}
              axisLine={false}
              interval={2}
            />
            <YAxis tick={{ fill: '#64748b', fontSize: 11 }} tickLine={false} axisLine={false} allowDecimals={false} />
            <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
            <Bar dataKey="count" name="Jobs" radius={[2, 2, 0, 0]} maxBarSize={18} />
          </BarChart>
        </ResponsiveContainer>
        {peak.count > 0 && (
          <div className="chart-peak-note">
            Peak at {String(peak.hour).padStart(2, '0')}:00 — {peak.count} jobs
          </div>
        )}
      </ChartCard>

      {/* ── Performance Metrics ────────────────────────────────── */}
      <div className="analytics-section-header">
        <div className="analytics-section-title">Performance Metrics</div>
      </div>
      <div className="adv-stats-grid">
        {[
          { label: 'P50 Duration',   value: formatDuration(perf.p50),          sub: 'median latency' },
          { label: 'P95 Duration',   value: formatDuration(perf.p95),          sub: '95th percentile' },
          { label: 'P99 Duration',   value: formatDuration(perf.p99),          sub: '99th percentile' },
          { label: 'Throughput',     value: `${throughput}`,                    sub: 'jobs / hour avg' },
          { label: 'Error Rate',     value: `${errorRate}%`,                   sub: `${jobFailed.toLocaleString()} failures`, danger: errorRate > 10 },
          { label: 'Retry Rate',     value: `${chartData?.retryRate ?? 0}%`,   sub: 'jobs retried ≥1×' },
          { label: 'Peak Hour',      value: peak.count > 0 ? `${String(peak.hour).padStart(2, '0')}:00` : '—', sub: peak.count > 0 ? `${peak.count} jobs` : 'no activity' },
          { label: 'Unique Types',   value: chartData?.uniqueTypes ?? 0,       sub: 'job types seen' },
        ].map((s, i) => (
          <div key={i} className="adv-stat-item">
            <div className="adv-stat-label">{s.label}</div>
            <div className="adv-stat-value" style={(s as { danger?: boolean }).danger ? { color: '#f87171' } : undefined}>
              {s.value}
            </div>
            <div className="adv-stat-sub">{s.sub}</div>
          </div>
        ))}
      </div>

      {/* ── Recent Failures + Job Type Volume ─────────────────── */}
      <div className="charts-2col">
        <ChartCard title="Recent Failures" subtitle="Latest failed jobs in selected range">
          {recentFailures.length > 0 ? (
            <div className="failures-list">
              {recentFailures.map(job => (
                <div key={job.id} className="failure-item">
                  <div className="failure-item-left">
                    <div className="failure-type">{job.type}</div>
                    {job.error && (
                      <div className="failure-error" title={job.error}>{job.error}</div>
                    )}
                  </div>
                  <div className="failure-time">
                    {formatDistanceToNow(new Date(job.createdAt), { addSuffix: true })}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <ChartEmpty icon="✓" text="No failures in selected range" />
          )}
        </ChartCard>

        <ChartCard title="Job Type Volume" subtitle="Most active job types by count">
          {topTypes.length > 0 ? (
            <div className="job-types-list">
              {topTypes.map(({ type, count, rate }) => (
                <div key={type} className="job-type-item">
                  <div className="job-type-name" title={type}>{type}</div>
                  <div className="job-type-bar-wrap">
                    <div className="job-type-bar-fill" style={{ width: `${rate * 100}%` }} />
                  </div>
                  <div className="job-type-count">{count}</div>
                </div>
              ))}
            </div>
          ) : (
            <ChartEmpty icon="◈" text="No job data in range" />
          )}
        </ChartCard>
      </div>

    </div>
  );
}
