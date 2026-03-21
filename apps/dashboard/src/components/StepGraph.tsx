import React from 'react';

interface Step {
  id: string;
  name: string;
  status: string;
  dependsOn: string[];
  parallelGroup: string | null;
  position: number;
}

const STATUS_COLORS: Record<string, { border: string; dot: string; text: string }> = {
  pending:   { border: '#1e2d47', dot: '#475569', text: '#64748b' },
  running:   { border: 'rgba(59,130,246,0.4)',  dot: '#3b82f6', text: '#60a5fa' },
  completed: { border: 'rgba(34,197,94,0.4)',   dot: '#22c55e', text: '#4ade80' },
  failed:    { border: 'rgba(239,68,68,0.4)',   dot: '#ef4444', text: '#f87171' },
  skipped:   { border: '#1e2d47', dot: '#475569', text: '#64748b' },
};

interface Props {
  steps: Step[];
}

export function StepGraph({ steps }: Props) {
  return (
    <div className="step-graph">
      {steps.map((step) => {
        const colors = STATUS_COLORS[step.status] ?? STATUS_COLORS.pending;
        return (
          <div
            key={step.id}
            className="step-node"
            style={{ borderColor: colors.border }}
          >
            <div
              className="step-node-indicator"
              style={{ background: colors.dot }}
            />
            <div className="step-name">{step.name}</div>
            <div className="step-status" style={{ color: colors.text }}>{step.status}</div>
            {step.parallelGroup && (
              <div className="step-group">Group: {step.parallelGroup}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}
