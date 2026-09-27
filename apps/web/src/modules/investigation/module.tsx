import { FolderKanban } from 'lucide-react';
import type { WebModule } from '@/lib/modules';
import { lazyPage } from '@/lib/lazy';

const WorkspacesPage = lazyPage(() => import('./WorkspacesPage'), 'WorkspacesPage');
const WorkspacePage = lazyPage(() => import('./WorkspacePage'), 'WorkspacePage');

const mod: WebModule = {
  id: 'investigation',
  routes: [
    { path: 'workspaces', element: WorkspacesPage, anyOf: ['workspace:use'] },
    { path: 'workspaces/:id', element: WorkspacePage, anyOf: ['workspace:use'] },
  ],
  nav: [{ to: '/workspaces', label: 'Workspaces', icon: FolderKanban, section: 'Investigation', anyOf: ['workspace:use'], order: 10 }],
};
export default mod;
