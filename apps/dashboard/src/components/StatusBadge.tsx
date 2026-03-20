import React from 'react';

const BADGE_STYLES: Record<string, { bg: string; color: string }> = {
  pending:   { bg: '#f3f4f6', color: '#374151' },
  running:   { bg: '#dbeafe', color: '#1d4ed8' },
  completed: { bg: '#dcfce7', color: '#15803d' },
  failed:    { bg: '#fee2e2', color: '#b91c1c' },
  retrying:  { bg: '#fef3c7', color: '#b45309' },
  dead:      { bg: '#f3f4f6', color: '#6b7280' },
  skipped:   { bg: '#f3f4f6', color: '#6b7280' },
  active:    { bg: '#dcfce7', color: '#15803d' },
};

export function StatusBadge({ status }: { status: string }) {
  const style = BADGE_STYLES[status.toLowerCase()] ?? { bg: '#f3f4f6', color: '#374151' };
  return (
    <span
      className="status-badge"
      style={{ backgroundColor: style.bg, color: style.color }}
    >
      {status}
    </span>
  );
}
