import { Link } from 'react-router';
import { ShieldAlert, SearchX } from 'lucide-react';
import { EmptyState } from '@/components/ui';

import { t } from '@/lib/i18n';
export function ForbiddenPage() {
  return <EmptyState heading="h1" icon={<ShieldAlert className="h-10 w-10" />} title={t('Access denied')} description={t('You do not have permission to view this page. If you need access, contact your supervisor or system administrator.')} action={<Link className="text-brand-700 hover:underline" to="/">{t('Go to home')}</Link>} />;
}
export function NotFoundPage() {
  return <EmptyState heading="h1" icon={<SearchX className="h-10 w-10" />} title={t('Page not found')} description={t('The page you requested does not exist or you do not have access to it.')} action={<Link className="text-brand-700 hover:underline" to="/">{t('Go to home')}</Link>} />;
}
