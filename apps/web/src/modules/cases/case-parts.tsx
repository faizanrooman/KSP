/** Case detail tabs: overview/edit, status workflow, evidence links, team, diary, timeline. */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, Link2, Pencil, Trash2, UserPlus } from 'lucide-react';
import { CASE_MEMBER_ROLES, CASE_PRIORITIES, caseTransitionNeedsReason } from '@ksp/shared';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime, formatDuration, shortHash, titleCase } from '@/lib/format';
import { UserPicker, type UserOption } from '@/components/pickers';
import {
  Alert, Badge, Button, Card, ConfirmDialog, DataTable, EmptyState, ErrorState, Field, Input, KeyValue, Modal, Pagination, Select, Spinner, StatusBadge, Textarea,
  useToast, type Column,
} from '@/components/ui';
import { caseKey, type CaseDetail, type CaseEvidenceItem, type CaseNote, type Fir, type Paged, type TimelineItem } from './types';
import { FirSelect } from './CasesListPage';

function useRefreshCase(id: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: caseKey(id) });
    void qc.invalidateQueries({ queryKey: ['cases', 'list'] });
    void qc.invalidateQueries({ queryKey: ['cases', 'evidence', id] });
    void qc.invalidateQueries({ queryKey: ['cases', 'timeline', id] });
  };
}

// ------------------------------------------------------------------------------------------ status
export function StatusButton({ caseItem: c }: { caseItem: CaseDetail }) {
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  const toast = useToast();
  const refresh = useRefreshCase(c.id);
  useEffect(() => {
    if (open) {
      setTo(c.allowedTransitions[0] ?? '');
      setReason('');
    }
  }, [open, c.allowedTransitions]);
  const needsReason = !!to && caseTransitionNeedsReason(c.status, to);
  const m = useMutation({
    mutationFn: () => api.post(`/cases/${c.id}/status`, { status: to, ...(reason.trim() ? { reason: reason.trim() } : {}) }),
    onSuccess: () => {
      setOpen(false);
      toast.success(`Case moved to ${titleCase(to)}`);
      refresh();
    },
  });
  if (!c.allowedTransitions.length) return null;
  const reopen = c.status === 'CLOSED' || c.status === 'ARCHIVED';
  return (
    <>
      <Button variant="secondary" icon={<ArrowRightLeft className="h-4 w-4" />} onClick={() => { m.reset(); setOpen(true); }}>Change status</Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Change case status"
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={m.isPending}>Cancel</Button>
            <Button onClick={() => m.mutate()} loading={m.isPending} disabled={!to || (needsReason && reason.trim().length < 5)}>Confirm</Button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          <p>Current status: <StatusBadge status={c.status} /></p>
          <Field label="New status" htmlFor="cs-to">
            <Select id="cs-to" value={to} onChange={(e) => setTo(e.target.value)}>
              {c.allowedTransitions.map((s) => <option key={s} value={s}>{reopen && s === 'UNDER_INVESTIGATION' ? 'Reopen (Under investigation)' : titleCase(s)}</option>)}
            </Select>
          </Field>
          <Field label={needsReason ? 'Reason' : 'Reason (optional)'} required={needsReason} htmlFor="cs-reason" hint="Recorded in the audit trail and case timeline.">
            <Textarea id="cs-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          {m.error ? <Alert tone="red">{errorMessage(m.error)}</Alert> : null}
        </div>
      </Modal>
    </>
  );
}

