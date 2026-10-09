/** Create-share dialog: internal user (UserPicker) or external recipient; permissions; expiry. Secrets shown once. */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { UserPicker, type UserOption } from '@/components/pickers';
import { Alert, Button, Checkbox, CopyButton, Field, Input, Modal, Select, Textarea, useToast } from '@/components/ui';
import type { CreatedShare } from './types';
import { deliveryText, useShareOptions } from './ShareManageActions';

import { t } from '@/lib/i18n';
export interface ShareTarget {
  id: string;
  evidenceNumber: string | null;
  canDownloadOriginal: boolean;
}

function defaultExpiry(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  d.setSeconds(0, 0);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function ShareDialog({ items, caseId, onClose }: { items: ShareTarget[]; caseId?: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const canOriginal = items.every((i) => i.canDownloadOriginal);
  const [type, setType] = useState<'INTERNAL_USER' | 'EXTERNAL'>('INTERNAL_USER');
  const [user, setUser] = useState<UserOption | null>(null);
  const [rec, setRec] = useState({ name: '', email: '', org: '' });
  const [purpose, setPurpose] = useState('');
  const [perm, setPerm] = useState({ allowDownload: false, allowOriginal: false, allowPrint: false, watermark: true });
  const [maxViews, setMaxViews] = useState('');
  const [expires, setExpires] = useState(defaultExpiry(7));
  const opts = useShareOptions();
  const [mail, setMail] = useState({ emailLink: true, emailAccessCode: false });
  const emailOk = type === 'EXTERNAL' && !!opts.data?.emailConfigured;
  const m = useMutation({
    mutationFn: () => api.post<CreatedShare>('/shares', {
      evidenceIds: items.map((i) => i.id), caseId, recipientType: type, recipientUserId: type === 'INTERNAL_USER' ? user?.id : undefined,
      recipientName: type === 'EXTERNAL' ? rec.name : undefined, recipientEmail: type === 'EXTERNAL' ? rec.email : undefined, recipientOrg: type === 'EXTERNAL' ? rec.org || undefined : undefined,
      purpose, ...perm, allowOriginal: perm.allowDownload && perm.allowOriginal, maxViews: maxViews ? Number(maxViews) : undefined, expiresAt: new Date(expires).toISOString(),
      ...(emailOk ? { emailLink: mail.emailLink, emailAccessCode: mail.emailLink && mail.emailAccessCode } : {}),
    }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['shares'] });
      if (!r.token) {
        toast.success(`Shared with ${r.share.recipient.name ?? 'the user'} until ${formatDateTime(r.share.expiresAt)}`);
        onClose();
      }
    },
  });
  const created = m.data?.token ? m.data : null;
  const valid = purpose.trim().length >= 5 && (type === 'INTERNAL_USER' ? !!user : rec.name.trim().length > 1 && /.+@.+\..+/.test(rec.email)) && new Date(expires).getTime() > Date.now();
  if (created) {
    return (
      <Modal open onClose={onClose} title={t('Share created')} footer={<Button onClick={onClose}>{t('Done')}</Button>}>
        <div className="space-y-3 text-sm">
          {deliveryText(created.delivery) && <Alert tone={created.delivery?.link === 'FAILED' || created.delivery?.accessCode === 'FAILED' ? 'red' : 'green'}>{deliveryText(created.delivery)}{' '}{t('to')}{' '}{created.share.recipient.email}.</Alert>}
          <Alert tone="amber" title={t('Shown only once')}>
            {created.delivery?.link === 'SENT' && created.delivery.accessCode !== 'SENT' ? t('Give the access code to the recipient by phone/SMS or in person — it was not e-mailed. ') : ''}{' '}{t('Send the link and the access code to')}{' '}{created.share.recipient.name}{' '}{t('through')}{' '}<strong>{t('different channels')}</strong>{t('(for example the link by e-mail and the code by phone/SMS). Neither can be displayed again.')}
          </Alert>
          <Field label={t('Link')} htmlFor="sd-link"><div className="flex gap-2"><Input id="sd-link" readOnly value={created.link} className="mono text-xs" /><CopyButton value={created.link!} /></div></Field>
          <Field label={t('Access code')} htmlFor="sd-code"><div className="flex gap-2"><Input id="sd-code" readOnly value={created.accessCode} className="mono text-lg tracking-widest" /><CopyButton value={created.accessCode!} /></div></Field>
          <p className="text-xs text-ink-600">{t('Expires')}{' '}{formatDateTime(created.share.expiresAt)}{created.share.maxViews ? t(' or after {maxViews} views', { maxViews: created.share.maxViews }) : ''}{t('. Five wrong codes lock the share.')}</p>
        </div>
      </Modal>
    );
  }
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={t('Share {value}', { value: items.length === 1 ? (items[0]!.evidenceNumber ?? t('evidence')) : t('{count} items', { count: items.length }) })}
      footer={<><Button variant="secondary" onClick={onClose}>{t('Cancel')}</Button><Button disabled={!valid} loading={m.isPending} onClick={() => m.mutate()}>{t('Create share')}</Button></>}
    >
      <div className="space-y-3 text-sm">
        <Field label={t('Recipient type')} htmlFor="sd-type">
          <Select id="sd-type" value={type} onChange={(e) => setType(e.target.value as 'INTERNAL_USER' | 'EXTERNAL')}>
            <option value="INTERNAL_USER">{t('KSP user (internal)')}</option>
            <option value="EXTERNAL">{t('External recipient (prosecutor, court, FSL…)')}</option>
          </Select>
        </Field>
        {type === 'INTERNAL_USER' ? (
          <Field label={t('User')} htmlFor="sd-user"><UserPicker id="sd-user" value={user} onChange={setUser} /></Field>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <Field label={t('Name')} required htmlFor="sd-name"><Input id="sd-name" value={rec.name} onChange={(e) => setRec({ ...rec, name: e.target.value })} /></Field>
            <Field label={t('E-mail')} required htmlFor="sd-email"><Input id="sd-email" type="email" value={rec.email} onChange={(e) => setRec({ ...rec, email: e.target.value })} /></Field>
            <Field label={t('Organisation')} htmlFor="sd-org"><Input id="sd-org" value={rec.org} onChange={(e) => setRec({ ...rec, org: e.target.value })} /></Field>
          </div>
        )}
        <Field label={t('Purpose')} required htmlFor="sd-purpose" hint={t('At least 5 characters; recorded in the chain of custody.')}><Textarea id="sd-purpose" rows={2} value={purpose} onChange={(e) => setPurpose(e.target.value)} /></Field>
        <fieldset className="space-y-2">
          <legend className="text-xs font-semibold uppercase text-ink-600">{t('Permissions')}</legend>
          <Checkbox label={t('Allow download')} description={canOriginal ? (type === 'EXTERNAL' ? t('External recipients receive the watermarked copy.') : t('The recipient may download the original.')) : t('Requires that you may download the original.')} checked={perm.allowDownload} disabled={!canOriginal} onChange={(v) => setPerm({ ...perm, allowDownload: v, allowOriginal: v && perm.allowOriginal })} />
          {type === 'EXTERNAL' && perm.allowDownload && <Checkbox label={t('Also allow the ORIGINAL file')} description={t('Only when the recipient must hold the unmodified original.')} checked={perm.allowOriginal} onChange={(v) => setPerm({ ...perm, allowOriginal: v })} />}
          {type === 'EXTERNAL' && <Checkbox label={t('Allow printing watermarked stills')} checked={perm.allowPrint} onChange={(v) => setPerm({ ...perm, allowPrint: v })} />}
          {type === 'EXTERNAL' && <Checkbox label={t('Watermark playback with the recipient\'s identity')} description={canOriginal ? t('Strongly recommended.') : t('Mandatory unless you may download the original.')} checked={perm.watermark} disabled={!canOriginal} onChange={(v) => setPerm({ ...perm, watermark: v })} />}
        </fieldset>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label={t('Expires')} required htmlFor="sd-exp" hint={t('Limited by the system share policy (default 30 days).')}><Input id="sd-exp" type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} /></Field>
          <Field label={t('Maximum views (optional)')} htmlFor="sd-views" hint={type === 'INTERNAL_USER' ? t('Counts openings of each item (one per 30-minute viewing session).') : undefined}><Input id="sd-views" inputMode="numeric" value={maxViews} onChange={(e) => setMaxViews(e.target.value.replace(/\D/g, ''))} /></Field>
        </div>
        {emailOk && (
          <fieldset className="space-y-2">
            <legend className="text-xs font-semibold uppercase text-ink-600">{t('Delivery')}</legend>
            <Checkbox label={t('E-mail the link to the recipient')} description={t('The access code is not included — give it by phone/SMS or in person.')} checked={mail.emailLink} onChange={(v) => setMail({ emailLink: v, emailAccessCode: v && mail.emailAccessCode })} />
            {mail.emailLink && <Checkbox label={t('Also e-mail the access code (separate message)')} description={t('Not recommended: anyone with access to that mailbox could then open the share.')} checked={mail.emailAccessCode} onChange={(v) => setMail({ ...mail, emailAccessCode: v })} />}
          </fieldset>
        )}
        {m.error ? <Alert tone="red">{errorMessage(m.error)}</Alert> : null}
      </div>
    </Modal>
  );
}
