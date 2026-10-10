/** Evidence detail action: "Link to case" (shown when the API's canLinkCase flag allows it). */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderInput } from 'lucide-react';
import { api, errorMessage } from '@/lib/api';
import type { EvidenceAction, EvidenceSummary } from '@/lib/extensions';
import { titleCase } from '@/lib/format';
import { Alert, Button, Field, Input, Modal, Spinner, StatusBadge, useToast } from '@/components/ui';
import { ACTIVE_CASE_STATUSES, type CaseListItem, type Paged } from './types';

import { t as tr } from '@/lib/i18n';
function LinkToCaseButton({ evidence }: { evidence: EvidenceSummary }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [picked, setPicked] = useState<CaseListItem | null>(null);
  const [note, setNote] = useState('');
  const qc = useQueryClient();
  const toast = useToast();
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const cases = useQuery({
    queryKey: ['cases', 'pick', debounced],
    queryFn: () => api.get<Paged<CaseListItem>>('/cases', { q: debounced || undefined, status: ACTIVE_CASE_STATUSES.join(','), pageSize: 15, sort: '-updated_at' }),
    enabled: open,
  });
  const m = useMutation({
    mutationFn: () => api.post<{ results: Array<{ status: string }> }>(`/cases/${picked!.id}/evidence`, { evidenceIds: [evidence.id], note: note.trim() || undefined }),
    onSuccess: (r) => {
      const st = r.results[0]?.status;
      if (st === 'LINKED') toast.success(`Linked to ${picked!.caseNumber}`);
      else toast.info(`Not linked: ${titleCase(st ?? 'unknown')}`);
      void qc.invalidateQueries({ queryKey: ['evidence'] });
      void qc.invalidateQueries({ queryKey: ['cases'] });
      setOpen(false);
    },
  });
  return (
    <>
      <Button variant="secondary" size="sm" icon={<FolderInput className="h-4 w-4" />} onClick={() => { setPicked(null); setNote(''); m.reset(); setOpen(true); }}>{tr('Link to case')}</Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={tr('Link {value} to a case', { value: evidence.evidenceNumber ?? tr('evidence') })}
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>{tr('Cancel')}</Button><Button disabled={!picked} loading={m.isPending} onClick={() => m.mutate()}>{tr('Link')}</Button></>}
      >
        <div className="space-y-3">
          <Field label={tr('Find case')} htmlFor="ltc-q"><Input id="ltc-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('Case number, title or FIR number')} autoFocus /></Field>
          {cases.isLoading ? <Spinner /> : cases.error ? <Alert tone="red">{errorMessage(cases.error)}</Alert> : (
            <ul className="max-h-60 divide-y divide-ink-100 overflow-y-auto rounded-md border border-ink-200 text-sm" aria-label={tr('Cases')}>
              {cases.data?.items.length === 0 && <li className="px-3 py-2 text-ink-500">{tr('No open cases found')}</li>}
              {cases.data?.items.map((c) => (
                <li key={c.id}>
                  <button type="button" aria-pressed={picked?.id === c.id} className={`flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-brand-50 ${picked?.id === c.id ? 'bg-brand-50 ring-1 ring-brand-300' : ''}`} onClick={() => setPicked(c)}>
                    <span className="mono">{c.caseNumber}</span><span className="flex-1 truncate">{c.title}</span><StatusBadge status={c.status} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <Field label={tr('Note (optional)')} htmlFor="ltc-note"><Input id="ltc-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} /></Field>
          <p className="text-xs text-ink-600">{tr('The link is recorded in the evidence chain of custody.')}</p>
          {m.error ? <Alert tone="red">{errorMessage(m.error)}</Alert> : null}
        </div>
      </Modal>
    </>
  );
}

const actions: EvidenceAction[] = [{ id: 'link-to-case', order: 40, anyOf: ['cases:link_evidence'], component: LinkToCaseButton }];
export default actions;
