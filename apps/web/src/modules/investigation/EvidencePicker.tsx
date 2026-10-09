/** Modal evidence picker backed by the permission-aware search API (only visible evidence is offered). */
import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import { Button, Checkbox, EmptyState, ErrorState, Input, Modal, Spinner } from '@/components/ui';
import type { EvidenceListItem, Paged } from '@/modules/evidence/types';

import { t } from '@/lib/i18n';
export function EvidencePicker({ open, onClose, onPick, exclude, loading, title = 'Add evidence' }: {
  open: boolean; onClose: () => void; onPick: (ids: string[]) => void; exclude: Set<string>; loading?: boolean; title?: string;
}) {
  const { can } = useAuth();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string[]>([]);
  const res = useQuery({
    queryKey: ['investigation', 'picker', q],
    enabled: open,
    queryFn: () =>
      can('search:use')
        ? api.post<Paged<EvidenceListItem>>('/search/evidence', { ...(q ? { text: q } : {}), pageSize: 20, includeFacets: false })
        : api.get<Paged<EvidenceListItem>>('/evidence', { q: q || undefined, pageSize: 20 }),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setQ(text.trim());
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{t('Cancel')}</Button>
          <Button disabled={!sel.length} loading={loading} onClick={() => onPick(sel)}>{sel.length === 1 ? t('Add 1 item') : t('Add {n} items', { n: sel.length })}</Button>
        </>
      }
    >
      <form onSubmit={submit} className="mb-3 flex gap-2" role="search">
        <label htmlFor="picker-q" className="sr-only">{t('Search evidence')}</label>
        <Input id="picker-q" value={text} onChange={(e) => setText(e.target.value)} placeholder={t('Evidence number, title, words…')} autoFocus />
        <Button type="submit" icon={<Search className="h-4 w-4" />}>{t('Search')}</Button>
      </form>
      {res.isLoading ? <Spinner /> : res.error ? <ErrorState error={res.error} onRetry={() => void res.refetch()} /> : !res.data?.items.length ? (
        <EmptyState title={t('No evidence found')} description={t('Only evidence you are authorised to see is listed.')} />
      ) : (
        <ul className="max-h-96 divide-y divide-ink-100 overflow-y-auto">
          {res.data.items.map((e) => {
            const already = exclude.has(e.id);
            return (
              <li key={e.id} className="py-1.5">
                <Checkbox
                  label={`${e.evidenceNumber ?? e.id} — ${e.title ?? 'Untitled'}`}
                  description={already ? t('Already in this workspace') : t('{name} · recorded {recordedAt}', { name: e.orgUnit.name, recordedAt: formatDateTime(e.recordedAt) })}
                  checked={already || sel.includes(e.id)}
                  disabled={already}
                  onChange={(v) => setSel((s) => (v ? [...s, e.id] : s.filter((x) => x !== e.id)))}
                />
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}
