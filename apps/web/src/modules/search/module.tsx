import { Search } from 'lucide-react';
import type { WebModule } from '@/lib/modules';
import { SearchPage } from './SearchPage';

const mod: WebModule = {
  id: 'search',
  routes: [{ path: 'search', element: SearchPage, anyOf: ['search:use'] }],
  nav: [{ to: '/search', label: 'Search', icon: Search, section: 'Evidence', anyOf: ['search:use'], order: 20 }],
};
export default mod;
