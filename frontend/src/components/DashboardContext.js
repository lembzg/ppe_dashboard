import { createContext, useContext } from 'react';

// Holds { data, derivations, selectedIncidentId, openDrawer } for the signed-in dashboard.
export const DashboardContext = createContext(null);

export function useDashboard() {
  return useContext(DashboardContext);
}