// ------------------------------------------------------------------------------------------ overview
export function OverviewTab({ caseItem: c }: { caseItem: CaseDetail }) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card title="Case details" className="lg:col-span-2" actions={c.permissions.canManage && c.status !== 'ARCHIVED' ? <Button size="sm" variant="secondary" icon={<Pencil className="h-4 w-4" />} onClick={() => setEditing(true)}>Edit</Button> : undefined}>
        <KeyValue
          items={[
            { label: 'Case number', value: c.caseNumber, mono: true },
            { label: 'Station', value: c.orgUnit.name },
            { label: 'Status', value: <StatusBadge status={c.status} /> },
            { label: 'Priority', value: titleCase(c.priority) },
            { label: 'Investigating officer', value: c.investigatingOfficer ? `${c.investigatingOfficer.fullName}${c.investigatingOfficer.badgeNumber ? ` (${c.investigatingOfficer.badgeNumber})` : ''}` : 'Unassigned' },
            { label: 'Supervisor', value: c.supervisor ? `${c.supervisor.fullName}${c.supervisor.badgeNumber ? ` (${c.supervisor.badgeNumber})` : ''}` : '—' },
            { label: 'Court', value: c.court.name ?? '—' },
            { label: 'Court case number', value: c.court.caseNumber ?? '—' },
            { label: 'External reference', value: c.external.ref ? `${c.external.system ?? 'External'}: ${c.external.ref}` : '—' },
            { label: 'Opened', value: formatDateTime(c.openedAt) },
            c.closedAt ? { label: 'Closed', value: formatDateTime(c.closedAt) } : null,
            { label: 'Created by', value: c.createdBy?.fullName ?? '—' },
          ]}
        />
        {c.description && <p className="mt-4 whitespace-pre-wrap text-sm text-ink-800">{c.description}</p>}
      </Card>
      <Card title="FIR">
        {c.fir ? (
          <KeyValue
            columns={1}
            items={[
              { label: 'FIR', value: <Link className="mono text-brand-700 hover:underline" to={`/firs/${c.fir.id}`}>{c.fir.displayNumber}</Link> },
              { label: 'Acts / sections', value: c.fir.actsSections.join(', ') || '—' },
              { label: 'Registered', value: formatDateTime(c.fir.registeredAt) },
              { label: 'FIR status', value: titleCase(c.fir.status) },
              { label: 'Source', value: titleCase(c.fir.source) },
            ]}
          />
        ) : <EmptyState title="No FIR linked" description={c.permissions.canManage ? 'Use Edit to link a FIR.' : undefined} />}
        {c.hiddenEvidenceCount > 0 && <div className="mt-3"><Alert tone="amber">{c.hiddenEvidenceCount} linked evidence item(s) are outside your access and not shown.</Alert></div>}
      </Card>
      {editing && <EditCaseModal caseItem={c} onClose={() => setEditing(false)} />}
    </div>
  );
}

