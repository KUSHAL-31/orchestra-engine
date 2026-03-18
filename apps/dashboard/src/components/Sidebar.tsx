import React from 'react';
import { NavLink } from 'react-router-dom';

const NAV_ITEMS = [
  { to: '/jobs',      label: 'Jobs',             icon: '◈' },
  { to: '/workflows', label: 'Workflows',         icon: '⬡' },
  { to: '/schedules', label: 'Schedules',         icon: '◷' },
  { to: '/dlq',       label: 'Dead Letter Queue', icon: '⚠' },
  { to: '/workers',   label: 'Workers',           icon: '⚙' },
];

export function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-logo">F</div>
        <h2>Forge Engine</h2>
      </div>
      <nav className="sidebar-nav">
        <div className="sidebar-nav-label">Navigation</div>
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              `sidebar-link ${isActive ? 'sidebar-link-active' : ''}`
            }
          >
            <span className="sidebar-link-icon">{item.icon}</span>
            {item.label}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
