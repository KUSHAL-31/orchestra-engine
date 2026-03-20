import React from 'react';

export function ProgressBar({ value }: { value: number }) {
  return (
    <div className="progress-bar">
      <div
        className="progress-bar-fill"
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
      <span className="progress-bar-text">{value}%</span>
    </div>
  );
}