function EditCaseModal({ caseItem: c, onClose }: { caseItem: CaseDetail; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefreshCase(c.id);
  const [f, setF] = useState({ title: c.title, description: c.description ?? '', priority: c.priority, courtName: c.court.name ?? '', courtCaseNumber: c.court.caseNumber ?? '', externalSystem: c.external.system ?? '', externalRef: c.external.ref ?? '' });
  const [io, setIo] = useState<UserOption | null>(null);
  const [sup, setSup] = useState<UserOption | null>(null);
  const [firId, setFirId] = useState<string | null | undefined>(undefined);
  const m = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {};
      if (f.title !== c.title) body.title = f.title.trim();
      if (f.description !== (c.description ?? '')) body.description = f.description.trim() || null;
      if (f.priority !== c.priority) body.priority = f.priority;
      if (f.courtName !== (c.court.name ?? '')) body.courtName = f.courtName.trim() || null;
      if (f.courtCaseNumber !== (c.court.caseNumber ?? '')) body.courtCaseNumber = f.courtCaseNumber.trim() || null;
      if (f.externalSystem !== (c.external.system ?? '')) body.externalSystem = f.externalSystem.trim() || null;
      if (f.externalRef !== (c.external.ref ?? '')) body.externalRef = f.externalRef.trim() || null;
      if (io) body.investigatingOfficerId = io.id;
      if (sup) body.supervisorId = sup.id;
      if (firId !== undefined) body.firId = firId;
      return api.patch(`/cases/${c.id}`, body);
    },
    onSuccess: () => {
      toast.success('Case updated');
      refresh();
      onClose();
    },
  });
  const upd = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  return (
    <Modal open onClose={onClose} title={`Edit ${c.caseNumber}`} size="lg" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => m.mutate()} loading={m.isPending} disabled={f.title.trim().length < 3}>Save changes</Button></>}>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="md:col-span-2"><Field label="Title" required htmlFor="ec-title"><Input id="ec-title" value={f.title} onChange={upd('title')} /></Field></div>
        <div className="md:col-span-2"><Field label="Description" htmlFor="ec-desc"><Textarea id="ec-desc" rows={3} value={f.description} onChange={upd('description')} /></Field></div>
        <Field label="Priority" htmlFor="ec-pri"><Select id="ec-pri" value={f.priority} onChange={upd('priority')}>{CASE_PRIORITIES.map((x) => <option key={x} value={x}>{titleCase(x)}</option>)}</Select></Field>
        <Field label="Linked FIR" htmlFor="ec-fir" hint={c.fir ? `Currently ${c.fir.displayNumber}` : 'None linked'}><FirIdPicker id="ec-fir" onChange={setFirId} /></Field>
        <Field label="Change investigating officer" htmlFor="ec-io" hint={c.investigatingOfficer?.fullName ? `Currently ${c.investigatingOfficer.fullName}` : undefined}><UserPicker id="ec-io" value={io} onChange={setIo} /></Field>
        <Field label="Change supervisor" htmlFor="ec-sup" hint={c.supervisor?.fullName ? `Currently ${c.supervisor.fullName}` : undefined}><UserPicker id="ec-sup" value={sup} onChange={setSup} /></Field>
        <Field label="Court" htmlFor="ec-court"><Input id="ec-court" value={f.courtName} onChange={upd('courtName')} /></Field>
        <Field label="Court case number" htmlFor="ec-ccn"><Input id="ec-ccn" value={f.courtCaseNumber} onChange={upd('courtCaseNumber')} /></Field>
        <Field label="External system" htmlFor="ec-es"><Input id="ec-es" value={f.externalSystem} onChange={upd('externalSystem')} placeholder="e.g. CCTNS" /></Field>
        <Field label="External reference" htmlFor="ec-er"><Input id="ec-er" value={f.externalRef} onChange={upd('externalRef')} /></Field>
      </div>
      {m.error ? <div className="mt-3"><Alert tone="red">{errorMessage(m.error)}</Alert></div> : null}
    </Modal>
  );
}

function FirIdPicker({ id, onChange }: { id: string; onChange: (v: string | null) => void }) {
  const [v, setV] = useState<Fir | null>(null);
  return <FirSelect id={id} value={v} onChange={(f) => { setV(f); onChange(f?.id ?? null); }} />;
}

