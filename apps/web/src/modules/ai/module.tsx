import { Cpu, ListChecks, ScanFace } from 'lucide-react';
import type { WebModule } from '@/lib/modules';
import { lazyPage } from '@/lib/lazy';

const ReviewQueuePage = lazyPage(() => import('./ReviewQueuePage'), 'ReviewQueuePage');
const ModelsPage = lazyPage(() => import('./ModelsPage'), 'ModelsPage');
const WatchlistsPage = lazyPage(() => import('./WatchlistsPage'), 'WatchlistsPage');

const mod: WebModule = {
  id: 'ai',
  routes: [
    { path: 'review', element: ReviewQueuePage, anyOf: ['ai:review'] },
    { path: 'ai/models', element: ModelsPage, anyOf: ['ai:models_manage'] },
    { path: 'ai/watchlists', element: WatchlistsPage, anyOf: ['ai:watchlist_manage'] },
  ],
  nav: [
    { to: '/review', label: 'AI review queue', icon: ListChecks, section: 'Analysis', anyOf: ['ai:review'], order: 10 },
    { to: '/ai/watchlists', label: 'Watchlists', icon: ScanFace, section: 'Analysis', anyOf: ['ai:watchlist_manage'], order: 20 },
    { to: '/ai/models', label: 'AI models', icon: Cpu, section: 'Analysis', anyOf: ['ai:models_manage'], order: 30 },
  ],
};
export default mod;
