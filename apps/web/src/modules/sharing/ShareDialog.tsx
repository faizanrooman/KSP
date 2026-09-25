/** Create-share dialog: internal user (UserPicker) or external recipient; permissions; expiry. Secrets shown once. */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { UserPicker, type UserOption } from '@/components/pickers';
import { Alert, Button, Checkbox, CopyButton, Field, Input, Modal, Select, Textarea, useToast } from '@/components/ui';
import type { CreatedShare } from './types';

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
  const m = useMutation({
    mutationFn: () => api.post<CreatedShare>('/shares', {
      evidenceIds: items.map((i) => i.id), caseId, recipientType: type, recipientUserId: type === 'INTERNAL_USER' ? user?.id : undefined,
      recipientName: type === 'EXTERNAL' ? rec.name : undefined, recipientEmail: type === 'EXTERNAL' ? rec.email : undefined, recipientOrg: type === 'EXTERNAL' ? rec.org || undefined : undefined,
      purpose, ...perm, allowOriginal: perm.allowDownload && perm.allowOriginal, maxViews: maxViews ? Number(maxViews) : undefined, expiresAt: new Date(expires).toISOString(),
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
      <Modal open onClose={onClose} title="Share created" footer={<Button onClick={onClose}>Done</Button>}>
        <div className="space-y-3 text-sm">
          <Alert tone="amber" title="Shown only once">
            Send the link and the access code to {created.share.recipient.name} through <strong>different channels</strong> (for example the link by e-mail and the code by phone/SMS). Neither can be displayed again.
          </Alert>
          <Field label="Link" htmlFor="sd-link"><div className="flex gap-2"><Input id="sd-link" readOnly value={created.link} className="mono text-xs" /><CopyButton value={created.link!} /></div></Field>
          <Field label="Access code" htmlFor="sd-code"><div className="flex gap-2"><Input id="sd-code" readOnly value={created.accessCode} className="mono text-lg tracking-widest" /><CopyButton value={created.accessCode!} /></div></Field>
          <p className="text-xs text-ink-600">Expires {formatDateTime(created.share.expiresAt)}{created.share.maxViews ? ` or after ${created.share.maxViews} views` : ''}. Five wrong codes lock the share.</p>
        </div>
      </Modal>
    );
  }
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={`Share ${items.length === 1 ? (items[0]!.evidenceNumber ?? 'evidence') : `${items.length} items`}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={!valid} loading={m.isPending} onClick={() => m.mutate()}>Create share</Button></>}
    >
      <div className="space-y-3 text-sm">
        <Field label="Recipient type" htmlFor="sd-type">
          <Select id="sd-type" value={type} onChange={(e) => setType(e.target.value as 'INTERNAL_USER' | 'EXTERNAL')}>
            <option value="INTERNAL_USER">KSP user (internal)</option>
            <option value="EXTERNAL">External recipient (prosecutor, court, FSL…)</option>
          </Select>
        </Field>
        {type === 'INTERNAL_USER' ? (
          <Field label="User" htmlFor="sd-user"><UserPicker id="sd-user" value={user} onChange={setUser} /></Field>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <Field label="Name" required htmlFor="sd-name"><Input id="sd-name" value={rec.name} onChange={(e) => setRec({ ...rec, name: e.target.value })} /></Field>
            <Field label="E-mail" required htmlFor="sd-email"><Input id="sd-email" type="email" value={rec.email} onChange={(e) => setRec({ ...rec, email: e.target.value })} /></Field>
            <Field label="Organisation" htmlFor="sd-org"><Input id="sd-org" value={rec.org} onChange={(e) => setRec({ ...rec, org: e.target.value })} /></Field>
          </div>
        )}
        <Field label="Purpose" required htmlFor="sd-purpose" hint="Recorded in the chain of custody."><Textarea id="sd-purpose" rows={2} value={purpose} onChange={(e) => setPurpose(e.target.value)} /></Field>
        <fieldset className="space-y-2">
          <legend className="text-xs font-semibold uppercase text-ink-600">Permissions</legend>
          <Checkbox label="Allow download" description={canOriginal ? (type === 'EXTERNAL' ? 'External recipients receive the watermarked copy.' : 'The recipient may download the original.') : 'Requires that you may download the original.'} checked={perm.allowDownload} disabled={!canOriginal} onChange={(v) => setPerm({ ...perm, allowDownload: v, allowOriginal: v && perm.allowOriginal })} />
          {type === 'EXTERNAL' && perm.allowDownload && <Checkbox label="Also allow the ORIGINAL file" description="Only when the recipient must hold the unmodified original." checked={perm.allowOriginal} onChange={(v) => setPerm({ ...perm, allowOriginal: v })} />}
          {type === 'EXTERNAL' && <Checkbox label="Allow printing watermarked stills" checked={perm.allowPrint} onChange={(v) => setPerm({ ...perm, allowPrint: v })} />}
          {type === 'EXTERNAL' && <Checkbox label="Watermark playback with the recipient's identity" description={canOriginal ? 'Strongly recommended.' : 'Mandatory unless you may download the original.'} checked={perm.watermark} disabled={!canOriginal} onChange={(v) => setPerm({ ...perm, watermark: v })} />}
        </fieldset>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Expires" required htmlFor="sd-exp" hint="Limited by the system share policy (default 30 days)."><Input id="sd-exp" type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} /></Field>
          {type === 'EXTERNAL' && <Field label="Maximum views (optional)" htmlFor="sd-views"><Input id="sd-views" inputMode="numeric" value={maxViews} onChange={(e) => setMaxViews(e.target.value.replace(/\D/g, ''))} /></Field>}
        </div>
        {m.error ? <Alert tone="red">{errorMessage(m.error)}</Alert> : null}
      </div>
    </Modal>
  );
}
