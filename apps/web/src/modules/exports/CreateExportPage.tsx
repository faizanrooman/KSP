/**
 * Create-export wizard: 1. items (from an evidence item, a case, or search) 2. package options 3. purpose,
 * court and recipient -> review and submit (PENDING_APPROVAL).
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Search, Trash2 } from 'lucide-react';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDuration } from '@/lib/format';
import { Alert, Button, Card, Checkbox, EmptyState, Field, Input, KeyValue, PageHeader, Spinner, StatusBadge, Textarea, useToast } from '@/components/ui';
import type { ExportDetail, Paged } from './types';

import { t as tr } from '@/lib/i18n';
export interface PickedItem {
  id: string;
  evidenceNumber: string | null;
  title: string | null;
  durationMs?: number | null;
}

interface EvidenceListItem { id: string; evidenceNumber: string | null; title: string | null; status: string; durationMs: number | null }
interface CaseEvidenceItem { unlinkedAt: string | null; evidence: { id: string; evidenceNumber: string | null; title: string | null; status: string; durationMs: number | null } }

const STEPS = ['Items', 'Package options', 'Purpose & court'] as const;

export function CreateExportPage() {
  const { can } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const caseId = params.get('caseId') ?? undefined;
  const initial = useMemo<PickedItem[]>(() => {
    const fromState = (location.state as { items?: PickedItem[] } | null)?.items;
    if (fromState?.length) return fromState;
    return (params.get('evidence') ?? '').split(',').filter((x) => /^[0-9a-f-]{36}$/i.test(x)).map((id) => ({ id, evidenceNumber: null, title: null }));
  }, [location.state, params]);
  const [items, setItems] = useState<PickedItem[]>(initial);
  const [step, setStep] = useState(0);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [opts, setOpts] = useState({ includeOriginal: can('evidence:download_original'), includeWatermarked: !can('evidence:download_original'), includeCustodyReport: true, includeFactSheet: true, watermarkText: '' });
  const [meta, setMeta] = useState({ purpose: '', courtName: '', courtCaseNumber: '', recipient: '' });
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const caseItems = useQuery({
    queryKey: ['cases', caseId, 'evidence', 'export'],
    queryFn: () => api.get<Paged<CaseEvidenceItem>>(`/cases/${caseId}/evidence`, { pageSize: 200 }),
    enabled: !!caseId,
  });
  const found = useQuery({
    queryKey: ['evidence', 'export-search', debounced],
    queryFn: () => api.get<Paged<EvidenceListItem>>('/evidence', { q: debounced, status: 'REGISTERED', pageSize: 10 }),
    enabled: debounced.length >= 2,
  });
  const add = (e: PickedItem) => setItems((xs) => (xs.some((x) => x.id === e.id) ? xs : [...xs, e]));
  const remove = (id: string) => setItems((xs) => xs.filter((x) => x.id !== id));

  const submit = useMutation({
    mutationFn: () => api.post<ExportDetail>('/exports', {
      evidenceIds: items.map((i) => i.id), caseId, purpose: meta.purpose, courtName: meta.courtName || undefined, courtCaseNumber: meta.courtCaseNumber || undefined, recipient: meta.recipient || undefined,
      options: { ...opts, watermarkText: opts.watermarkText || undefined },
    }),
    onSuccess: (r) => {
      toast.success(`${r.exportNumber} submitted for approval`);
      navigate(`/exports/${r.id}`);
    },
  });

  const canNext = step === 0 ? items.length > 0 : step === 1 ? opts.includeOriginal || opts.includeWatermarked : meta.purpose.trim().length >= 5;
  return (
    <div className="space-y-4">
      <PageHeader title={tr('New court export')} subtitle={tr('The request is reviewed by an approving officer (not you) before the package is built.')} breadcrumb={<Link to="/exports" className="text-brand-700 hover:underline">{tr('Court exports')}</Link>} />
      <ol className="flex flex-wrap gap-2 text-sm" aria-label={tr('Steps')}>
        {STEPS.map((s, i) => (
          <li key={s} aria-current={i === step ? 'step' : undefined} className={`rounded-full px-3 py-1 ${i === step ? 'bg-brand-700 text-white' : i < step ? 'bg-brand-50 text-brand-800' : 'bg-ink-100 text-ink-600'}`}>{i + 1}. {s}</li>
        ))}
      </ol>

      {step === 0 && (
        <Card title={`Items (${items.length})`}>
          <div className="space-y-4">
            {items.length === 0 ? <EmptyState title={tr('No items selected')} description={tr('Add evidence from the case list or search below.')} /> : (
              <ul className="divide-y divide-ink-100 rounded-md border border-ink-200">
                {items.map((i) => (
                  <li key={i.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                    <span><span className="mono">{i.evidenceNumber ?? i.id}</span> {i.title && <span className="text-ink-600">— {i.title}</span>}</span>
                    <Button size="sm" variant="ghost" icon={<Trash2 className="h-4 w-4" />} aria-label={`Remove ${i.evidenceNumber ?? i.id}`} onClick={() => remove(i.id)}>{tr('Remove')}</Button>
                  </li>
                ))}
              </ul>
            )}
            {caseId && (
              <div>
                <h3 className="mb-2 text-sm font-semibold text-ink-800">{tr('Evidence linked to the case')}</h3>
                {caseItems.isLoading ? <Spinner /> : caseItems.error ? <Alert tone="red">{errorMessage(caseItems.error)}</Alert> : (
                  <div className="space-y-1">
                    {caseItems.data?.items.filter((c) => !c.unlinkedAt).map((c) => (
                      <Checkbox key={c.evidence.id} label={`${c.evidence.evidenceNumber ?? c.evidence.id}${c.evidence.title ? ` — ${c.evidence.title}` : ''}`} description={`${c.evidence.status} · ${formatDuration(c.evidence.durationMs)}`}
                        checked={items.some((x) => x.id === c.evidence.id)} disabled={c.evidence.status !== 'REGISTERED'}
                        onChange={(v) => (v ? add({ id: c.evidence.id, evidenceNumber: c.evidence.evidenceNumber, title: c.evidence.title, durationMs: c.evidence.durationMs }) : remove(c.evidence.id))} />
                    ))}
                  </div>
                )}
              </div>
            )}
            <Field label={tr('Add evidence by number or title')} htmlFor="ce-search">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-ink-400" aria-hidden />
                <Input id="ce-search" className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={tr('e.g. KSP-CUBBONPARK-2026')} />
              </div>
            </Field>
            {found.data && (
              <ul className="divide-y divide-ink-100 rounded-md border border-ink-200 text-sm">
                {found.data.items.length === 0 && <li className="px-3 py-2 text-ink-500">{tr('No registered evidence found')}</li>}
                {found.data.items.map((e) => (
                  <li key={e.id} className="flex items-center justify-between px-3 py-2">
                    <span><span className="mono">{e.evidenceNumber}</span> <span className="text-ink-600">{e.title}</span> <StatusBadge status={e.status} /></span>
                    <Button size="sm" variant="secondary" disabled={items.some((x) => x.id === e.id)} onClick={() => add({ id: e.id, evidenceNumber: e.evidenceNumber, title: e.title, durationMs: e.durationMs })}>{tr('Add')}</Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      )}

      {step === 1 && (
        <Card title={tr('Package contents')}>
          <div className="space-y-3">
            <Checkbox label={tr('Original files (byte-identical)')} description={can('evidence:download_original') ? 'Re-verified against the registered SHA-256/512 before packaging.' : 'Requires permission to download originals — ask a supervisor or request watermarked copies only.'} checked={opts.includeOriginal} disabled={!can('evidence:download_original')} onChange={(v) => setOpts({ ...opts, includeOriginal: v })} />
            <Checkbox label={tr('Watermarked viewing copies')} description={tr('MP4 with burned-in export number, recipient, date, "COPY - NOT ORIGINAL" and timecode.')} checked={opts.includeWatermarked} onChange={(v) => setOpts({ ...opts, includeWatermarked: v })} />
            {opts.includeWatermarked && <Field label={tr('Extra watermark text (optional)')} htmlFor="ce-wm"><Input id="ce-wm" maxLength={120} value={opts.watermarkText} onChange={(e) => setOpts({ ...opts, watermarkText: e.target.value })} /></Field>}
            <Checkbox label={tr('Signed chain-of-custody report per item')} checked={opts.includeCustodyReport} onChange={(v) => setOpts({ ...opts, includeCustodyReport: v })} />
            <Checkbox label={tr('Fact Sheet (with Section 63 BSA certificate template)')} checked={opts.includeFactSheet} onChange={(v) => setOpts({ ...opts, includeFactSheet: v })} />
            {!opts.includeOriginal && !opts.includeWatermarked && <Alert tone="amber">{tr('Include the originals and/or the watermarked copies.')}</Alert>}
            <p className="text-xs text-ink-600">{tr('Every package also contains metadata files, manifest.json with the SHA-256 of every file, a detached signature, the signing certificate and VERIFY.txt with offline verification commands.')}</p>
          </div>
        </Card>
      )}

      {step === 2 && (
        <Card title={tr('Purpose and destination')}>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="md:col-span-2"><Field label={tr('Purpose')} required htmlFor="ce-purpose" hint={tr('At least 5 characters; recorded in the chain of custody.')}><Textarea id="ce-purpose" rows={3} value={meta.purpose} onChange={(e) => setMeta({ ...meta, purpose: e.target.value })} /></Field></div>
            <Field label={tr('Court')} htmlFor="ce-court"><Input id="ce-court" value={meta.courtName} onChange={(e) => setMeta({ ...meta, courtName: e.target.value })} /></Field>
            <Field label={tr('Court case number')} htmlFor="ce-ccn"><Input id="ce-ccn" value={meta.courtCaseNumber} onChange={(e) => setMeta({ ...meta, courtCaseNumber: e.target.value })} /></Field>
            <div className="md:col-span-2"><Field label={tr('Recipient')} htmlFor="ce-rec" hint={tr('e.g. Public Prosecutor, the court\'s evidence clerk')}><Input id="ce-rec" value={meta.recipient} onChange={(e) => setMeta({ ...meta, recipient: e.target.value })} /></Field></div>
          </div>
          <div className="mt-4 rounded-md bg-ink-50 p-3">
            <KeyValue items={[
              { label: tr('Items'), value: items.map((i) => i.evidenceNumber ?? i.id).join(', ') },
              { label: tr('Contents'), value: [opts.includeOriginal && 'originals', opts.includeWatermarked && 'watermarked copies', opts.includeCustodyReport && 'custody reports', opts.includeFactSheet && 'fact sheet'].filter(Boolean).join(', ') },
            ]} />
          </div>
          {submit.error ? <div className="mt-3"><Alert tone="red">{errorMessage(submit.error)}</Alert></div> : null}
        </Card>
      )}

      <div className="flex justify-between">
        <Button variant="secondary" disabled={step === 0} onClick={() => setStep(step - 1)}>{tr('Back')}</Button>
        {step < STEPS.length - 1 ? (
          <Button disabled={!canNext} onClick={() => setStep(step + 1)}>{tr('Next')}</Button>
        ) : (
          <Button disabled={!canNext} loading={submit.isPending} onClick={() => submit.mutate()}>{tr('Submit for approval')}</Button>
        )}
      </div>
    </div>
  );
}
