import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Alert, Badge, Button, Card, Checkbox, ConfirmDialog, DataTable, EmptyState, Field, Input, Modal, PageHeader, Textarea, useToast, type Column } from '@/components/ui';
import type { RetentionPolicy } from './types';

import { t } from '@/lib/i18n';
interface Form {
  code: string;
  name: string;
  description: string;
  retentionDays: string;
  archiveAfterDays: string;
  longTermAfterDays: string;
  isDefault: boolean;
}
const empty: Form = { code: '', name: '', description: '', retentionDays: '', archiveAfterDays: '', longTermAfterDays: '', isDefault: false };
const num = (v: string) => (v.trim() === '' ? null : Number(v));
const days = (n: number | null) => (n == null ? '—' : `${n.toLocaleString('en-IN')} d`);

function PolicyModal({ policy, onClose }: { policy: RetentionPolicy | 'new'; onClose: () => void }) {
  const isNew = policy === 'new';
  const [f, setF] = useState<Form>(
    isNew ? empty : { code: policy.code, name: policy.name, description: policy.description ?? '', retentionDays: policy.retentionDays?.toString() ?? '', archiveAfterDays: policy.archiveAfterDays?.toString() ?? '', longTermAfterDays: policy.longTermAfterDays?.toString() ?? '', isDefault: policy.isDefault },
  );
  const qc = useQueryClient();
  const toast = useToast();
  const m = useMutation({
    mutationFn: () => {
      const body = { name: f.name.trim(), description: f.description.trim() || null, retentionDays: num(f.retentionDays), archiveAfterDays: num(f.archiveAfterDays), longTermAfterDays: num(f.longTermAfterDays) };
      return isNew ? api.post('/retention/policies', { ...body, code: f.code.trim(), isDefault: f.isDefault }) : api.patch(`/retention/policies/${policy.id}`, { ...body, ...(f.isDefault && !policy.isDefault ? { isDefault: true } : {}) });
    },
    onSuccess: () => {
      toast.success(isNew ? 'Policy created' : 'Policy updated (retain-until dates recomputed where needed)');
      void qc.invalidateQueries({ queryKey: ['retention'] });
      onClose();
    },
  });
  const valid = f.name.trim().length >= 3 && (!isNew || /^[a-z0-9_]{2,40}$/.test(f.code.trim()));
  return (
    <Modal
      open
      onClose={onClose}
      title={isNew ? 'New retention policy' : `Edit ${policy.name}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={m.isPending}>{t('Cancel')}</Button>
          <Button onClick={() => m.mutate()} disabled={!valid} loading={m.isPending}>{t('Save')}</Button>
        </>
      }
    >
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (valid) m.mutate(); }}>
        {isNew && (
          <Field label={t('Code')} htmlFor="rp-code" required hint={t('Lowercase letters, digits and underscore.')}>
            <Input id="rp-code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} maxLength={40} />
          </Field>
        )}
        <Field label={t('Name')} htmlFor="rp-name" required>
          <Input id="rp-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={120} />
        </Field>
        <Field label={t('Description')} htmlFor="rp-desc">
          <Textarea id="rp-desc" rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t('Retain (days)')} htmlFor="rp-ret" hint={t('Blank = indefinitely')}>
            <Input id="rp-ret" type="number" min={1} value={f.retentionDays} onChange={(e) => setF({ ...f, retentionDays: e.target.value })} />
          </Field>
          <Field label={t('Archive after (days)')} htmlFor="rp-arc" hint={t('Blank = never')}>
            <Input id="rp-arc" type="number" min={0} value={f.archiveAfterDays} onChange={(e) => setF({ ...f, archiveAfterDays: e.target.value })} />
          </Field>
          <Field label={t('Long-term after (days)')} htmlFor="rp-lt" hint={t('Blank = never')}>
            <Input id="rp-lt" type="number" min={0} value={f.longTermAfterDays} onChange={(e) => setF({ ...f, longTermAfterDays: e.target.value })} />
          </Field>
        </div>
        {(isNew || !policy.isDefault) && <Checkbox label={t('Default policy')} description={t('Applied to newly registered evidence without a policy. Exactly one policy is the default.')} checked={f.isDefault} onChange={(v) => setF({ ...f, isDefault: v })} />}
        <p className="text-xs text-ink-500">{t('Ages are measured from registration. Tier moves are copied and hash-verified before switching; disposal always needs a request and a second approver.')}</p>
        {m.error ? <Alert tone="red">{errorMessage(m.error)}</Alert> : null}
      </form>
    </Modal>
  );
}

export function RetentionPoliciesPage() {
  const { can } = useAuth();
  const manage = can('retention:manage');
  const q = useQuery({ queryKey: ['retention', 'policies'], queryFn: () => api.get<{ items: RetentionPolicy[] }>('/retention/policies') });
  const [edit, setEdit] = useState<RetentionPolicy | 'new' | null>(null);
  const [del, setDel] = useState<RetentionPolicy | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const delM = useMutation({
    mutationFn: (id: string) => api.delete(`/retention/policies/${id}`),
    onSuccess: () => {
      toast.success('Policy deleted');
      setDel(null);
      void qc.invalidateQueries({ queryKey: ['retention'] });
    },
  });
  const cols: Column<RetentionPolicy>[] = [
    { key: 'name', header: t('Policy'), render: (r) => (<div><p className="font-medium">{r.name} {r.isDefault && <Badge tone="blue">{t('Default')}</Badge>}</p><p className="mono text-xs text-ink-500">{r.code}</p>{r.description && <p className="text-xs text-ink-600">{r.description}</p>}</div>) },
    { key: 'ret', header: t('Retain'), render: (r) => (r.retentionDays == null ? 'Indefinitely' : days(r.retentionDays)) },
    { key: 'arc', header: t('Archive after'), render: (r) => days(r.archiveAfterDays) },
    { key: 'lt', header: t('Long-term after'), render: (r) => days(r.longTermAfterDays) },
    { key: 'n', header: t('Evidence'), render: (r) => r.evidenceCount.toLocaleString('en-IN') },
    ...(manage
      ? [{
          key: 'a',
          header: <span className="sr-only">{t('Actions')}</span>,
          render: (r: RetentionPolicy) => (
            <div className="flex justify-end gap-1.5">
              <Button size="sm" variant="secondary" onClick={() => setEdit(r)}>{t('Edit')}</Button>
              <Button size="sm" variant="ghost" disabled={r.isDefault || r.evidenceCount > 0} title={r.isDefault ? 'The default policy cannot be deleted' : r.evidenceCount > 0 ? 'Policy is in use' : undefined} onClick={() => { delM.reset(); setDel(r); }}>{t('Delete')}</Button>
            </div>
          ),
        } satisfies Column<RetentionPolicy>]
      : []),
  ];
  return (
    <div className="space-y-4">
      <PageHeader title={t('Retention policies')} subtitle={t('How long evidence is kept and when originals move to archive and long-term storage.')} actions={manage ? <Button icon={<Plus className="h-4 w-4" />} onClick={() => setEdit('new')}>{t('New policy')}</Button> : undefined} />
      <Card bodyClassName="p-0">
        <DataTable caption={t('Retention policies')} columns={cols} rows={q.data?.items} rowKey={(r) => r.id} loading={q.isFetching} error={q.error} onRetry={() => void q.refetch()} empty={<EmptyState title={t('No retention policies')} />} />
      </Card>
      {edit && <PolicyModal policy={edit} onClose={() => setEdit(null)} />}
      <ConfirmDialog open={!!del} title={t('Delete retention policy')} message={`Delete “${del?.name}”? This cannot be undone.`} confirmLabel={t('Delete')} variant="danger" loading={delM.isPending} error={delM.error} onConfirm={() => del && delM.mutate(del.id)} onCancel={() => setDel(null)} />
    </div>
  );
}
