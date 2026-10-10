/**
 * Header notification bell. Mount it in the app shell header (owned by the orchestrator):
 *
 *   import { NotificationBell } from '@/modules/alerts/NotificationBell';
 *   …<header>… <NotificationBell /> …</header>
 *
 * Polls GET /notifications?unread=true every 60 s, shows the unread count (text, not colour-only), and opens
 * a keyboard-accessible popover with the latest items, "mark all read" and a link to /notifications.
 */
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Bell } from 'lucide-react';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import type { NotificationPage } from './api';

import { t } from '@/lib/i18n';
export function NotificationBell() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const query = useQuery({
    queryKey: ['notifications', 'bell'],
    queryFn: () => api.get<NotificationPage>('/notifications', { unread: 'true', pageSize: 8 }),
    refetchInterval: 60_000,
  });
  const readAll = useMutation({ mutationFn: () => api.post('/notifications/read-all'), onSuccess: () => void qc.invalidateQueries({ queryKey: ['notifications'] }) });
  const readOne = useMutation({ mutationFn: (id: string) => api.post(`/notifications/${id}/read`), onSuccess: () => void qc.invalidateQueries({ queryKey: ['notifications'] }) });
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);
  const unread = query.data?.unread ?? 0;
  return (
    <div className="relative" ref={ref}>
      <button type="button" className="relative rounded-md p-2 text-ink-700 hover:bg-ink-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        aria-haspopup="true" aria-expanded={open} aria-label={t('Notifications: {unread} unread', { unread })} onClick={() => setOpen((o) => !o)}>
        <Bell className="h-5 w-5" aria-hidden />
        {unread > 0 && <span className="absolute -right-0.5 -top-0.5 min-w-[1.1rem] rounded-full bg-red-700 px-1 text-center text-[10px] font-semibold leading-4 text-white" aria-hidden>{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-md border border-ink-200 bg-white shadow-lg" role="dialog" aria-label={t('Unread notifications')}>
          <div className="flex items-center justify-between border-b border-ink-100 px-3 py-2">
            <span className="text-sm font-semibold text-ink-900">{unread}{' '}{t('unread')}</span>
            <button type="button" className="text-xs text-brand-700 hover:underline disabled:opacity-50" disabled={!unread || readAll.isPending} onClick={() => readAll.mutate()}>{t('Mark all read')}</button>
          </div>
          <ul className="max-h-80 divide-y divide-ink-100 overflow-auto">
            {query.error && <li className="px-3 py-2 text-sm text-red-800">{t('Could not load notifications.')}</li>}
            {query.data?.items.map((n) => (
              <li key={n.id} className="px-3 py-2">
                {n.link ? (
                  <Link to={n.link} className="block text-sm font-medium text-ink-900 hover:underline" onClick={() => { readOne.mutate(n.id); setOpen(false); }}>{n.title}</Link>
                ) : <p className="text-sm font-medium text-ink-900">{n.title}</p>}
                <p className="text-xs text-ink-500">{n.kind.replace('ALERT_', '').toLowerCase()} · {formatDateTime(n.createdAt)}</p>
              </li>
            ))}
            {query.data && !query.data.items.length && <li className="px-3 py-3 text-sm text-ink-600">{t('You are all caught up.')}</li>}
          </ul>
          <Link to="/notifications" className="block border-t border-ink-100 px-3 py-2 text-center text-sm text-brand-700 hover:underline" onClick={() => setOpen(false)}>{t('All notifications')}</Link>
        </div>
      )}
    </div>
  );
}
