/** Workspaces I own or am a member of; create new. */
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { FolderKanban, Plus } from 'lucide-react';
import { api, errorMessage } from '@/lib/api';
import { useUrlState } from '@/lib/hooks';
import { formatDateTime, titleCase } from '@/lib/format';
import { Alert, Badge, Button, Card, DataTable, EmptyState, Field, Input, Modal, PageHeader, Pagination, Select, StatusBadge, Textarea, type Column } from '@/components/ui';
import { useWorkspaces, useWsMutation, type WorkspaceDetail, type WorkspaceSummary } from './api';

import { t } from '@/lib/i18n';
const DEFAULTS = { scope: 'all', status: 'ACTIVE', q: '', page: '1' };

export function CreateWorkspaceModal({ open, onClose, onCreated, caseId }: { open: boolean; onClose: () => void; onCreated: (w: WorkspaceDetail) => void; caseId?: string }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const create = useWsMutation((b: { title: string; description?: string; caseId?: string }) => api.post<WorkspaceDetail>('/workspaces', b));
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('New investigation workspace')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{t('Cancel')}</Button>
          <Button disabled={!title.trim()} loading={create.isPending} onClick={() => create.mutate({ title: title.trim(), description: description.trim() || undefined, caseId }, { onSuccess: (w) => { setTitle(''); setDescription(''); onCreated(w); } })}>
            {t('Create')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label={t('Title')} htmlFor="nw-title" required><Input id="nw-title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} autoFocus /></Field>
        <Field label={t('Description')} htmlFor="nw-desc"><Textarea id="nw-desc" rows={3} value={description} maxLength={5000} onChange={(e) => setDescription(e.target.value)} /></Field>
        <p className="text-xs text-ink-500">{t('You become the owner. Colleagues you add see only the evidence their own access allows.')}</p>
        {create.error && <Alert tone="red">{errorMessage(create.error)}</Alert>}
      </div>
    </Modal>
  );
}

export function WorkspacesPage() {
  const [s, set] = useUrlState(DEFAULTS);
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const page = Number(s.page) || 1;
  const list = useWorkspaces({ scope: s.scope, status: s.status, q: s.q || undefined, page, pageSize: 25 });
  const columns: Column<WorkspaceSummary>[] = [
    { key: 'title', header: t('Workspace'), render: (w) => <div><p className="font-medium text-ink-900">{w.title}</p>{w.description && <p className="line-clamp-1 text-xs text-ink-500">{w.description}</p>}</div> },
    { key: 'case', header: t('Case'), render: (w) => (w.case ? <span className="mono text-xs">{w.case.caseNumber}</span> : w.caseRestricted ? <span className="text-xs text-ink-500">{t('Restricted')}</span> : '—') },
    { key: 'owner', header: t('Owner'), render: (w) => w.owner.fullName },
    { key: 'role', header: t('My role'), render: (w) => <Badge tone={w.myRole === 'OWNER' ? 'blue' : 'gray'}>{titleCase(w.myRole)}</Badge> },
    { key: 'items', header: t('Items'), render: (w) => w.itemCount },
    { key: 'members', header: t('Members'), render: (w) => w.memberCount },
    { key: 'status', header: t('Status'), render: (w) => <StatusBadge status={w.status} /> },
    { key: 'updated', header: t('Updated'), render: (w) => formatDateTime(w.updatedAt) },
  ];
  return (
    <div className="space-y-4">
      <PageHeader title={t('Investigation workspaces')} subtitle={t('Collect evidence, compare angles in sync, annotate and reconstruct incidents.')} actions={<Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>{t('New workspace')}</Button>} />
      <Card>
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('Show')} htmlFor="ws-scope">
          <Select id="ws-scope" value={s.scope} onChange={(e) => set({ scope: e.target.value })}>
            <option value="all">{t('All my workspaces')}</option>
            <option value="mine">{t('Owned by me')}</option>
            <option value="shared">{t('Shared with me')}</option>
          </Select>
        </Field>
        <Field label={t('Status')} htmlFor="ws-status">
          <Select id="ws-status" value={s.status} onChange={(e) => set({ status: e.target.value })}>
            <option value="ACTIVE">{t('Active')}</option>
            <option value="ARCHIVED">{t('Archived')}</option>
            <option value="ANY">{t('Any')}</option>
          </Select>
        </Field>
        <Field label={t('Title contains')} htmlFor="ws-q"><Input id="ws-q" value={s.q} onChange={(e) => set({ q: e.target.value })} /></Field>
      </div>
      </Card>
      <Card bodyClassName="p-0">
      <DataTable
        columns={columns}
        rows={list.data?.items}
        rowKey={(w) => w.id}
        loading={list.isLoading}
        error={list.error}
        onRetry={() => void list.refetch()}
        onRowClick={(w) => navigate(`/workspaces/${w.id}`)}
        empty={<EmptyState title={t('No workspaces')} description={t('Create one to start an investigation.')} icon={<FolderKanban className="h-6 w-6" />} />}
        caption={t('Investigation workspaces')}
      />
      {list.data && <Pagination page={page} pageSize={25} total={list.data.total} onPage={(p) => set({ page: String(p) })} />}
      </Card>
      <CreateWorkspaceModal open={creating} onClose={() => setCreating(false)} onCreated={(w) => navigate(`/workspaces/${w.id}`)} />
    </div>
  );
}
