import { useEffect, useMemo, useRef, useState } from 'react';
import { DashboardContext } from './components/DashboardContext.js';
import Drawer from './components/Drawer.jsx';
import Sidebar from './components/Sidebar.jsx';
import Topbar from './components/Topbar.jsx';
import { createDerivations } from './lib/model.js';
import ConfigurationPage from './pages/ConfigurationPage.jsx';
import IncidentsPage, { NO_FILTERS } from './pages/IncidentsPage.jsx';
import OverviewPage from './pages/OverviewPage.jsx';
import ReportsPage from './pages/ReportsPage.jsx';
import ShiftsPage from './pages/ShiftsPage.jsx';
import ZonesPage from './pages/ZonesPage.jsx';

const PAGES = {
  overview: { title: 'Overview', usesPeriod: true, Component: OverviewPage },
  incidents: { title: 'Incidents', usesPeriod: true, Component: IncidentsPage },
  shifts: { title: 'Shifts', usesPeriod: true, Component: ShiftsPage },
  zones: { title: 'Zones', usesPeriod: true, Component: ZonesPage },
  reports: { title: 'Reports', usesPeriod: false, Component: ReportsPage },
  configuration: { title: 'Configuration', usesPeriod: false, adminOnly: true, Component: ConfigurationPage },
};

function currentPageKey(isAdmin) {
  const key = window.location.hash.replace(/^#\/?/, '');
  return PAGES[key] && (isAdmin || !PAGES[key].adminOnly) ? key : 'overview';
}

function useHashRoute(isAdmin) {
  const [pageKey, setPageKey] = useState(() => currentPageKey(isAdmin));
  useEffect(() => {
    const onHashChange = () => setPageKey(currentPageKey(isAdmin));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [isAdmin]);
  return pageKey;
}

export default function Dashboard({ data, reloadData }) {
  const pageKey = useHashRoute(data.currentUser.role === 'admin');
  const page = PAGES[pageKey];
  const [period, setPeriod] = useState('today');
  const [openMenu, setOpenMenu] = useState(null);
  const [selectedIncidentId, setSelectedIncidentId] = useState(null);
  const [incidentFilters, setIncidentFilters] = useState(NO_FILTERS);
  const contentRef = useRef(null);
  const drawerReturnFocus = useRef(null);

  const derivations = useMemo(() => createDerivations(data), [data]);
  const model = useMemo(() => derivations.deriveModel(period), [derivations, period]);

  function openDrawer(incidentId) {
    drawerReturnFocus.current = incidentId;
    setSelectedIncidentId(incidentId);
  }

  function closeDrawer() {
    setSelectedIncidentId(null);
    const row = document.querySelector('[data-incident-id="' + drawerReturnFocus.current + '"]');
    if (row) row.focus();
  }

  useEffect(() => {
    document.title = 'Dashboard ' + page.title;
    setSelectedIncidentId(null);
    setOpenMenu(null);
    contentRef.current.scrollTop = 0;
  }, [page]);

  // Escape closes the open scope menu first, then the drawer.
  useEffect(() => {
    function onKeyDown(event) {
      if (event.key !== 'Escape') return;
      if (openMenu) {
        setOpenMenu(null);
        document.querySelector('[data-menu-trigger="' + openMenu + '"]').focus();
      } else if (selectedIncidentId) {
        closeDrawer();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  });

  useEffect(() => {
    if (!openMenu) return undefined;
    function onClick(event) {
      if (!event.target.closest('.scope-segment')) setOpenMenu(null);
    }
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [openMenu]);

  const context = { data, derivations, selectedIncidentId, openDrawer, reloadData };
  const { Component } = page;

  return (
    <DashboardContext.Provider value={context}>
      <div className="app">
        <Sidebar pageKey={pageKey} user={data.currentUser} />
        <div className="main">
          <Topbar
            data={data}
            live={model.live}
            period={period}
            setPeriod={setPeriod}
            showPeriod={page.usesPeriod}
            openMenu={openMenu}
            setOpenMenu={setOpenMenu}
          />
          <main className="content" ref={contentRef}>
            <Component model={model} filters={incidentFilters} setFilters={setIncidentFilters} />
          </main>
        </div>
      </div>
      <Drawer onClose={closeDrawer} />
    </DashboardContext.Provider>
  );
}
