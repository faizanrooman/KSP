import { Link } from 'react-router-dom';
import { ShieldAlert, SearchX } from 'lucide-react';
import { EmptyState } from '@/components/ui';

export function ForbiddenPage() {
  return <EmptyState icon={<ShieldAlert className="h-10 w-10" />} title="Access denied" description="You do not have permission to view this page. If you need access, contact your supervisor or system administrator." action={<Link className="text-brand-700 hover:underline" to="/">Go to home</Link>} />;
}
export function NotFoundPage() {
  return <EmptyState icon={<SearchX className="h-10 w-10" />} title="Page not found" description="The page you requested does not exist or you do not have access to it." action={<Link className="text-brand-700 hover:underline" to="/">Go to home</Link>} />;
}
