import { initialsOf } from '../lib/format.js';
import { supabase } from '../lib/supabase.js';
import { LockIcon, NAV_ICONS } from './icons.jsx';

const NAV_ITEMS = [
  { route: 'overview', label: 'Overview' },
  { route: 'incidents', label: 'Incidents' },
  { route: 'shifts', label: 'Shifts' },
  { route: 'zones', label: 'Zones' },
  { route: 'reports', label: 'Reports' },
];

export default function Sidebar({ pageKey, user }) {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand"><span className="wordmark">NODE</span></div>

      <nav className="sidebar-nav" aria-label="Primary">
        {NAV_ITEMS.map((item) => (
          <a
            key={item.route}
            className={'nav-item' + (item.route === pageKey ? ' is-active' : '')}
            href={'#/' + item.route}
            aria-current={item.route === pageKey ? 'page' : undefined}
          >
            {NAV_ICONS[item.route]}
            <span>{item.label}</span>
          </a>
        ))}
        <div className="nav-separator" role="separator" />
        {user.role === 'admin' ? (
          <a
            className={'nav-item' + (pageKey === 'configuration' ? ' is-active' : '')}
            href="#/configuration"
            aria-current={pageKey === 'configuration' ? 'page' : undefined}
          >
            {NAV_ICONS.configuration}
            <span>Configuration</span>
          </a>
        ) : (
          <span className="nav-item is-disabled" aria-disabled="true" title="Admin only">
            {NAV_ICONS.configuration}
            <span>Configuration</span>
            <LockIcon />
          </span>
        )}
      </nav>

      <div className="sidebar-user">
        <span className="avatar" aria-hidden="true">{initialsOf(user.name)}</span>
        <div className="user-details">
          <div className="user-name" title={user.name}>{user.name}</div>
          {user.role && <div className="user-role">{user.role}</div>}
        </div>
        <a
          className="link"
          href="#"
          onClick={(event) => {
            event.preventDefault();
            supabase.auth.signOut();
          }}
        >
          Sign out
        </a>
      </div>
    </aside>
  );
}
