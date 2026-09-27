/** Share management actions on the detail page: unlock, extend, re-issue link (optionally by e-mail). */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { Alert, Button, Checkbox, ConfirmDialog, CopyButton, Field, Input, Modal, Textarea, useToast } from '@/components/ui';
import type { CreatedShare, ShareDetail } from './types';

export interface ShareOptions { emailConfigured: boolean; maxShareDays: number }
export const useShareOptions = () => useQuery({ queryKey: ['shares', 'options'], queryFn: () => api.get<ShareOptions>('/shares/options'), staleTime: 60_000 });

const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

export function deliveryText(d: CreatedShare['delivery']): string | null {
  if (!d) return null;
  const part = (what: string, s: string) => (s === 'SENT' ? `${what} e-mailed` : s === 'FAILED' ? `${what} could NOT be e-mailed` : null);
  return [part('Link', d.link), part('Access code', d.accessCode)].filter(Boolean).join(' · ') || null;
}

export function ShareManageActions({ share }: { share: ShareDetail }) {
  const qc = useQueryClient();
  const toast = useToast();
  const opts = useShareOptions();
  const [dialog, setDialog] = useState<null | 'unlock' | 'extend' | 'reissue'>(null);
  const done = (msg: string) => { toast.success(msg); void qc.invalidateQueries({ queryKey: ['shares'] }); };
  const unlock = useMutation({ mutationFn: (reason: string) => api.post(`/shares/${share.id}/unlock`, { reason }), onSuccess: () => { setDialog(null); done('Share unlocked — the recipient can use the access code again'); } });
  const max = new Date(Date.now() + (opts.data?.maxShareDays ?? 30) * 86_400_000);
  const [until, setUntil] = useState(localInput(new Date(Math.min(max.getTime(), Math.max(Date.now(), new Date(share.expiresAt).getTime()) + 7 * 86_400_000))));
  const [reason, setReason] = useState('');
  const extend = useMutation({ mutationFn: () => api.post(`/shares/${share.id}/extend`, { expiresAt: new Date(until).toISOString(), reason }), onSuccess: () => { setDialog(null); setReason(''); done('Expiry extended'); } });
  const [re, setRe] = useState({ rotateAccessCode: false, emailLink: true, emailAccessCode: false });
  const reissue = useMutation({ mutationFn: () => api.post<CreatedShare>(`/shares/${share.id}/reissue`, { reason, ...re, emailLink: re.emailLink && !!opts.data?.emailConfigured, emailAccessCode: re.emailAccessCode && re.rotateAccessCode && re.emailLink }), onSuccess: () => void qc.invalidateQueries({ queryKey: ['shares'] }) });
  const close = () => { setDialog(null); reissue.reset(); setReason(''); };
  return (
    <>
      {share.canUnlock && <Button variant="secondary" onClick={() => { unlock.reset(); setDialog('unlock'); }}>Unlock</Button>}
      {share.canExtend && <Button variant="secondary" onClick={() => { extend.reset(); setDialog('extend'); }}>Extend</Button>}
      {share.canReissue && <Button variant="secondary" onClick={() => { reissue.reset(); setDialog('reissue'); }}>{opts.data?.emailConfigured ? 'Re-send link by e-mail' : 'Re-issue link'}</Button>}
      <ConfirmDialog open={dialog === 'unlock'} title="Unlock share" requireReason reasonLabel="Why is it safe to unlock?" confirmLabel="Unlock"
        message={`The share was locked after ${share.failedCodeAttempts} wrong access codes. Unlock only after confirming with the recipient that the attempts were theirs.`}
        loading={unlock.isPending} error={unlock.error} onConfirm={(r) => unlock.mutate(r)} onCancel={() => setDialog(null)} />
      <Modal open={dialog === 'extend'} onClose={() => setDialog(null)} title="Extend share"
        footer={<><Button variant="secondary" onClick={() => setDialog(null)}>Cancel</Button><Button disabled={reason.trim().length < 5} loading={extend.isPending} onClick={() => extend.mutate()}>Extend</Button></>}>
        <div className="space-y-3 text-sm">
          <p>Currently expires {formatDateTime(share.expiresAt)}. At most {opts.data?.maxShareDays ?? 30} days from now.</p>
          <Field label="New expiry" htmlFor="sx-until" required><Input id="sx-until" type="datetime-local" value={until} max={localInput(max)} onChange={(e) => setUntil(e.target.value)} /></Field>
          <Field label="Reason" htmlFor="sx-reason" required hint="At least 5 characters; recorded in the chain of custody."><Textarea id="sx-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          {extend.error ? <Alert tone="red">{errorMessage(extend.error)}</Alert> : null}
        </div>
      </Modal>
      <Modal open={dialog === 'reissue'} onClose={close} title="Re-issue share link"
        footer={reissue.data ? <Button onClick={close}>Done</Button> : <><Button variant="secondary" onClick={close}>Cancel</Button><Button disabled={reason.trim().length < 5} loading={reissue.isPending} onClick={() => reissue.mutate()}>Re-issue</Button></>}>
        {reissue.data ? (
          <div className="space-y-3 text-sm">
            {deliveryText(reissue.data.delivery) && <Alert tone={reissue.data.delivery?.link === 'FAILED' || reissue.data.delivery?.accessCode === 'FAILED' ? 'red' : 'green'}>{deliveryText(reissue.data.delivery)}</Alert>}
            <Alert tone="amber" title="Shown only once">The previous link no longer works.{reissue.data.accessCode ? ' The previous access code no longer works either.' : ' The access code is unchanged.'}</Alert>
            <Field label="New link" htmlFor="sr-link"><div className="flex gap-2"><Input id="sr-link" readOnly value={reissue.data.link} className="mono text-xs" /><CopyButton value={reissue.data.link!} /></div></Field>
            {reissue.data.accessCode && <Field label="New access code" htmlFor="sr-code"><div className="flex gap-2"><Input id="sr-code" readOnly value={reissue.data.accessCode} className="mono text-lg tracking-widest" /><CopyButton value={reissue.data.accessCode} /></div></Field>}
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            <p>A new link replaces the current one (the old link stops working). Use this when the recipient lost the link or it went to the wrong place.</p>
            <Checkbox label="Also issue a new access code" description="The current code is stored only as a hash and cannot be shown again." checked={re.rotateAccessCode} onChange={(v) => setRe({ ...re, rotateAccessCode: v, emailAccessCode: v && re.emailAccessCode })} />
            {opts.data?.emailConfigured
              ? <Checkbox label={`E-mail the new link to ${share.recipient.email}`} checked={re.emailLink} onChange={(v) => setRe({ ...re, emailLink: v, emailAccessCode: v && re.emailAccessCode })} />
              : <Alert tone="blue">E-mail delivery is not configured; give the recipient the new link yourself.</Alert>}
            {opts.data?.emailConfigured && re.emailLink && re.rotateAccessCode && (
              <Checkbox label="Also e-mail the new access code (separate message)" description="Not recommended: anyone with access to that mailbox could then open the share. Prefer phone/SMS for the code." checked={re.emailAccessCode} onChange={(v) => setRe({ ...re, emailAccessCode: v })} />
            )}
            <Field label="Reason" htmlFor="sr-reason" required hint="At least 5 characters; recorded in the chain of custody."><Textarea id="sr-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
            {reissue.error ? <Alert tone="red">{errorMessage(reissue.error)}</Alert> : null}
          </div>
        )}
      </Modal>
    </>
  );
}
