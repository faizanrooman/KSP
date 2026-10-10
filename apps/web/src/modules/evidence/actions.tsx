import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, LockOpen, ShieldCheck, Trash2 } from 'lucide-react';
import { api, errorMessage } from '@/lib/api';
import type { EvidenceSummary } from '@/lib/extensions';
import { titleCase } from '@/lib/format';
import { Alert, Button, ConfirmDialog, Field, Input, Modal, Select, Textarea, useToast } from '@/components/ui';
import { evidenceKey, type EvidenceDetail, type RetentionPolicy } from './types';

import { t as tr } from '@/lib/i18n';
function useRefreshEvidence(id: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: evidenceKey(id) });
    void qc.invalidateQueries({ queryKey: ['evidence', 'lifecycle', id] });
    void qc.invalidateQueries({ queryKey: ['evidence', 'integrity', id] });
    void qc.invalidateQueries({ queryKey: ['evidence', 'jobs', id] });
    void qc.invalidateQueries({ queryKey: ['evidence', 'list'] });
  };
}

export function VerifyButton({ evidence }: { evidence: EvidenceSummary }) {
  const toast = useToast();
  const refresh = useRefreshEvidence(evidence.id);
  const m = useMutation({
    mutationFn: () => api.post<{ queued: boolean; alreadyQueued: boolean }>(`/evidence/${evidence.id}/verify`),
    onSuccess: (r) => {
      toast.success(r.alreadyQueued ? 'A verification is already queued' : 'Integrity verification queued');
      refresh();
    },
    onError: (e) => toast.error(e),
  });
  return (
    <Button variant="secondary" size="sm" icon={<ShieldCheck className="h-4 w-4" />} loading={m.isPending} onClick={() => m.mutate()}>
      {tr('Verify integrity')}
    </Button>
  );
}

export function LegalHoldButton({ evidence }: { evidence: EvidenceSummary }) {
  const ev = evidence as EvidenceDetail;
  const [open, setOpen] = useState(false);
  const toast = useToast();
  const refresh = useRefreshEvidence(ev.id);
  const releasing = ev.legalHold;
  const m = useMutation({
    mutationFn: (reason: string) => (releasing ? api.delete<{ storageHold: string }>(`/evidence/${ev.id}/legal-hold`, { reason }) : api.post<{ storageHold: string }>(`/evidence/${ev.id}/legal-hold`, { reason })),
    onSuccess: (r) => {
      setOpen(false);
      toast.success(`${releasing ? 'Legal hold released' : 'Legal hold placed'} (storage lock: ${titleCase(r.storageHold)})`);
      refresh();
    },
  });
  if (ev.status === 'DISPOSED') return null;
  return (
    <>
      <Button variant={releasing ? 'secondary' : 'danger'} size="sm" icon={releasing ? <LockOpen className="h-4 w-4" /> : <Lock className="h-4 w-4" />} onClick={() => { m.reset(); setOpen(true); }}>
        {releasing ? tr('Release hold') : tr('Legal hold')}
      </Button>
      <ConfirmDialog
        open={open}
        title={releasing ? tr('Release legal hold') : tr('Place legal hold')}
        message={releasing ? tr('Releasing the hold allows this evidence to be disposed of once its retention period ends.') : tr('A legal hold blocks disposal of this evidence (database and object-storage lock) until it is released.')}
        confirmLabel={releasing ? tr('Release hold') : tr('Place hold')}
        variant={releasing ? 'primary' : 'danger'}
        requireReason
        reasonLabel={releasing ? tr('Reason for release (e.g. court order reference)') : tr('Reason / court order reference')}
        minReason={5}
        loading={m.isPending}
        error={m.error}
        onConfirm={(reason) => m.mutate(reason)}
        onCancel={() => setOpen(false)}
      />
    </>
  );
}

