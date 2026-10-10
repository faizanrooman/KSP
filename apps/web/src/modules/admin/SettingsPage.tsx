import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SettingKey, SystemSettings } from '@ksp/shared';
import { api, ApiError, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { Alert, Badge, Button, Card, Checkbox, ConfirmDialog, ErrorState, Field, Input, PageHeader, Spinner, useToast } from '@/components/ui';
import { useRoles } from './shared';
import { LegalApprovalsCard, type DeploymentInfo } from './LegalApprovals';

import { t } from '@/lib/i18n';
interface SettingsResponse {
  settings: SystemSettings;
  defaults: SystemSettings;
  keys: Array<{ key: SettingKey; overridden: boolean; updatedAt: string | null; updatedBy: { id: string; fullName: string } | null }>;
  deployment?: DeploymentInfo;
}

type FieldDef = { name: string; label: string; kind: 'int' | 'bool' | 'bytes' | 'roles' | 'list'; min?: number; max?: number; hint?: string };
const MiB = 1024 ** 2;
const GROUPS: Array<{ key: SettingKey; title: string; description: string; fields: FieldDef[] }> = [
  {
    key: 'passwordPolicy', title: 'Password policy', description: 'Applies to new passwords (changes and resets).',
    fields: [
      { name: 'minLength', label: 'Minimum length', kind: 'int', min: 10, max: 128 },
      { name: 'requireUpper', label: 'Require an upper-case letter', kind: 'bool' },
      { name: 'requireLower', label: 'Require a lower-case letter', kind: 'bool' },
      { name: 'requireDigit', label: 'Require a digit', kind: 'bool' },
      { name: 'requireSymbol', label: 'Require a symbol', kind: 'bool' },
      { name: 'historyCount', label: 'Reject reuse of last N passwords', kind: 'int', min: 0, max: 24 },
      { name: 'maxAgeDays', label: 'Maximum password age (days)', kind: 'int', min: 0, max: 365, hint: '0 = never expires' },
    ],
  },
  {
    key: 'lockoutPolicy', title: 'Account lockout', description: 'Brute-force protection for sign-in.',
    fields: [
      { name: 'maxFailedAttempts', label: 'Failed attempts before lockout', kind: 'int', min: 3, max: 20 },
      { name: 'lockoutMinutes', label: 'Lockout duration (minutes)', kind: 'int', min: 1, max: 1440 },
      { name: 'ipMaxFailedPerWindow', label: 'Failed attempts per IP per window', kind: 'int', min: 5, max: 1000 },
      { name: 'windowMinutes', label: 'IP window (minutes)', kind: 'int', min: 1, max: 1440 },
    ],
  },
  {
    key: 'sessionPolicy', title: 'Sessions & MFA', description: 'Session lifetime and two-step sign-in. Users holding a role ticked below must enrol MFA and are asked for the code at every sign-in; other users are asked only if they turned two-step sign-in on themselves in My profile.',
    fields: [
      { name: 'idleTimeoutMinutes', label: 'Idle timeout (minutes)', kind: 'int', min: 5, max: 480 },
      { name: 'absoluteTimeoutHours', label: 'Absolute session lifetime (hours)', kind: 'int', min: 1, max: 72 },
      { name: 'maxConcurrentSessions', label: 'Maximum concurrent sessions per user', kind: 'int', min: 1, max: 20 },
      { name: 'requireMfaForRoles', label: 'MFA mandatory for roles', kind: 'roles' },
      { name: 'mfaForPrivilegedPermissions', label: 'Also require MFA for every role holding administrative, approval or audit rights (always on in production)', kind: 'bool' },
    ],
  },
  {
    key: 'uploadPolicy', title: 'Uploads', description: 'Resumable chunked upload limits.',
    fields: [
      { name: 'maxFileSizeBytes', label: 'Maximum file size (MiB)', kind: 'bytes', min: 10, max: 1024 * 1024 },
      { name: 'chunkSizeBytes', label: 'Chunk size (MiB)', kind: 'bytes', min: 5, max: 128 },
      { name: 'sessionTtlHours', label: 'Upload session lifetime (hours)', kind: 'int', min: 1, max: 720 },
      { name: 'maxConcurrentSessionsPerUser', label: 'Concurrent upload sessions per user', kind: 'int', min: 1, max: 200 },
    ],
  },
  {
    key: 'storagePolicy', title: 'Storage alerts', description: 'Utilisation thresholds for dashboards and alerts.',
    fields: [
      { name: 'warnThresholdPercent', label: 'Warning threshold (%)', kind: 'int', min: 1, max: 99 },
      { name: 'criticalThresholdPercent', label: 'Critical threshold (%)', kind: 'int', min: 2, max: 100 },
      { name: 'capacityBytes', label: 'Declared capacity (MiB)', kind: 'bytes', min: 0, hint: '0 = unknown' },
    ],
  },
  {
    key: 'shareExportPolicy', title: 'Sharing & export', description: 'Limits for shares and court exports.',
    fields: [
      { name: 'maxShareDays', label: 'Maximum share validity (days)', kind: 'int', min: 1, max: 365 },
      { name: 'exportRetentionDays', label: 'Keep generated exports (days)', kind: 'int', min: 1, max: 3650 },
      { name: 'excessiveDownloadsPerHour', label: 'Excessive downloads alert (per hour)', kind: 'int', min: 1, max: 10000 },
    ],
  },
  {
    key: 'alertDeliveryPolicy', title: 'Alert delivery', description: 'E-mail recipients and retries for external alert deliveries (e-mail, webhook).',
    fields: [
      { name: 'maxAttempts', label: 'Delivery attempts', kind: 'int', min: 1, max: 20, hint: '1 = no retry' },
      { name: 'baseDelaySeconds', label: 'First retry after (seconds)', kind: 'int', min: 5, max: 3600, hint: 'doubles for every further attempt' },
      { name: 'emailAlertManagers', label: 'E-mail alert managers in scope', kind: 'bool' },
      { name: 'warningRecipients', label: 'Extra recipients: warning and critical', kind: 'list', hint: 'comma-separated e-mail addresses' },
      { name: 'criticalRecipients', label: 'Extra recipients: critical only', kind: 'list', hint: 'comma-separated e-mail addresses' },
    ],
  },
  {
    key: 'auditPolicy', title: 'Audit log retention', description: 'Audit records are append-only and the application never deletes them (enforced by the database). Any archival outside the system must keep them retrievable for at least this period.',
    fields: [
      { name: 'minimumRetentionYears', label: 'Minimum retention (years)', kind: 'int', min: 7, max: 100 },
    ],
  },
  {
    key: 'integrityPolicy', title: 'Integrity (fixity) sweep', description: 'Every stored original and recorded secondary copy is re-hashed once per cycle.',
    fields: [
      { name: 'fullCycleDays', label: 'Full verification cycle (days)', kind: 'int', min: 1, max: 3650 },
      { name: 'maxBytesPerNight', label: 'Byte budget per night (MiB)', kind: 'bytes', min: 0, hint: '0 = unlimited' },
      { name: 'minPerNight', label: 'Minimum items per night', kind: 'int', min: 1, max: 1000000 },
      { name: 'maxPerNight', label: 'Maximum items per night', kind: 'int', min: 1, max: 10000000 },
    ],
  },
];

/** Comma/space separated list editor that keeps the raw text while typing. */
function ListInput({ id, value, onChange }: { id: string; value: string[]; onChange: (v: string[]) => void }) {
  const [text, setText] = useState(value.join(', '));
  useEffect(() => { if (text.split(/[\s,;]+/).filter(Boolean).join(',') !== value.join(',')) setText(value.join(', ')); }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return <Input id={id} value={text} onChange={(e) => { setText(e.target.value); onChange(e.target.value.split(/[\s,;]+/).filter(Boolean)); }} />;
}

function GroupForm({ group, data }: { group: (typeof GROUPS)[number]; data: SettingsResponse }) {
  const initial = data.settings[group.key] as unknown as Record<string, unknown>;
  const [v, setV] = useState<Record<string, unknown>>(initial);
  const [confirmReset, setConfirmReset] = useState(false);
  // Re-sync only when THIS group's saved values change: saving another group replaces the whole settings object, and
  // depending on the object identity wiped this group's unsaved edits (UI-B-07).
  const initialJson = JSON.stringify(initial);
  useEffect(() => setV(JSON.parse(initialJson) as Record<string, unknown>), [initialJson]);
  const roles = useRoles(group.key === 'sessionPolicy');
  const qc = useQueryClient();
  const toast = useToast();
  const meta = data.keys.find((k) => k.key === group.key);
  const save = useMutation({
    mutationFn: () => api.put<SettingsResponse>(`/settings/${group.key}`, v),
    onSuccess: (r) => { qc.setQueryData(['admin', 'settings'], r); toast.success(`${group.title} saved`); },
  });
  const reset = useMutation({
    mutationFn: () => api.delete<SettingsResponse>(`/settings/${group.key}`),
    onSuccess: (r) => { qc.setQueryData(['admin', 'settings'], r); setConfirmReset(false); toast.success(`${group.title} restored to defaults`); },
  });
  const dirty = JSON.stringify(v) !== initialJson;
  const details = save.error instanceof ApiError && Array.isArray(save.error.details) ? (save.error.details as Array<{ path?: string; message: string }>) : [];
  return (
    <Card
      title={<div><h2>{group.title} {meta?.overridden ? <Badge tone="blue">{t('Customised')}</Badge> : <Badge>{t('Default')}</Badge>}</h2><p className="text-xs font-normal text-ink-500">{group.description}{meta?.updatedAt ? ' ' + (meta.updatedBy ? t('Last changed {updatedAt} by {fullName}.', { updatedAt: formatDateTime(meta.updatedAt), fullName: meta.updatedBy.fullName }) : t('Last changed {updatedAt}.', { updatedAt: formatDateTime(meta.updatedAt) })) : ''}</p></div>}
      actions={meta?.overridden ? <Button size="sm" variant="ghost" onClick={() => { reset.reset(); setConfirmReset(true); }}>{t('Restore defaults')}</Button> : undefined}
    >
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <div className="grid gap-3 sm:grid-cols-2">
          {group.fields.filter((fd) => fd.kind !== 'bool').map((fd) => {
            const id = `set-${group.key}-${fd.name}`;
            const val = v[fd.name];
            if (fd.kind === 'roles') {
              const sel = new Set((val as string[]) ?? []);
              return (
                <fieldset key={fd.name} className="sm:col-span-2">
                  <legend className="label">{fd.label}</legend>
                  {roles.isLoading ? <Spinner /> : (
                    <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
                      {roles.data?.items.map((r) => (
                        <Checkbox key={r.code} label={r.name} description={r.code} checked={sel.has(r.code)} onChange={(c) => { const n = new Set(sel); if (c) n.add(r.code); else n.delete(r.code); setV({ ...v, [fd.name]: [...n] }); }} />
                      ))}
                    </div>
                  )}
                </fieldset>
              );
            }
            if (fd.kind === 'list') {
              return (
                <Field key={fd.name} label={fd.label} htmlFor={id} hint={fd.hint}>
                  <ListInput id={id} value={(val as string[]) ?? []} onChange={(list) => setV({ ...v, [fd.name]: list })} />
                </Field>
              );
            }
            const shown = fd.kind === 'bytes' ? Math.round(Number(val) / MiB) : Number(val);
            return (
              <Field key={fd.name} label={fd.label} htmlFor={id} hint={[fd.hint, fd.min !== undefined && fd.max !== undefined ? `${fd.min}–${fd.max.toLocaleString('en-IN')}` : undefined].filter(Boolean).join(' · ')}>
                <Input id={id} type="number" inputMode="numeric" min={fd.min} max={fd.max} value={Number.isFinite(shown) ? shown : ''} onChange={(e) => { const n = e.target.value === '' ? NaN : Number(e.target.value); setV({ ...v, [fd.name]: fd.kind === 'bytes' ? Math.round(n * MiB) : n }); }} />
              </Field>
            );
          })}
          {/* Switches are grouped in their own row: interleaved with inputs they left ragged gaps in the grid (UI-B-06). */}
          {group.fields.some((fd) => fd.kind === 'bool') && (
            <div className="grid gap-2 sm:col-span-2 sm:grid-cols-2 lg:grid-cols-4">
              {group.fields.filter((fd) => fd.kind === 'bool').map((fd) => <Checkbox key={fd.name} label={fd.label} checked={!!v[fd.name]} onChange={(c) => setV({ ...v, [fd.name]: c })} />)}
            </div>
          )}
        </div>
        {save.error ? (
          <Alert tone="red" title={t('Not saved')}>
            {errorMessage(save.error)}
            {details.length > 0 && <ul className="mt-1 list-disc pl-5">{details.map((d, i) => <li key={i}>{d.path ? `${d.path}: ` : ''}{d.message}</li>)}</ul>}
          </Alert>
        ) : null}
        <div className="flex justify-end gap-2">
          {dirty && <Button variant="secondary" onClick={() => { setV(initial); save.reset(); }}>{t('Discard')}</Button>}
          <Button type="submit" disabled={!dirty} loading={save.isPending}>{t('Save')}</Button>
        </div>
      </form>
      <ConfirmDialog open={confirmReset} title={t('Restore {title}', { title: group.title })} message={t('Replace the customised values with the built-in defaults? The change is audited.')} confirmLabel={t('Restore defaults')} loading={reset.isPending} error={reset.error} onConfirm={() => reset.mutate()} onCancel={() => setConfirmReset(false)} />
    </Card>
  );
}

export function SettingsPage() {
  const q = useQuery({ queryKey: ['admin', 'settings'], queryFn: () => api.get<SettingsResponse>('/settings') });
  const qc = useQueryClient();
  return (
    <div className="space-y-4">
      <PageHeader title={t('System settings')} subtitle={t('Security and operational policies. Every change is recorded in the audit trail with old and new values.')} />
      {q.isLoading ? <Spinner /> : q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (
        <>
          <LegalApprovalsCard settings={q.data!.settings} deployment={q.data!.deployment} onSaved={(r) => qc.setQueryData(['admin', 'settings'], r)} />
          {GROUPS.map((g) => <GroupForm key={g.key} group={g} data={q.data!} />)}
        </>
      )}
    </div>
  );
}
