import { Share2 } from 'lucide-react';
import type { WebModule } from '@/lib/modules';
import { SharesPage } from './SharesPage';
import { ShareDetailPage } from './ShareDetailPage';
import { SharePortalPage } from './SharePortalPage';

const mod: WebModule = {
  id: 'sharing',
  routes: [
    // Recipients of internal shares may not hold share:create; the API scopes what each user sees.
    { path: 'shares', element: SharesPage },
    { path: 'shares/:id', element: ShareDetailPage },
  ],
  nav: [{ to: '/shares', label: 'Shares', icon: Share2, section: 'Sharing & Export', anyOf: ['share:create', 'share:manage_all', 'evidence:read', 'cases:read'], order: 20 }],
  // External recipients: no account, no app shell.
  publicRoutes: [{ path: '/s/:token', element: SharePortalPage }],
};
export default mod;
