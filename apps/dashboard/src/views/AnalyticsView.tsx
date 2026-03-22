import React, { useEffect, useState, useMemo } from 'react';
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import {
  format, subHours, subDays, startOfHour, startOfDay, formatDistanceToNow,
} from 'date-fns';
import { api } from '../api/client';
import type { Job, Worker, DLQEntry } from '../api/types';

/* ─── Types ─────────────────────────────────────────────────── */
type TimeRange = '1H' | '6H' | '24H' | '7D' | '30D';

interface BucketPoint {
  label: string;
  created: number;
  completed: number;
  failed: number;
}

interface StatusCount {
  name: string;
  value: number;
  color: string;
}

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

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
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

function bucketJobs(jobs: Job[], range: TimeRange): BucketPoint[] {
  const now = new Date();
  const start = getStartDate(range);
  let bucketMs: number;
  let labelFn: (d: Date) => string;

  switch (range) {
    case '1H':  bucketMs = 5 * 60 * 1000;       labelFn = d => format(d, 'HH:mm'); break;
    case '6H':  bucketMs = 30 * 60 * 1000;      labelFn = d => format(d, 'HH:mm'); break;
    case '24H': bucketMs = 60 * 60 * 1000;      labelFn = d => format(d, 'HH:00'); break;
    case '7D':  bucketMs = 24 * 60 * 60 * 1000; labelFn = d => format(d, 'MMM d'); break;
    case '30D': bucketMs = 24 * 60 * 60 * 1000; labelFn = d => format(d, 'MMM d'); break;
  }

  // Pre-generate all buckets so chart is never sparse
  const buckets = new Map<number, BucketPoint>();
  let t = Math.floor(start.getTime() / bucketMs) * bucketMs;
  while (t <= now.getTime()) {
    buckets.set(t, { label: labelFn(new Date(t)), created: 0, completed: 0, failed: 0 });
    t += bucketMs;
  }

  for (const job of jobs) {
    const ts = new Date(job.createdAt).getTime();
    if (ts < start.getTime()) continue;
    const key = Math.floor(ts / bucketMs) * bucketMs;
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.created++;
      if (job.status === 'completed') bucket.completed++;
      if (job.status === 'failed' || job.status === 'dead') bucket.failed++;
    }
  }

  return Array.from(buckets.values());
}

function computeDurationByType(jobs: Job[]): { type: string; avgMs: number }[] {
  const map = new Map<string, number[]>();
  for (const job of jobs) {
    if (job.startedAt && job.completedAt) {
      const dur = new Date(job.completedAt).getTime() - new Date(job.startedAt).getTime();
      if (dur > 0) {
        if (!map.has(job.type)) map.set(job.type, []);
        map.get(job.type)!.push(dur);
      }
    }
  }
  return Array.from(map.entries())
    .map(([type, durs]) => ({ type, avgMs: durs.reduce((a, b) => a + b, 0) / durs.length }))
    .sort((a, b) => b.avgMs - a.avgMs)
    .slice(0, 8);
}

function computeRetryDistribution(jobs: Job[]): { label: string; count: number }[] {
  const counts = new Map<number, number>();
  for (const job of jobs) {
    const a = job.attempts ?? 0;
    counts.set(a, (counts.get(a) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([attempts, count]) => ({ label: `${attempts}x`, count }));
}

function computeTopJobTypes(jobs: Job[]): { type: string; count: number; rate: number }[] {
  const counts = new Map<string, number>();
  for (const job of jobs) counts.set(job.type, (counts.get(job.type) || 0) + 1);
  const max = counts.size > 0 ? Math.max(...counts.values()) : 1;
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([type, count]) => ({ type, count, rate: count / max }));
}

function computeTopFailingTypes(jobs: Job[]): { type: string; failures: number }[] {
  const map = new Map<string, number>();
  for (const job of jobs) {
    if (job.status === 'failed' || job.status === 'dead') {
      map.set(job.type, (map.get(job.type) || 0) + 1);
    }
  }
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([type, failures]) => ({ type, failures }));
}

function computeHourlyActivity(jobs: Job[]): { hour: string; count: number }[] {
  const counts = new Array(24).fill(0);
  for (const job of jobs) counts[new Date(job.createdAt).getHours()]++;
  return counts.map((count, h) => ({ hour: `${String(h).padStart(2, '0')}:00`, count }));
}

