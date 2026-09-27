/** Evidence detail action: add this evidence to one of my workspaces (editor/owner) or a new one. */
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { FolderPlus } from 'lucide-react';
import type { EvidenceAction, EvidenceSummary } from '@/lib/extensions';
import { api, errorMessage } from '@/lib/api';
import { Alert, Button, EmptyState, ErrorState, Modal, Spinner, useToast } from '@/components/ui';
import { canEdit, useWorkspaces, useWsMutation, type WorkspaceDetail } from './api';
import { CreateWorkspaceModal } from './WorkspacesPage';

function AddToWorkspace({ evidence }: { evidence: EvidenceSummary }) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const toast = useToast();
  const navigate = useNavigate();
  const list = useWorkspaces({ status: 'ACTIVE', pageSize: 100 });
  const add = useWsMutation((wsId: string) => api.post<{ added: string[] }>(`/workspaces/${wsId}/items`, { evidenceIds: [evidence.id] }).then((r) => ({ ...r, wsId })));
  const writable = (list.data?.items ?? []).filter((w) => canEdit(w.myRole));
  const done = (r: { added: string[]; wsId: string }) => {
    setOpen(false);
    toast.success(r.added.length ? 'Added to workspace' : 'Already in that workspace');
  };
  return (
    <>
      <Button variant="secondary" icon={<FolderPlus className="h-4 w-4" />} onClick={() => setOpen(true)}>Add to workspace</Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Add to investigation workspace">
        {list.isLoading ? <Spinner /> : list.error ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : !writable.length ? (
          <EmptyState title="No workspaces you can edit" description="Create a workspace to collect this evidence." />
        ) : (
          <ul className="max-h-80 divide-y divide-ink-100 overflow-y-auto">
            {writable.map((w) => (
              <li key={w.id} className="flex items-center justify-between gap-2 py-2">
                <span className="text-sm">{w.title}<span className="block text-xs text-ink-500">{w.itemCount} item(s){w.case ? ` · ${w.case.caseNumber}` : ''}</span></span>
                <Button size="sm" loading={add.isPending && add.variables === w.id} onClick={() => add.mutate(w.id, { onSuccess: done })}>Add</Button>
              </li>
            ))}
          </ul>
        )}
        {add.error && <div className="mt-2"><Alert tone="red">{errorMessage(add.error)}</Alert></div>}
        <div className="mt-3 flex justify-end">
          <Button variant="secondary" onClick={() => { setOpen(false); setCreating(true); }}>New workspace…</Button>
        </div>
      </Modal>
      <CreateWorkspaceModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(w: WorkspaceDetail) => {
          setCreating(false);
          add.mutate(w.id, { onSuccess: () => navigate(`/workspaces/${w.id}`) });
        }}
      />
    </>
  );
}

const actions: EvidenceAction[] = [{ id: 'add-to-workspace', order: 60, anyOf: ['workspace:use'], component: AddToWorkspace }];
export default actions;
