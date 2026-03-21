import React from 'react';

const BADGE_STYLES: Record<string, { bg: string; color: string }> = {
  pending:   { bg: 'rgba(100, 116, 139, 0.15)', color: '#94a3b8' },
  running:   { bg: 'rgba(59,  130, 246, 0.15)', color: '#60a5fa' },
  completed: { bg: 'rgba(34,  197,  94, 0.15)', color: '#4ade80' },
  failed:    { bg: 'rgba(239,  68,  68, 0.15)', color: '#f87171' },
  retrying:  { bg: 'rgba(245, 158,  11, 0.15)', color: '#fbbf24' },
  dead:      { bg: 'rgba(100, 116, 139, 0.12)', color: '#64748b' },
  skipped:   { bg: 'rgba(100, 116, 139, 0.12)', color: '#64748b' },
  active:    { bg: 'rgba(34,  197,  94, 0.15)', color: '#4ade80' },
  inactive:  { bg: 'rgba(100, 116, 139, 0.12)', color: '#64748b' },
};

export function StatusBadge({ status }: { status: string }) {
  const key = status.toLowerCase();
  const style = BADGE_STYLES[key] ?? { bg: 'rgba(100,116,139,0.15)', color: '#94a3b8' };
  return (
    <span
      className="status-badge"
      style={{ backgroundColor: style.bg, color: style.color }}
    >
      {status}
    </span>
  );
}
