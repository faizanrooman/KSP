/** Evidence detail action "Export for court" (shown when the API's canExport flag allows it). */
import { useNavigate } from 'react-router-dom';
import { Gavel } from 'lucide-react';
import type { EvidenceAction, EvidenceSummary } from '@/lib/extensions';
import { Button } from '@/components/ui';

type WithFlags = EvidenceSummary & { permissions?: { canExport?: boolean } };

function ExportForCourt({ evidence }: { evidence: EvidenceSummary }) {
  const navigate = useNavigate();
  if ((evidence as WithFlags).permissions?.canExport !== true) return null;
  return (
    <Button
      variant="secondary"
      size="sm"
      icon={<Gavel className="h-4 w-4" />}
      onClick={() => navigate(`/exports/new?evidence=${evidence.id}`, { state: { items: [{ id: evidence.id, evidenceNumber: evidence.evidenceNumber, title: evidence.title, durationMs: evidence.durationMs }] } })}
    >
      Export for court
    </Button>
  );
}

const actions: EvidenceAction[] = [{ id: 'export-for-court', order: 60, anyOf: ['export:create'], component: ExportForCourt }];
export default actions;