// ------------------------------------------------------------------------------------------ evidence
export function EvidenceTab({ caseItem: c }: { caseItem: CaseDetail }) {
  const [page, setPage] = useState(1);
  const [history, setHistory] = useState(false);
  const [linking, setLinking] = useState(false);
  const [unlink, setUnlink] = useState<CaseEvidenceItem | null>(null);
  const toast = useToast();
  const refresh = useRefreshCase(c.id);
  const q = useQuery({
    queryKey: ['cases', 'evidence', c.id, page, history],
    queryFn: () => api.get<Paged<CaseEvidenceItem> & { hiddenCount: number }>(`/cases/${c.id}/evidence`, { page, pageSize: 25, includeUnlinked: history ? 'true' : undefined }),
    placeholderData: keepPreviousData,
  });
  const um = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => api.delete(`/cases/${c.id}/evidence/${id}`, { reason }),
    onSuccess: () => {
      setUnlink(null);
      toast.success('Evidence unlinked');
      refresh();
    },
  });
  const cols: Column<CaseEvidenceItem>[] = [
    {
      key: 'thumb', header: <span className="sr-only">Thumbnail</span>,
      render: (r) => (r.evidence.thumbnailUrl ? <img src={r.evidence.thumbnailUrl} alt="" className="h-12 w-20 rounded object-cover" loading="lazy" /> : <div className="h-12 w-20 rounded bg-ink-100" aria-hidden />),
    },
    {
      key: 'ev', header: 'Evidence',
      render: (r) => (
        <div>
          <Link to={`/evidence/${r.evidence.id}`} className="mono font-medium text-brand-800 hover:underline">{r.evidence.evidenceNumber ?? r.evidence.id.slice(0, 8)}</Link>
          <p className="text-sm">{r.evidence.title ?? '—'}</p>
          <p className="mono text-xs text-ink-500" title={r.evidence.sha256 ?? undefined}>SHA-256 {shortHash(r.evidence.sha256)}</p>
        </div>
      ),
    },
    { key: 'meta', header: 'Recorded', render: (r) => <div className="text-sm">{formatDateTime(r.evidence.recordedAt)}<p className="text-xs text-ink-500">{formatDuration(r.evidence.durationMs)} · {r.evidence.orgUnitName}</p></div> },
    { key: 'status', header: 'Status', render: (r) => <div className="flex flex-col items-start gap-1"><StatusBadge status={r.evidence.status} />{r.evidence.legalHold && <Badge tone="red">Legal hold</Badge>}</div> },
    {
      key: 'link', header: 'Link',
      render: (r) => (
        <div className="text-xs text-ink-600">
          Linked {formatDateTime(r.linkedAt)} by {r.linkedByName}
          {r.note && <p className="italic">“{r.note}”</p>}
          {r.unlinkedAt && <p className="text-red-700">Unlinked {formatDateTime(r.unlinkedAt)} by {r.unlinkedByName}: {r.unlinkReason}</p>}
        </div>
      ),
    },
    {
      key: 'actions', header: <span className="sr-only">Actions</span>,
      render: (r) => (c.permissions.canLinkEvidence && !r.unlinkedAt && c.status !== 'ARCHIVED' ? <Button size="sm" variant="ghost" icon={<Trash2 className="h-4 w-4" />} onClick={() => { um.reset(); setUnlink(r); }}>Unlink</Button> : null),
    },
  ];
  return (
    <Card
      title="Linked evidence"
      bodyClassName="p-0"
      actions={
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-xs text-ink-600"><input type="checkbox" checked={history} onChange={(e) => { setHistory(e.target.checked); setPage(1); }} /> Show unlinked</label>
          {c.permissions.canLinkEvidence && !['CLOSED', 'ARCHIVED'].includes(c.status) && <Button size="sm" icon={<Link2 className="h-4 w-4" />} onClick={() => setLinking(true)}>Link evidence</Button>}
        </div>
      }
    >
      {q.data && q.data.hiddenCount > 0 && <div className="p-3"><Alert tone="amber">{q.data.hiddenCount} linked item(s) are outside your access and not listed.</Alert></div>}
      <DataTable caption="Linked evidence" columns={cols} rows={q.data?.items} rowKey={(r) => r.linkId} loading={q.isFetching} error={q.error} onRetry={() => void q.refetch()} empty={<EmptyState title="No evidence linked" description={c.permissions.canLinkEvidence ? 'Use “Link evidence” to attach footage to this case.' : undefined} />} />
      {q.data && <Pagination page={q.data.page} pageSize={q.data.pageSize} total={q.data.total} onPage={setPage} />}
      {linking && <LinkEvidenceModal caseId={c.id} onClose={() => setLinking(false)} onDone={refresh} />}
      <ConfirmDialog
        open={!!unlink}
        title="Unlink evidence"
        message={<>Unlink <span className="mono">{unlink?.evidence.evidenceNumber}</span> from {c.caseNumber}? The link history is kept and the action is recorded in the chain of custody.</>}
        confirmLabel="Unlink"
        variant="danger"
        requireReason
        loading={um.isPending}
        error={um.error}
        onConfirm={(reason) => unlink && um.mutate({ id: unlink.evidence.id, reason })}
        onCancel={() => setUnlink(null)}
      />
    </Card>
  );
}

