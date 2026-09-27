import { History, ShieldAlert, UploadCloud } from 'lucide-react';
import type { WebModule } from '@/lib/modules';
import { lazyPage } from '@/lib/lazy';

const UploadPage = lazyPage(() => import('./UploadPage'), 'UploadPage');
const UploadHistoryPage = lazyPage(() => import('./UploadHistoryPage'), 'UploadHistoryPage');
const QuarantinePage = lazyPage(() => import('./QuarantinePage'), 'QuarantinePage');

const mod: WebModule = {
  id: 'upload',
  routes: [
    { path: 'upload', element: UploadPage, anyOf: ['evidence:upload'] },
    { path: 'uploads', element: UploadHistoryPage, anyOf: ['evidence:upload'] },
    { path: 'uploads/quarantine', element: QuarantinePage, anyOf: ['evidence:quarantine_manage'] },
  ],
  nav: [
    { to: '/upload', label: 'Upload evidence', icon: UploadCloud, section: 'Evidence', anyOf: ['evidence:upload'], order: 20 },
    { to: '/uploads', label: 'Upload history', icon: History, section: 'Evidence', anyOf: ['evidence:upload'], order: 21 },
    { to: '/uploads/quarantine', label: 'Quarantine', icon: ShieldAlert, section: 'Evidence', anyOf: ['evidence:quarantine_manage'], order: 22 },
  ],
};
export default mod;
