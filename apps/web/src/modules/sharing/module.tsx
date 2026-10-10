import { Share2 } from 'lucide-react';
import type { WebModule } from '@/lib/modules';
import { lazyPage } from '@/lib/lazy';

const SharesPage = lazyPage(() => import('./SharesPage'), 'SharesPage');
const ShareDetailPage = lazyPage(() => import('./ShareDetailPage'), 'ShareDetailPage');
const SharePortalPage = lazyPage(() => import('./SharePortalPage'), 'SharePortalPage');

const mod: WebModule = {
  id: 'sharing',
  routes: [
    // Recipients of internal shares may not hold share:create; the API scopes what each user sees.
    { path: 'shares', element: SharesPage },
    { path: 'shares/:id', element: ShareDetailPage },
  ],
  nav: [
    { to: '/shares', label: 'Shares', icon: Share2, section: 'Sharing & Export', anyOf: ['share:create', 'share:manage_all'], order: 20 },
    // Officers who cannot share still receive internal shares: they get a receive-only entry, not "Shares".
    { to: '/shares?view=received', label: 'Shared with me', icon: Share2, section: 'Sharing & Export', anyOf: ['evidence:read', 'evidence:read_own', 'cases:read'], noneOf: ['share:create', 'share:manage_all'], order: 20 },
  ],
  // External recipients: no account, no app shell.
  publicRoutes: [{ path: '/s/:token', element: SharePortalPage }],
};
export default mod;
