import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Sidebar } from './components/Sidebar';
import { JobsView } from './views/JobsView';
import { JobDetailView } from './views/JobDetailView';
import { WorkflowsView } from './views/WorkflowsView';
import { WorkflowDetailView } from './views/WorkflowDetailView';
import { SchedulesView } from './views/SchedulesView';
import { DLQView } from './views/DLQView';
import { WorkersView } from './views/WorkersView';
import { useSSE } from './hooks/useSSE';

export function App() {
  useSSE();

  return (
    <BrowserRouter>
      <div className="app-layout">
        <Sidebar />
        <main className="app-main">
          <Routes>
            <Route path="/" element={<Navigate to="/jobs" replace />} />
            <Route path="/jobs" element={<JobsView />} />
            <Route path="/jobs/:id" element={<JobDetailView />} />
            <Route path="/workflows" element={<WorkflowsView />} />
            <Route path="/workflows/:id" element={<WorkflowDetailView />} />
            <Route path="/schedules" element={<SchedulesView />} />
            <Route path="/dlq" element={<DLQView />} />
            <Route path="/workers" element={<WorkersView />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
