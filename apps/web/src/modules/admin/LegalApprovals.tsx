/**
 * Legal approvals (EXT-4 / EXT-5 / EXT-6): face detection / recognition and ANPR stay disabled, and the court export
 * Fact Sheet / BSA s.63 template stays stamped "TEMPLATE – PENDING LEGAL APPROVAL", until an administrator records
 * the approving authority, reference and date here. Every change is audited (LEGAL_APPROVAL_RECORDED / _REVOKED).
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AiLegalApprovals, AiTaskGate, LegalApproval, SystemSettings } from '@ksp/shared';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { Alert, Badge, Button, Card, ConfirmDialog, Field, Input, Modal, useToast } from '@/components/ui';

import { t } from '@/lib/i18n';
export interface DeploymentInfo {
  environment: string;
  aiTasksEnabled: string[];
  aiLegalGatesEnforced: boolean;
  aiTaskGates: AiTaskGate[];
  exportTemplateApproved: boolean;
  mediaProfile: string;
  signing: { keyId: string; provider: string; nonEvidentiary: boolean } | null;
}

type Entry = { settingKey: 'aiLegalApprovals'; entry: keyof AiLegalApprovals; title: string; description: string } | { settingKey: 'exportLegalApproval'; entry: 'approval'; title: string; description: string };
const ENTRIES: Entry[] = [
  { settingKey: 'aiLegalApprovals', entry: 'FACE_RECOGNITION', title: 'Face recognition (watchlists)', description: 'Biometric processing: DPIA and legal basis required (EXT-5). Covers the face detection it depends on.' },
  { settingKey: 'aiLegalApprovals', entry: 'FACE_DETECTION', title: 'Face detection (stand-alone)', description: 'Locating faces without identification (EXT-5).' },
  { settingKey: 'aiLegalApprovals', entry: 'ANPR', title: 'Number plate recognition (ANPR)', description: 'Plate detector licence review (YOLOv9 derivative, EXT-4).' },
  { settingKey: 'exportLegalApproval', entry: 'approval', title: 'Court export package & BSA s.63 template', description: 'Prosecution / legal acceptance of the Fact Sheet and certificate template (EXT-6).' },
];

const today = () => new Date().toISOString().slice(0, 10);

function current(settings: SystemSettings, e: Entry): LegalApproval | null {
  return e.settingKey === 'aiLegalApprovals' ? settings.aiLegalApprovals[e.entry] : settings.exportLegalApproval.approval;
}

function nextValue(settings: SystemSettings, e: Entry, value: LegalApproval | null): unknown {
  return e.settingKey === 'aiLegalApprovals' ? { ...settings.aiLegalApprovals, [e.entry]: value } : { approval: value };
}

export function LegalApprovalsCard({ settings, deployment, onSaved }: { settings: SystemSettings; deployment?: DeploymentInfo; onSaved: (r: unknown) => void }) {
  const [editing, setEditing] = useState<Entry | null>(null);
  const [withdraw, setWithdraw] = useState<Entry | null>(null);
  const [form, setForm] = useState({ approvedBy: '', reference: '', date: today(), notes: '' });
  const toast = useToast();
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: ({ e, value }: { e: Entry; value: LegalApproval | null }) => api.put(`/settings/${e.settingKey}`, nextValue(settings, e, value)),
    onSuccess: (r, { value }) => {
      onSaved(r);
      void qc.invalidateQueries({ queryKey: ['ai'] });
      toast.success(value ? 'Approval recorded' : 'Approval withdrawn');
      setEditing(null);
      setWithdraw(null);
    },
  });
  const gateOf = (e: Entry) => deployment?.aiTaskGates.find((g) => g.task === e.entry);
  const valid = form.approvedBy.trim().length >= 3 && form.reference.trim().length >= 3 && /^\d{4}-\d{2}-\d{2}$/.test(form.date);

  return (
    <Card title={<div><h2>{t('Legal approvals')}</h2><p className="text-xs font-normal text-ink-500">{t('Capabilities that stay disabled (or stamped) until the approving authority and reference are recorded. Recording or withdrawing an approval is audited.')}</p></div>}>
      {deployment?.signing?.nonEvidentiary && (
        <Alert tone="red" title={t('Non-evidentiary signing key')}>{t('Exports and custody reports are signed with a development / self-signed key (')}{deployment.signing.keyId}{t(') and are stamped “NON-EVIDENTIARY – TEST KEY”. Install the HSM / DSC key before go-live.')}</Alert>
      )}
      {deployment && !deployment.aiLegalGatesEnforced && (
        <Alert tone="amber" title={t('Legal approval checks are switched off on this deployment')}>
          {t('AI_LEGAL_GATES=off: face detection, face recognition and number plate recognition run without a recorded approval. Set AI_LEGAL_GATES=enforce (the default) so these tasks stay disabled until their approval is recorded here.')}
        </Alert>
      )}
      <ul className="divide-y divide-ink-100">
        {ENTRIES.map((e) => {
          const a = current(settings, e);
          const gate = gateOf(e);
          const enabledHere = e.settingKey === 'exportLegalApproval' || !deployment || deployment.aiTasksEnabled.includes(e.entry);
          const notEnforced = e.settingKey === 'aiLegalApprovals' && !!deployment && !deployment.aiLegalGatesEnforced && enabledHere;
          return (
            <li key={`${e.settingKey}.${e.entry}`} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between" data-testid={`legal-${e.entry}`}>
              <div className="min-w-0">
                <p className="font-medium text-ink-900">
                  {e.title}{' '}
                  {a ? <Badge tone="green">{t('Approved')}</Badge> : <Badge tone="amber">{t('Pending approval')}</Badge>}
                  {!enabledHere && <> <Badge>{t('Not enabled on this deployment')}</Badge></>}
                  {notEnforced && !a && <> <Badge tone="red">{t('Not enforced')}</Badge></>}
                </p>
                <p className="text-xs text-ink-500">{e.description}</p>
                {a ? (
                  <p className="mt-1 break-words text-sm text-ink-700">
                    {a.approvedBy}{' '}{t('· ref.')}{' '}<span className="font-mono">{a.reference}</span> · {a.date}
                    {a.recordedBy ? <span className="text-xs text-ink-500">{' '}{t('— recorded by')}{' '}{a.recordedBy}{a.recordedAt ? t(' on {recordedAt}', { recordedAt: formatDateTime(a.recordedAt) }) : ''}</span> : null}
                  </p>
                ) : (
                  <p className="mt-1 text-sm text-ink-600">{e.settingKey === 'exportLegalApproval' ? t('Fact Sheets are stamped “TEMPLATE – PENDING LEGAL APPROVAL”.') : notEnforced ? t('Not enforced on this deployment: runs without an approval.') : gate?.explanation ?? t('Disabled until approved.')}</p>
                )}
              </div>
              <div className="flex shrink-0 gap-2">
                <Button size="sm" variant="secondary" onClick={() => { save.reset(); setForm({ approvedBy: a?.approvedBy ?? '', reference: a?.reference ?? '', date: a?.date ?? today(), notes: a?.notes ?? '' }); setEditing(e); }}>{a ? t('Update') : t('Record approval')}</Button>
                {a && <Button size="sm" variant="ghost" onClick={() => { save.reset(); setWithdraw(e); }}>{t('Withdraw')}</Button>}
              </div>
            </li>
          );
        })}
      </ul>
      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing ? t('Record approval: {title}', { title: editing.title }) : t('Record approval')}
        footer={<>
          <Button variant="secondary" onClick={() => setEditing(null)}>{t('Cancel')}</Button>
          <Button disabled={!valid} loading={save.isPending} onClick={() => editing && save.mutate({ e: editing, value: { approvedBy: form.approvedBy.trim(), reference: form.reference.trim(), date: form.date, ...(form.notes.trim() ? { notes: form.notes.trim() } : {}) } })}>{t('Record approval')}</Button>
        </>}
      >
        <div className="space-y-3">
          <Alert tone="amber">{t('Record only an approval that exists in writing. The reference is printed on exports and kept in the audit trail.')}</Alert>
          <Field label={t('Approving authority (name, designation)')} htmlFor="la-by" required><Input id="la-by" value={form.approvedBy} onChange={(ev) => setForm({ ...form, approvedBy: ev.target.value })} /></Field>
          <Field label={t('Order / file / DPIA reference')} htmlFor="la-ref" required><Input id="la-ref" value={form.reference} onChange={(ev) => setForm({ ...form, reference: ev.target.value })} /></Field>
          <Field label={t('Date of approval')} htmlFor="la-date" required><Input id="la-date" type="date" max={today()} value={form.date} onChange={(ev) => setForm({ ...form, date: ev.target.value })} /></Field>
          <Field label={t('Notes (conditions, scope)')} htmlFor="la-notes"><Input id="la-notes" value={form.notes} onChange={(ev) => setForm({ ...form, notes: ev.target.value })} /></Field>
          {save.error ? <Alert tone="red" title={t('Not saved')}>{(save.error as Error).message}</Alert> : null}
        </div>
      </Modal>
      <ConfirmDialog
        open={!!withdraw}
        title={withdraw ? t('Withdraw approval: {title}', { title: withdraw.title }) : t('Withdraw approval')}
        message={withdraw?.settingKey === 'exportLegalApproval' ? t('New Fact Sheets will be stamped “TEMPLATE – PENDING LEGAL APPROVAL” again.') : t('New analysis requests for this task will be refused and queued jobs will fail. The change is audited.')}
        confirmLabel={t('Withdraw')}
        variant="danger"
        loading={save.isPending}
        error={save.error}
        onConfirm={() => withdraw && save.mutate({ e: withdraw, value: null })}
        onCancel={() => setWithdraw(null)}
      />
    </Card>
  );
}
