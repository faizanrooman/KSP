import { LayoutDashboard } from 'lucide-react';
import type { WebModule } from '@/lib/modules';
import { lazyPage } from '@/lib/lazy';

const DashboardPage = lazyPage(() => import('./DashboardPage'), 'DashboardPage');

const mod: WebModule = {
  id: 'dashboard',
  routes: [{ path: '', element: DashboardPage, anyOf: ['dashboard:view'] }],
  nav: [{ to: '/', label: 'Dashboard', icon: LayoutDashboard, section: 'Overview', anyOf: ['dashboard:view'], order: 0 }],
};
export default mod;