function computePeakHour(jobs: Job[]): { hour: number; count: number } {
  const counts = new Array(24).fill(0);
  for (const job of jobs) counts[new Date(job.createdAt).getHours()]++;
  const max = Math.max(...counts);
  return { hour: counts.indexOf(max), count: max };
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
  const [jobs, setJobs] = useState<Job[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [dlq, setDlq] = useState<DLQEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState(new Date());

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const [j, w, d] = await Promise.all([
          api.getJobs(),
          api.getWorkers(),
          api.getDLQ(),
        ]);
        if (!cancelled) {
          setJobs((j as Job[]) || []);
          setWorkers((w as Worker[]) || []);
          setDlq((d as DLQEntry[]) || []);
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
  }, []);

  /* ─── Filtered jobs by time range ───────────────────────────── */
  const filteredJobs = useMemo(() => {
    const start = getStartDate(timeRange);
    return jobs.filter(j => new Date(j.createdAt) >= start);
  }, [jobs, timeRange]);

  /* ─── Core stats ─────────────────────────────────────────────── */
  const stats = useMemo(() => {
    const total     = filteredJobs.length;
    const completed = filteredJobs.filter(j => j.status === 'completed').length;
    const failed    = filteredJobs.filter(j => j.status === 'failed' || j.status === 'dead').length;
    const running   = filteredJobs.filter(j => j.status === 'running').length;
    const pending   = filteredJobs.filter(j => j.status === 'pending').length;
    const retrying  = filteredJobs.filter(j => j.status === 'retrying').length;
    const skipped   = filteredJobs.filter(j => j.status === 'skipped').length;

    const successRate = pct(completed, total);
    const errorRate   = pct(failed, total);

    const durations = filteredJobs
      .filter(j => j.startedAt && j.completedAt)
      .map(j => new Date(j.completedAt!).getTime() - new Date(j.startedAt!).getTime())
      .filter(d => d > 0)
      .sort((a, b) => a - b);

    const avgDuration = durations.length > 0
      ? durations.reduce((a, b) => a + b, 0) / durations.length
      : 0;
    const p50 = percentile(durations, 50);
    const p95 = percentile(durations, 95);
    const p99 = percentile(durations, 99);

    const aliveWorkers = workers.filter(w => w.isAlive).length;

    const retriedJobs = filteredJobs.filter(j => (j.attempts ?? 0) > 1).length;
    const retryRate = pct(retriedJobs, total);

    const throughput = RANGE_HOURS[timeRange] > 0
      ? (total / RANGE_HOURS[timeRange]).toFixed(1)
      : '0';

    const peak = computePeakHour(filteredJobs);

    const uniqueTypes = new Set(filteredJobs.map(j => j.type)).size;

    const statusCounts: StatusCount[] = [
      { name: 'Completed', value: completed, color: '#4ade80' },
      { name: 'Failed',    value: failed,    color: '#f87171' },
      { name: 'Running',   value: running,   color: '#60a5fa' },
      { name: 'Pending',   value: pending,   color: '#94a3b8' },
      { name: 'Retrying',  value: retrying,  color: '#fbbf24' },
      { name: 'Skipped',   value: skipped,   color: '#64748b' },
    ].filter(s => s.value > 0);

    return {
      total, completed, failed, running, pending, retrying,
      successRate, errorRate, avgDuration, durations,
      p50, p95, p99, aliveWorkers, retryRate, throughput,
      peak, uniqueTypes, statusCounts,
    };
  }, [filteredJobs, workers, timeRange]);

  /* ─── Chart data ─────────────────────────────────────────────── */
  const timeSeriesData   = useMemo(() => bucketJobs(filteredJobs, timeRange), [filteredJobs, timeRange]);
  const durationData     = useMemo(() => computeDurationByType(filteredJobs).map(d => ({ ...d, type: truncate(d.type, 13) })), [filteredJobs]);
  const retryData        = useMemo(() => computeRetryDistribution(filteredJobs), [filteredJobs]);
  const topTypes         = useMemo(() => computeTopJobTypes(filteredJobs), [filteredJobs]);
  const topFailingTypes  = useMemo(() => computeTopFailingTypes(filteredJobs).map(d => ({ ...d, type: truncate(d.type, 13) })), [filteredJobs]);
  const hourlyActivity   = useMemo(() => computeHourlyActivity(filteredJobs), [filteredJobs]);
  const recentFailures   = useMemo(() =>
    filteredJobs
      .filter(j => j.status === 'failed' || j.status === 'dead')
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 8),
    [filteredJobs],
  );

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
            {stats.total} jobs · refreshed at {format(lastUpdated, 'HH:mm:ss')}
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
          value={stats.total.toLocaleString()}
          sub={`${stats.throughput} jobs/hr`}
          accent="primary"
        />
        <KpiCard
          label="Success Rate"
          value={`${stats.successRate}%`}
          sub={`${stats.completed.toLocaleString()} completed`}
          accent={stats.successRate >= 90 ? 'success' : stats.successRate >= 70 ? 'warning' : 'danger'}
        />
        <KpiCard
          label="Avg Duration"
          value={formatDuration(stats.avgDuration)}
          sub={`${stats.durations.length} measured`}
        />
        <KpiCard
          label="Active Workers"
          value={stats.aliveWorkers}
          sub={`of ${workers.length} total`}
          accent={stats.aliveWorkers > 0 ? 'success' : workers.length > 0 ? 'danger' : undefined}
        />
        <KpiCard
          label="Running Now"
          value={stats.running}
          sub={`${stats.pending} queued`}
          accent="cyan"
        />
        <KpiCard
          label="DLQ Failures"
          value={dlq.length}
          sub={dlq.length > 0 ? 'needs attention' : 'queue clear'}
          accent={dlq.length > 0 ? 'danger' : undefined}
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
            <Tooltip content={<ChartTooltip />} />
            <Legend iconType="circle" iconSize={7} wrapperStyle={{ fontSize: '0.72rem', color: '#64748b', paddingTop: '0.5rem' }} />
            <Area type="monotone" dataKey="created"   name="Created"   stroke="#3b82f6" strokeWidth={1.5} fill="url(#gCreated)"   dot={false} activeDot={{ r: 3 }} />
            <Area type="monotone" dataKey="completed" name="Completed" stroke="#22c55e" strokeWidth={1.5} fill="url(#gCompleted)" dot={false} activeDot={{ r: 3 }} />
            <Area type="monotone" dataKey="failed"    name="Failed"    stroke="#ef4444" strokeWidth={1.5} fill="url(#gFailed)"    dot={false} activeDot={{ r: 3 }} />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* ── Status Distribution + Duration by Type ────────────── */}
      <div className="charts-2col">
        <ChartCard title="Status Distribution" subtitle={`${stats.total} jobs in range`}>
          {stats.statusCounts.length > 0 ? (
            <ResponsiveContainer width="100%" height={230}>
              <PieChart>
                <Pie
                  data={stats.statusCounts}
                  cx="50%"
                  cy="48%"
                  innerRadius={58}
                  outerRadius={82}
                  paddingAngle={3}
                  dataKey="value"
                >
                  {stats.statusCounts.map((entry, i) => (
                    <Cell key={i} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip content={<ChartTooltip />} />
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
                <Tooltip content={durationTooltip} />
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
                <Tooltip content={<ChartTooltip />} />
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
                <Tooltip content={<ChartTooltip />} />
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
            <Tooltip content={<ChartTooltip />} />
            <Bar dataKey="count" name="Jobs" radius={[2, 2, 0, 0]} maxBarSize={18}>
              {hourlyActivity.map((entry, i) => (
                <Cell
                  key={i}
                  fill={i === stats.peak.hour && stats.peak.count > 0 ? '#f59e0b' : '#1e3a5f'}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
        {stats.peak.count > 0 && (
          <div className="chart-peak-note">
            Peak at {String(stats.peak.hour).padStart(2, '0')}:00 — {stats.peak.count} jobs
          </div>
        )}
      </ChartCard>

      {/* ── Performance Metrics ────────────────────────────────── */}
      <div className="analytics-section-header">
        <div className="analytics-section-title">Performance Metrics</div>
      </div>
      <div className="adv-stats-grid">
        {[
          { label: 'P50 Duration',   value: formatDuration(stats.p50),  sub: 'median latency' },
          { label: 'P95 Duration',   value: formatDuration(stats.p95),  sub: '95th percentile' },
          { label: 'P99 Duration',   value: formatDuration(stats.p99),  sub: '99th percentile' },
          { label: 'Throughput',     value: `${stats.throughput}`,      sub: 'jobs / hour avg' },
          { label: 'Error Rate',     value: `${stats.errorRate}%`,      sub: `${stats.failed} failures`, danger: stats.errorRate > 10 },
          { label: 'Retry Rate',     value: `${stats.retryRate}%`,      sub: 'jobs retried ≥1×' },
          { label: 'Peak Hour',      value: stats.peak.count > 0 ? `${String(stats.peak.hour).padStart(2, '0')}:00` : '—', sub: stats.peak.count > 0 ? `${stats.peak.count} jobs` : 'no activity' },
          { label: 'Unique Types',   value: stats.uniqueTypes,          sub: 'job types seen' },
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

      {/* ── Workers ────────────────────────────────────────────── */}
      {workers.length > 0 && (
        <div className="workers-analytics-section">
          <div className="analytics-section-header">
            <div className="analytics-section-title">Workers — {workers.length} registered</div>
            <div className="adv-stat-sub">
              <span style={{ color: '#4ade80' }}>●</span> {stats.aliveWorkers} alive
              &nbsp;&nbsp;
              <span style={{ color: '#475569' }}>●</span> {workers.length - stats.aliveWorkers} offline
            </div>
          </div>
          <div className="workers-analytics-grid">
            {workers.map(w => (
              <div
                key={w.id}
                className={`worker-analytics-card${w.isAlive ? ' worker-analytics-card--alive' : ''}`}
              >
                <div className="worker-analytics-header">
                  <div className="worker-analytics-id" title={w.id}>{w.id}</div>
                  <div className={`alive-dot ${w.isAlive ? 'alive' : 'dead'}`}>
                    {w.isAlive ? 'alive' : 'offline'}
                  </div>
                </div>
                <div className="worker-analytics-types">
                  {w.jobTypes.map(t => (
                    <span key={t} className="worker-type-tag" title={t}>{truncate(t, 16)}</span>
                  ))}
                </div>
                <div className="worker-analytics-heartbeat">
                  {formatDistanceToNow(new Date(w.lastHeartbeat), { addSuffix: true })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
