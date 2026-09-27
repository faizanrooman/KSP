import type { WebModule } from '@/lib/modules';
import { lazyPage } from '@/lib/lazy';

const PlayerPage = lazyPage(() => import('./PlayerPage'), 'PlayerPage');

const mod: WebModule = {
  id: 'video',
  routes: [{ path: 'evidence/:id/player', element: PlayerPage, anyOf: ['evidence:play'] }],
};
export default mod;