export function RequestDisposalButton({ evidence }: { evidence: EvidenceSummary }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [authorityRef, setAuthorityRef] = useState('');
  const [authorityType, setAuthorityType] = useState('');
  const [authorityDate, setAuthorityDate] = useState('');
  const toast = useToast();
  const refresh = useRefreshEvidence(evidence.id);
  const m = useMutation({
    mutationFn: () => api.post(`/evidence/${evidence.id}/disposal-requests`, {
      reason: reason.trim(), authorityRef: authorityRef.trim(),
      ...(authorityType ? { authorityType } : {}), ...(authorityDate ? { authorityDate } : {}),
    }),
    onSuccess: () => {
      setOpen(false);
      toast.success('Disposal requested — awaiting approval by a different authorised officer');
      refresh();
    },
  });
  const valid = reason.trim().length >= 10 && authorityRef.trim().length > 0;
  return (
    <>
      <Button variant="danger" size="sm" icon={<Trash2 className="h-4 w-4" />} onClick={() => { m.reset(); setReason(''); setAuthorityRef(''); setAuthorityType(''); setAuthorityDate(''); setOpen(true); }}>
        {tr('Request disposal')}
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={tr('Request authorised disposal')}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={m.isPending}>{tr('Cancel')}</Button>
            <Button variant="danger" disabled={!valid} loading={m.isPending} onClick={() => m.mutate()}>{tr('Submit request')}</Button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          <Alert tone="amber">{tr('Disposal permanently destroys the original and all derived media once approved by a second authorised officer. The record and its audit trail are kept.')}</Alert>
          <Field label={tr('Authority reference')} htmlFor="dr-auth" required hint={tr('Court order, government order or policy reference authorising disposal.')}>
            <Input id="dr-auth" value={authorityRef} onChange={(e) => setAuthorityRef(e.target.value)} maxLength={300} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={tr('Order type')} htmlFor="dr-type" hint={tr('Required when the retention period has not ended.')}>
              <Select id="dr-type" value={authorityType} onChange={(e) => setAuthorityType(e.target.value)}>
                <option value="">{tr('Retention period ended')}</option>
                <option value="COURT_ORDER">{tr('Court order')}</option>
                <option value="GOVERNMENT_ORDER">{tr('Government order')}</option>
              </Select>
            </Field>
            <Field label={tr('Order date')} htmlFor="dr-date">
              <Input id="dr-date" type="date" max={new Date().toISOString().slice(0, 10)} value={authorityDate} onChange={(e) => setAuthorityDate(e.target.value)} />
            </Field>
          </div>
          <Field label={tr('Reason')} htmlFor="dr-reason" required hint={tr('At least 10 characters; recorded in the chain of custody.')}>
            <Textarea id="dr-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={4000} />
          </Field>
          {m.error ? <Alert tone="red">{errorMessage(m.error)}</Alert> : null}
        </div>
      </Modal>
    </>
  );
}

export function TierChangeControl({ ev }: { ev: EvidenceDetail }) {
  const [target, setTarget] = useState('');
  const toast = useToast();
  const refresh = useRefreshEvidence(ev.id);
  const m = useMutation({
    mutationFn: () => api.post<{ alreadyQueued: boolean }>(`/evidence/${ev.id}/tier`, { targetTier: target }),
    onSuccess: (r) => {
      toast.success(r.alreadyQueued ? 'A tier move is already queued' : 'Tier move queued: the copy is verified by hash before switching');
      setTarget('');
      refresh();
    },
    onError: (e) => toast.error(e),
  });
  return (
    <div className="flex items-end gap-2">
      <Field label={tr('Move original to tier')} htmlFor="tier-target">
        <Select id="tier-target" value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">{tr('Select tier…')}</option>
          {['ACTIVE', 'ARCHIVE', 'LONG_TERM'].filter((t) => t !== ev.storageTier).map((t) => (
            <option key={t} value={t}>{titleCase(t)}</option>
          ))}
        </Select>
      </Field>
      <Button variant="secondary" disabled={!target} loading={m.isPending} onClick={() => m.mutate()}>
        {tr('Move')}
      </Button>
    </div>
  );
}

export function RetentionAssignControl({ ev, currentId }: { ev: EvidenceDetail; currentId: string | null }) {
  const [policyId, setPolicyId] = useState('');
  const toast = useToast();
  const refresh = useRefreshEvidence(ev.id);
  const policies = useQuery({ queryKey: ['retention', 'policies'], queryFn: () => api.get<{ items: RetentionPolicy[] }>('/retention/policies') });
  const m = useMutation({
    mutationFn: () => api.post(`/evidence/${ev.id}/retention`, { policyId }),
    onSuccess: () => {
      toast.success('Retention policy assigned');
      setPolicyId('');
      refresh();
    },
    onError: (e) => toast.error(e),
  });
  return (
    <div className="flex items-end gap-2">
      <Field label={tr('Assign retention policy')} htmlFor="ret-policy">
        <Select id="ret-policy" value={policyId} onChange={(e) => setPolicyId(e.target.value)} disabled={policies.isLoading}>
          <option value="">{policies.isLoading ? tr('Loading…') : tr('Select policy…')}</option>
          {policies.data?.items.filter((p) => p.id !== currentId).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}{p.isDefault ? tr(' (default)') : ''}
            </option>
          ))}
        </Select>
      </Field>
      <Button variant="secondary" disabled={!policyId} loading={m.isPending} onClick={() => m.mutate()}>
        {tr('Assign')}
      </Button>
    </div>
  );
}
