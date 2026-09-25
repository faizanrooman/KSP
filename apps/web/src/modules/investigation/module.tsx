import { FolderKanban } from 'lucide-react';
import type { WebModule } from '@/lib/modules';
import { WorkspacesPage } from './WorkspacesPage';
import { WorkspacePage } from './WorkspacePage';

const mod: WebModule = {
  id: 'investigation',
  routes: [
    { path: 'workspaces', element: WorkspacesPage, anyOf: ['workspace:use'] },
    { path: 'workspaces/:id', element: WorkspacePage, anyOf: ['workspace:use'] },
  ],
  nav: [{ to: '/workspaces', label: 'Workspaces', icon: FolderKanban, section: 'Investigation', anyOf: ['workspace:use'], order: 10 }],
};
export default mod;
