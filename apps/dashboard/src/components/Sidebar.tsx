import React from 'react';
import { NavLink } from 'react-router-dom';

const NAV_ITEMS = [
  { to: '/jobs', label: 'Jobs' },
  { to: '/workflows', label: 'Workflows' },
  { to: '/schedules', label: 'Schedules' },
  { to: '/dlq', label: 'Dead Letter Queue' },
  { to: '/workers', label: 'Workers' },
];

export function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <h2>Forge Engine</h2>
      </div>
      <nav className="sidebar-nav">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              `sidebar-link ${isActive ? 'sidebar-link-active' : ''}`
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
