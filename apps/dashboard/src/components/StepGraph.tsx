import React from 'react';

interface Step {
  id: string;
  name: string;
  status: string;
  dependsOn: string[];
  parallelGroup: string | null;
  position: number;
}

const STATUS_COLORS: Record<string, string> = {
  pending: '#6b7280',
  running: '#3b82f6',
  completed: '#22c55e',
  failed: '#ef4444',
  skipped: '#9ca3af',
};

interface Props {
  steps: Step[];
}

export function StepGraph({ steps }: Props) {
  return (
    <div className="step-graph">
      {steps.map((step) => (
        <div
          key={step.id}
          className="step-node"
          style={{ borderColor: STATUS_COLORS[step.status] ?? '#6b7280' }}
        >
          <div className="step-name">{step.name}</div>
          <div className="step-status" style={{ color: STATUS_COLORS[step.status] }}>{step.status}</div>
          {step.parallelGroup && (
            <div className="step-group">Group: {step.parallelGroup}</div>
          )}
        </div>
      ))}
    </div>
  );
}
