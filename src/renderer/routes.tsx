/**
 * Route table.
 *
 * This file is FROZEN. Do not edit it.
 *
 * Every route points at a feature barrel. To build a feature, replace the body
 * of that barrel — `src/renderer/features/<feature>/index.tsx` — and keep its
 * exported component name. That way each feature has exactly one owner and no
 * two builders ever touch the same file.
 */

import { Navigate, useRoutes, type RouteObject } from 'react-router';

import { AppShell } from './AppShell';
import { AssistantPage } from './features/assistant';
import { ClientsPage } from './features/clients';
import { InvoicesPage } from './features/invoices';
import { ModelsPage } from './features/models';
import { ReportsPage } from './features/reports';
import { Placeholder } from './pages/Placeholder';
import { SettingsPage } from './pages/Settings';

const ROUTES: RouteObject[] = [
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/invoices" replace /> },
      { path: 'invoices/*', element: <InvoicesPage /> },
      { path: 'clients/*', element: <ClientsPage /> },
      { path: 'reports/*', element: <ReportsPage /> },
      { path: 'models/*', element: <ModelsPage /> },
      { path: 'assistant/*', element: <AssistantPage /> },
      { path: 'settings', element: <SettingsPage /> },
      {
        path: '*',
        element: <Placeholder name="Not found" description="That route does not exist." />,
      },
    ],
  },
];

export function AppRoutes(): React.ReactElement | null {
  return useRoutes(ROUTES);
}
