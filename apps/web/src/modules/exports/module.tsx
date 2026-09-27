import { FileCheck2, Gavel } from 'lucide-react';
import type { WebModule } from '@/lib/modules';
import { lazyPage } from '@/lib/lazy';

const ExportsPage = lazyPage(() => import('./ExportsPage'), 'ExportsPage');
const CreateExportPage = lazyPage(() => import('./CreateExportPage'), 'CreateExportPage');
const ExportDetailPage = lazyPage(() => import('./ExportDetailPage'), 'ExportDetailPage');
const VerifyPackagePage = lazyPage(() => import('./VerifyPackagePage'), 'VerifyPackagePage');

const ANY = ['export:create', 'export:approve', 'export:download'] as const;

const mod: WebModule = {
  id: 'exports',
  routes: [
    { path: 'exports', element: ExportsPage, anyOf: [...ANY] },
    { path: 'exports/new', element: CreateExportPage, anyOf: ['export:create'] },
    { path: 'exports/verify', element: VerifyPackagePage, anyOf: [...ANY, 'audit:verify'] },
    { path: 'exports/:id', element: ExportDetailPage, anyOf: [...ANY] },
  ],
  nav: [
    { to: '/exports', label: 'Court exports', icon: Gavel, section: 'Sharing & Export', anyOf: [...ANY], order: 10 },
    { to: '/exports/verify', label: 'Verify package', icon: FileCheck2, section: 'Sharing & Export', anyOf: [...ANY, 'audit:verify'], order: 30 },
  ],
};
export default mod;
