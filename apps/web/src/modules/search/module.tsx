import { ScanFace, Search } from 'lucide-react';
import type { WebModule } from '@/lib/modules';
import { lazyPage } from '@/lib/lazy';

const SearchPage = lazyPage(() => import('./SearchPage'), 'SearchPage');
const FaceSearchPage = lazyPage(() => import('./FaceSearchPage'), 'FaceSearchPage');

const mod: WebModule = {
  id: 'search',
  routes: [
    { path: 'search', element: SearchPage, anyOf: ['search:use'] },
    { path: 'search/face', element: FaceSearchPage, anyOf: ['ai:request'] },
  ],
  nav: [
    { to: '/search', label: 'Search', icon: Search, section: 'Evidence', anyOf: ['search:use'], order: 20 },
    { to: '/search/face', label: 'Face search', icon: ScanFace, section: 'Analysis', anyOf: ['ai:request'], order: 15 },
  ],
};
export default mod;
