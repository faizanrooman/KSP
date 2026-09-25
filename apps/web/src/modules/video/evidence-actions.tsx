import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Download, RefreshCw } from 'lucide-react';
import type { EvidenceAction, EvidenceSummary } from '@/lib/extensions';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatBytes, shortHash } from '@/lib/format';
import { Button, ConfirmDialog, useToast } from '@/components/ui';
import { playbackKey } from './api';

/** The evidence detail endpoint may add this flag (download_original permission incl. share grants). */
type WithDownloadFlag = EvidenceSummary & { canDownloadOriginal?: boolean; originalFilename?: string; sizeBytes?: number };

function DownloadOriginal({ evidence }: { evidence: EvidenceSummary }) {
  const ev = evidence as WithDownloadFlag;
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const mut = useMutation({
    mutationFn: () => api.get<{ url: string; filename: string; sha256: string; sizeBytes: number }>(`/media/evidence/${evidence.id}/original`),
    onSuccess: (r) => {
      setOpen(false);
      const a = document.createElement('a');
      a.href = r.url;
      a.download = r.filename;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast.success(`Download started (${formatBytes(r.sizeBytes)}). Verify SHA-256 ${shortHash(r.sha256, 16)}`);
    },
  });
  // Hidden unless the detail object explicitly grants it (missing flag = hidden).
  if (ev.canDownloadOriginal !== true) return null;
  return (
    <>
      <Button variant="secondary" icon={<Download className="h-4 w-4" />} onClick={() => setOpen(true)}>
        Download original
      </Button>
      <ConfirmDialog
        open={open}
        title="Download original evidence file"
        message={
          <div className="space-y-2">
            <p>The unmodified original file will be downloaded. This download is recorded in the chain of custody under your name.</p>
            {evidence.sha256 && <p className="mono break-all text-xs">SHA-256: {evidence.sha256}</p>}
          </div>
        }
        confirmLabel="Download"
        loading={mut.isPending}
        error={mut.error}
        onConfirm={() => mut.mutate()}
        onCancel={() => setOpen(false)}
      />
    </>
  );
}

function Reprocess({ evidence }: { evidence: EvidenceSummary }) {
  const { canAny } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const mut = useMutation({
    mutationFn: (reason: string) => api.post(`/media/evidence/${evidence.id}/reprocess`, { reason }),
    onSuccess: () => {
      setOpen(false);
      toast.success('Media reprocessing queued');
      void qc.invalidateQueries({ queryKey: playbackKey(evidence.id) });
      void qc.invalidateQueries({ queryKey: ['evidence'] });
    },
  });
  if (!canAny('evidence:edit_metadata', 'system:monitor')) return null;
  if (!['REGISTERED', 'DISPOSAL_PENDING'].includes(evidence.status)) return null;
  return (
    <>
      <Button variant="secondary" icon={<RefreshCw className="h-4 w-4" />} onClick={() => setOpen(true)}>
        Reprocess media
      </Button>
      <ConfirmDialog
        open={open}
        title="Reprocess media"
        message="All playback derivatives (proxy, adaptive stream, poster, thumbnails, sprite sheets) will be regenerated from the original. The original file and existing snapshots are not changed. Playback is unavailable until processing completes."
        confirmLabel="Reprocess"
        requireReason
        minReason={5}
        loading={mut.isPending}
        error={mut.error}
        onConfirm={(reason) => mut.mutate(reason)}
        onCancel={() => setOpen(false)}
      />
    </>
  );
}

const actions: EvidenceAction[] = [
  { id: 'download-original', order: 50, component: DownloadOriginal },
  { id: 'reprocess-media', order: 90, anyOf: ['evidence:edit_metadata', 'system:monitor'], component: Reprocess },
];
export default actions;
