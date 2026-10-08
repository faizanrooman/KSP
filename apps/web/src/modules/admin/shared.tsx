import { useQuery } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { api } from '@/lib/api';
import { Alert, Button, CopyButton, Modal } from '@/components/ui';
import type { Role } from './types';

import { t } from '@/lib/i18n';
export function useRoles(enabled = true) {
  return useQuery({ queryKey: ['admin', 'roles'], queryFn: () => api.get<{ items: Role[] }>('/roles'), enabled, staleTime: 60_000 });
}

/** Shows a one-time password exactly once. Closing the dialog discards it from memory. */
export function OneTimePasswordDialog({ password, username, onClose }: { password: string | null; username: string; onClose: () => void }) {
  return (
    <Modal
      open={!!password}
      onClose={onClose}
      title={t('Temporary password')}
      size="sm"
      footer={<Button onClick={onClose}>{t('I have recorded it')}</Button>}
    >
      <div className="space-y-3 text-sm">
        <Alert tone="amber" title={t('Shown only once')}>
          {t('Hand this password to')}<strong>{username}</strong>{t('through a secure channel. It cannot be displayed again; the user must change it at first sign-in.')}
        </Alert>
        <div className="flex items-center gap-2 rounded-md border border-ink-200 bg-ink-50 px-3 py-2">
          <KeyRound className="h-4 w-4 text-ink-500" aria-hidden />
          <code className="mono flex-1 select-all break-all text-base" aria-label={t('Temporary password')}>{password}</code>
          {password && <CopyButton value={password} />}
        </div>
      </div>
    </Modal>
  );
}

/** datetime-local value (IST wall-clock) -> ISO string. */
export function localToIso(v: string): string | null {
  return v ? new Date(`${v}:00+05:30`).toISOString() : null;
}
