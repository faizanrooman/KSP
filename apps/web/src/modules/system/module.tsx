import { Activity } from 'lucide-react';
import type { WebModule } from '@/lib/modules';
import { lazyPage } from '@/lib/lazy';

const SystemHealthPage = lazyPage(() => import('./SystemHealthPage'), 'SystemHealthPage');

const mod: WebModule = {
  id: 'system',
  routes: [{ path: 'system/health', element: SystemHealthPage, anyOf: ['system:monitor'] }],
  nav: [{ to: '/system/health', label: 'System health', icon: Activity, section: 'Administration', anyOf: ['system:monitor'], order: 5 }],
};
export default mod;
