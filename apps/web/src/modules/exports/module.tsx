import { FileCheck2, Gavel } from 'lucide-react';
import type { WebModule } from '@/lib/modules';
import { ExportsPage } from './ExportsPage';
import { CreateExportPage } from './CreateExportPage';
import { ExportDetailPage } from './ExportDetailPage';
import { VerifyPackagePage } from './VerifyPackagePage';

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