interface EvidenceSearchItem { id: string; evidenceNumber: string | null; title: string | null; recordedAt: string | null; orgUnit: { name: string }; status: string }

export function LinkEvidenceModal({ caseId, onClose, onDone }: { caseId: string; onClose: () => void; onDone: () => void }) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [selected, setSelected] = useState<Record<string, EvidenceSearchItem>>({});
  const [note, setNote] = useState('');
  const toast = useToast();
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const res = useQuery({
    queryKey: ['evidence', 'pick', debounced],
    queryFn: () => api.get<Paged<EvidenceSearchItem>>('/evidence', { q: debounced || undefined, status: 'REGISTERED,DISPOSAL_PENDING', pageSize: 20 }),
    enabled: debounced.length >= 2,
  });
  const m = useMutation({
    mutationFn: () => api.post<{ results: Array<{ evidenceId: string; status: string; evidenceNumber?: string | null }>; linked: number }>(`/cases/${caseId}/evidence`, { evidenceIds: Object.keys(selected), note: note.trim() || undefined }),
    onSuccess: (r) => {
      const problems = r.results.filter((x) => x.status !== 'LINKED');
      toast.success(`${r.linked} item(s) linked${problems.length ? `; ${problems.length} skipped` : ''}`);
      onDone();
      if (!problems.length) onClose();
    },
  });
  const ids = Object.keys(selected);
  return (
    <Modal open onClose={onClose} title="Link evidence to case" size="lg" footer={<><Button variant="secondary" onClick={onClose}>Close</Button><Button onClick={() => m.mutate()} loading={m.isPending} disabled={!ids.length}>Link {ids.length || ''} item(s)</Button></>}>
      <div className="space-y-3">
        <Field label="Search evidence" htmlFor="le-q" hint="Evidence number or title (at least 2 characters). Only evidence you can access is shown.">
          <Input id="le-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="KSP-CUBBONPARK-2026-…" autoFocus />
        </Field>
        {res.isFetching && !res.data && <Spinner label="Searching…" />}
        {res.error ? <ErrorState error={res.error} onRetry={() => void res.refetch()} /> : null}
        {res.data && (res.data.items.length === 0 ? <p className="text-sm text-ink-500">No matching evidence.</p> : (
          <ul className="max-h-64 divide-y divide-ink-100 overflow-y-auto rounded-md border border-ink-200">
            {res.data.items.map((e) => (
              <li key={e.id}>
                <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-brand-50">
                  <input type="checkbox" checked={!!selected[e.id]} onChange={(ev) => setSelected((s) => { const n = { ...s }; if (ev.target.checked) n[e.id] = e; else delete n[e.id]; return n; })} />
                  <span className="mono">{e.evidenceNumber}</span>
                  <span className="flex-1 truncate">{e.title}</span>
                  <span className="text-xs text-ink-500">{e.orgUnit.name} · {formatDateTime(e.recordedAt)}</span>
                </label>
              </li>
            ))}
          </ul>
        ))}
        {ids.length > 0 && <p className="text-sm">Selected: {Object.values(selected).map((e) => e.evidenceNumber).join(', ')}</p>}
        <Field label="Note (optional)" htmlFor="le-note"><Input id="le-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} /></Field>
        {m.data && m.data.results.some((r) => r.status !== 'LINKED') && (
          <Alert tone="amber" title="Some items were not linked">
            <ul className="list-disc pl-5">{m.data.results.filter((r) => r.status !== 'LINKED').map((r) => <li key={r.evidenceId}>{r.evidenceNumber ?? r.evidenceId.slice(0, 8)}: {titleCase(r.status)}</li>)}</ul>
          </Alert>
        )}
        {m.error ? <Alert tone="red">{errorMessage(m.error)}</Alert> : null}
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------------------------------ team
export function TeamTab({ caseItem: c }: { caseItem: CaseDetail }) {
  const toast = useToast();
  const refresh = useRefreshCase(c.id);
  const [user, setUser] = useState<UserOption | null>(null);
  const [role, setRole] = useState('MEMBER');
  const [removing, setRemoving] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: () => api.post(`/cases/${c.id}/members`, { userId: user!.id, role }),
    onSuccess: () => {
      toast.success('Team member added');
      setUser(null);
      refresh();
    },
  });
  const rm = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => api.delete(`/cases/${c.id}/members/${id}`, { reason }),
    onSuccess: () => {
      setRemoving(null);
      toast.success('Team member removed');
      refresh();
    },
  });
  const editable = c.permissions.canManage && !['CLOSED', 'ARCHIVED'].includes(c.status);
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card title="Case team" className="lg:col-span-2" bodyClassName="p-0">
        <ul className="divide-y divide-ink-100 text-sm">
          <li className="flex items-center justify-between px-4 py-3"><span><strong>Investigating officer</strong>: {c.investigatingOfficer?.fullName ?? 'Unassigned'}</span><Badge tone="blue">IO</Badge></li>
          <li className="flex items-center justify-between px-4 py-3"><span><strong>Supervisor</strong>: {c.supervisor?.fullName ?? '—'}</span><Badge tone="purple">Supervisor</Badge></li>
          {c.members.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <span>
                {m.fullName} <span className="text-ink-500">{m.badgeNumber ?? `@${m.username}`} · {m.orgUnitName}</span>
                <span className="block text-xs text-ink-500">Added {formatDateTime(m.addedAt)}{m.addedByName ? ` by ${m.addedByName}` : ''}</span>
              </span>
              <span className="flex items-center gap-2">
                <Badge>{titleCase(m.role)}</Badge>
                {m.userStatus !== 'ACTIVE' && <Badge tone="red">{titleCase(m.userStatus)}</Badge>}
                {editable && <Button size="sm" variant="ghost" onClick={() => { rm.reset(); setRemoving(m.id); }} aria-label={`Remove ${m.fullName}`}>Remove</Button>}
              </span>
            </li>
          ))}
          {!c.members.length && <li className="px-4 py-3 text-ink-500">No additional team members.</li>}
        </ul>
      </Card>
      {editable && (
        <Card title="Add team member">
          <div className="space-y-3">
            <p className="text-xs text-ink-600">Team members (from any station) can see the evidence linked to this case while they are on the team.</p>
            <Field label="Officer" htmlFor="tm-user"><UserPicker id="tm-user" value={user} onChange={setUser} /></Field>
            <Field label="Role" htmlFor="tm-role"><Select id="tm-role" value={role} onChange={(e) => setRole(e.target.value)}>{CASE_MEMBER_ROLES.map((r) => <option key={r} value={r}>{titleCase(r)}</option>)}</Select></Field>
            <Button icon={<UserPlus className="h-4 w-4" />} disabled={!user} loading={add.isPending} onClick={() => add.mutate()}>Add to team</Button>
            {add.error ? <Alert tone="red">{errorMessage(add.error)}</Alert> : null}
          </div>
        </Card>
      )}
      <ConfirmDialog
        open={!!removing}
        title="Remove team member"
        message="The officer will immediately lose case-based access to the linked evidence."
        confirmLabel="Remove"
        variant="danger"
        requireReason
        loading={rm.isPending}
        error={rm.error}
        onConfirm={(reason) => removing && rm.mutate({ id: removing, reason })}
        onCancel={() => setRemoving(null)}
      />
    </div>
  );
}

