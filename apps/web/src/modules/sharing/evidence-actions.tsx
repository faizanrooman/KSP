/** Evidence detail action "Share" (shown when the API's canShare flag allows it). */
import { useState } from 'react';
import { Share2 } from 'lucide-react';
import type { EvidenceAction, EvidenceSummary } from '@/lib/extensions';
import { Button } from '@/components/ui';
import { ShareDialog } from './ShareDialog';

type WithFlags = EvidenceSummary & { permissions?: { canShare?: boolean; canDownloadOriginal?: boolean } };

function ShareButton({ evidence }: { evidence: EvidenceSummary }) {
  const [open, setOpen] = useState(false);
  const ev = evidence as WithFlags;
  if (ev.permissions?.canShare !== true) return null;
  return (
    <>
      <Button variant="secondary" size="sm" icon={<Share2 className="h-4 w-4" />} onClick={() => setOpen(true)}>Share</Button>
      {open && <ShareDialog items={[{ id: ev.id, evidenceNumber: ev.evidenceNumber, canDownloadOriginal: ev.permissions?.canDownloadOriginal === true }]} onClose={() => setOpen(false)} />}
    </>
  );
}

const actions: EvidenceAction[] = [{ id: 'share', order: 65, anyOf: ['share:create'], component: ShareButton }];
export default actions;
