import { FileBarChart } from 'lucide-react';
import type { WebModule } from '@/lib/modules';
import { lazyPage } from '@/lib/lazy';

const ReportsPage = lazyPage(() => import('./ReportsPage'), 'ReportsPage');

const mod: WebModule = {
  id: 'reports',
  routes: [{ path: 'reports', element: ReportsPage, anyOf: ['reports:generate'] }],
  nav: [{ to: '/reports', label: 'Reports', icon: FileBarChart, section: 'Compliance', anyOf: ['reports:generate'], order: 50 }],
};
export default mod;
