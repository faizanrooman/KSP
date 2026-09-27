import { Bell, BellRing, SlidersHorizontal } from 'lucide-react';
import type { WebModule } from '@/lib/modules';
import { lazyPage } from '@/lib/lazy';

const AlertDetailPage = lazyPage(() => import('./AlertsPages'), 'AlertDetailPage');
const AlertRulesPage = lazyPage(() => import('./AlertsPages'), 'AlertRulesPage');
const AlertsListPage = lazyPage(() => import('./AlertsPages'), 'AlertsListPage');
const NotificationsPage = lazyPage(() => import('./AlertsPages'), 'NotificationsPage');

const mod: WebModule = {
  id: 'alerts',
  routes: [
    { path: 'alerts', element: AlertsListPage, anyOf: ['alerts:read'] },
    { path: 'alerts/rules', element: AlertRulesPage, anyOf: ['alerts:manage'] },
    { path: 'alerts/:id', element: AlertDetailPage, anyOf: ['alerts:read'] },
    { path: 'notifications', element: NotificationsPage },
  ],
  nav: [
    { to: '/alerts', label: 'Alerts', icon: BellRing, section: 'Overview', anyOf: ['alerts:read'], order: 10 },
    { to: '/notifications', label: 'Notifications', icon: Bell, section: 'Overview', order: 20 },
    { to: '/alerts/rules', label: 'Alert rules', icon: SlidersHorizontal, section: 'Administration', anyOf: ['alerts:manage'], order: 85 },
  ],
};
export default mod;
