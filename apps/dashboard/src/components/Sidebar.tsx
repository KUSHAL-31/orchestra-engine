import React, { useState } from 'react';
import { NavLink } from 'react-router-dom';

const NAV_ITEMS = [
  { to: '/jobs',      label: 'Jobs',             icon: '◈' },
  { to: '/workflows', label: 'Workflows',         icon: '⬡' },
  { to: '/schedules', label: 'Schedules',         icon: '◷' },
  { to: '/dlq',       label: 'Dead Letter Queue', icon: '⚠' },
  { to: '/workers',   label: 'Workers',           icon: '⚙' },
];

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside className={`sidebar${collapsed ? ' sidebar--collapsed' : ''}`}>
      <div className="sidebar-header">
        <div className="sidebar-logo">F</div>
        {!collapsed && <h2>Orchestra Engine</h2>}
        <button
          className="sidebar-toggle"
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? '›' : '‹'}
        </button>
      </div>
      <nav className="sidebar-nav">
        {!collapsed && <div className="sidebar-nav-label">Navigation</div>}
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            title={collapsed ? item.label : undefined}
            className={({ isActive }) =>
              `sidebar-link ${isActive ? 'sidebar-link-active' : ''}`
            }
          >
            <span className="sidebar-link-icon">{item.icon}</span>
            {!collapsed && item.label}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