// ------------------------------------------------------------------------------------------ diary
export function DiaryTab({ caseItem: c }: { caseItem: CaseDetail }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [body, setBody] = useState('');
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: ['cases', 'notes', c.id, page], queryFn: () => api.get<Paged<CaseNote>>(`/cases/${c.id}/notes`, { page, pageSize: 50 }), placeholderData: keepPreviousData });
  const m = useMutation({
    mutationFn: () => api.post<CaseNote>(`/cases/${c.id}/notes`, { body: body.trim() }),
    onSuccess: () => {
      setBody('');
      toast.success('Diary entry added');
      void qc.invalidateQueries({ queryKey: ['cases', 'notes', c.id] });
      void qc.invalidateQueries({ queryKey: ['cases', 'timeline', c.id] });
    },
  });
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card title="Case diary" className="lg:col-span-2">
        {q.isLoading ? <Spinner /> : q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : !q.data?.items.length ? <EmptyState title="No diary entries yet" /> : (
          <ol className="space-y-3">
            {q.data.items.map((n) => (
              <li key={n.id} className="rounded-md border border-ink-200 p-3">
                <p className="text-xs text-ink-500">{formatDateTime(n.createdAt)} · {n.author.fullName}</p>
                <p className="mt-1 whitespace-pre-wrap text-sm text-ink-900">{n.body}</p>
              </li>
            ))}
          </ol>
        )}
        {q.data && q.data.total > q.data.pageSize && <Pagination page={q.data.page} pageSize={q.data.pageSize} total={q.data.total} onPage={setPage} />}
      </Card>
      {c.permissions.canAddNote && c.status !== 'ARCHIVED' && (
        <Card title="New entry">
          <div className="space-y-3">
            <Alert tone="blue">Diary entries are append-only: they cannot be edited or deleted once saved.</Alert>
            <Field label="Entry" htmlFor="cd-body"><Textarea id="cd-body" rows={6} value={body} onChange={(e) => setBody(e.target.value)} maxLength={20000} /></Field>
            <Button disabled={!body.trim()} loading={m.isPending} onClick={() => m.mutate()}>Add entry</Button>
            {m.error ? <Alert tone="red">{errorMessage(m.error)}</Alert> : null}
          </div>
        </Card>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------ timeline
const CAT_TONE = { CASE: 'blue', STATUS: 'purple', EVIDENCE: 'amber', DIARY: 'green' } as const;

export function TimelineTab({ caseItem: c }: { caseItem: CaseDetail }) {
  const [views, setViews] = useState(false);
  const q = useQuery({ queryKey: ['cases', 'timeline', c.id, views], queryFn: () => api.get<{ items: TimelineItem[]; includesEvidenceCustody: boolean }>(`/cases/${c.id}/timeline`, { includeViews: views ? 'true' : undefined }) });
  return (
    <Card title="Case timeline" actions={<label className="flex items-center gap-1 text-xs text-ink-600"><input type="checkbox" checked={views} onChange={(e) => setViews(e.target.checked)} /> Include views/playback</label>}>
      {q.isLoading ? <Spinner /> : q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : !q.data?.items.length ? <EmptyState title="No activity yet" /> : (
        <>
          {!q.data.includesEvidenceCustody && <div className="mb-3"><Alert tone="blue">Custody events of linked evidence are shown to users with chain-of-custody access.</Alert></div>}
          <ol className="relative space-y-3 border-l border-ink-200 pl-4">
            {q.data.items.map((i, idx) => (
              <li key={`${i.at}-${idx}`} className="text-sm">
                <p className="text-xs text-ink-500">
                  <time dateTime={i.at}>{formatDateTime(i.at)}</time> · {i.actor.name ?? titleCase(i.actor.type)} <Badge tone={CAT_TONE[i.category]}>{titleCase(i.category)}</Badge>
                  {i.outcome !== 'SUCCESS' && <Badge tone="red">{titleCase(i.outcome)}</Badge>}
                </p>
                <p className="mt-0.5 whitespace-pre-wrap text-ink-900">{i.summary}</p>
                {i.evidenceId && <Link to={`/evidence/${i.evidenceId}`} className="text-xs text-brand-700 hover:underline">Open evidence</Link>}
              </li>
            ))}
          </ol>
        </>
      )}
    </Card>
  );
}
