import type { WebModule } from '@/lib/modules';
import { PlayerPage } from './PlayerPage';

const mod: WebModule = {
  id: 'video',
  routes: [{ path: 'evidence/:id/player', element: PlayerPage, anyOf: ['evidence:play'] }],
};
export default mod;
