/**
 * System settings (DB table system_settings; keys/defaults in packages/shared/src/settings.ts).
 * Each key is replaced as a whole object, validated with a strict Zod schema with sane security bounds.
 * Changes invalidate the settings cache and all cached principals (MFA-mandatory roles, password expiry),
 * and are audited as SETTINGS_UPDATED with old and new values. DELETE restores the built-in default.
 *
 * NOTE (multi-instance): caches are per process; other API instances pick changes up within their TTL
 * (settings 15 s, principals 10 s). See docs/KNOWN-ISSUES.md.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { DEFAULT_SETTINGS, SETTING_KEYS, type SettingKey, type SystemSettings } from '@ksp/shared';
import { appendAudit } from '@ksp/core';
import { getSettings, invalidateSettings } from '../../lib/settings.js';
import { invalidatePrincipals } from '../../lib/load-principal.js';
import { notFound, validationFailed } from '../../lib/errors.js';

export const prefix = '/settings';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const int = (min: number, max: number) => z.number().int().min(min).max(max);
const emailList = z.array(z.string().trim().toLowerCase().email().max(254)).max(50).transform((v) => [...new Set(v)]);

export const SETTING_SCHEMAS = {
  passwordPolicy: z.object({
    minLength: int(10, 128),
    requireUpper: z.boolean(),
    requireLower: z.boolean(),
    requireDigit: z.boolean(),
    requireSymbol: z.boolean(),
    historyCount: int(0, 24),
    maxAgeDays: int(0, 365),
  }).strict(),
  lockoutPolicy: z.object({
    maxFailedAttempts: int(3, 20),
    lockoutMinutes: int(1, 1440),
    ipMaxFailedPerWindow: int(5, 1000),
    windowMinutes: int(1, 1440),
  }).strict(),
  sessionPolicy: z.object({
    idleTimeoutMinutes: int(5, 480),
    absoluteTimeoutHours: int(1, 72),
    maxConcurrentSessions: int(1, 20),
    requireMfaForRoles: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{1,40}$/)).max(100).transform((v) => [...new Set(v)]),
  }).strict().refine((v) => v.idleTimeoutMinutes <= v.absoluteTimeoutHours * 60, { message: 'Idle timeout cannot exceed the absolute session lifetime', path: ['idleTimeoutMinutes'] }),
  uploadPolicy: z.object({
    maxFileSizeBytes: int(10 * MiB, 1024 * GiB),
    chunkSizeBytes: int(5 * MiB, 128 * MiB),
    sessionTtlHours: int(1, 720),
    maxConcurrentSessionsPerUser: int(1, 200),
  }).strict().refine((v) => v.chunkSizeBytes <= v.maxFileSizeBytes, { message: 'Chunk size cannot exceed the maximum file size', path: ['chunkSizeBytes'] }),
  storagePolicy: z.object({
    warnThresholdPercent: int(1, 99),
    criticalThresholdPercent: int(2, 100),
    capacityBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  }).strict().refine((v) => v.criticalThresholdPercent > v.warnThresholdPercent, { message: 'Critical threshold must be above the warning threshold', path: ['criticalThresholdPercent'] }),
  shareExportPolicy: z.object({
    maxShareDays: int(1, 365),
    exportRetentionDays: int(1, 3650),
    excessiveDownloadsPerHour: int(1, 10_000),
  }).strict(),
  alertDeliveryPolicy: z.object({
    maxAttempts: int(1, 20),
    baseDelaySeconds: int(5, 3600),
    emailAlertManagers: z.boolean(),
    warningRecipients: emailList,
    criticalRecipients: emailList,
  }).strict(),
  integrityPolicy: z.object({
    fullCycleDays: int(1, 3650),
    maxBytesPerNight: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    minPerNight: int(1, 1_000_000),
    maxPerNight: int(1, 10_000_000),
  }).strict().refine((v) => v.maxPerNight >= v.minPerNight, { message: 'Maximum per night must be at least the minimum', path: ['maxPerNight'] }),
} satisfies { [K in SettingKey]: z.ZodType<SystemSettings[K], z.ZodTypeDef, unknown> };

const keyParam = z.object({ key: z.enum(SETTING_KEYS as [SettingKey, ...SettingKey[]]) });

export default async function settings(fastify: FastifyInstance) {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const db = app.db;

  async function effective() {
    const value = await getSettings(db);
    const rows = await db.selectFrom('system_settings as s').leftJoin('users as u', 'u.id', 's.updated_by')
      .select(['s.key', 's.updated_at', 'u.id as u_id', 'u.full_name as u_name']).execute();
    const meta = Object.fromEntries(rows.map((r) => [r.key, { updatedAt: r.updated_at, updatedBy: r.u_id ? { id: r.u_id, fullName: r.u_name } : null }]));
    return {
      settings: value,
      defaults: DEFAULT_SETTINGS,
      keys: SETTING_KEYS.map((key) => ({ key, overridden: key in meta, updatedAt: meta[key]?.updatedAt ?? null, updatedBy: meta[key]?.updatedBy ?? null })),
    };
  }

  app.get('/', { preHandler: app.authorize('settings:manage'), schema: { tags: ['settings'], summary: 'Effective system settings (defaults merged with overrides)' } }, async () => effective());

  app.put('/:key', {
    preHandler: app.authorize('settings:manage'),
    schema: { tags: ['settings'], summary: 'Replace one settings group (validated per key)', params: keyParam, body: z.record(z.unknown()) },
  }, async (req) => {
    const key = req.params.key;
    const parsed = SETTING_SCHEMAS[key].safeParse(req.body);
    if (!parsed.success) throw validationFailed(`Invalid ${key}`, parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    const value = parsed.data as Record<string, unknown>;
    if (key === 'sessionPolicy') {
      const codes = value.requireMfaForRoles as string[];
      if (codes.length) {
        const known = await db.selectFrom('roles').select('code').where('code', 'in', codes).execute();
        const unknown = codes.filter((c) => !known.some((k) => k.code === c));
        if (unknown.length) throw validationFailed(`Unknown role code(s): ${unknown.join(', ')}`, { unknown });
      }
    }
    const before = (await getSettings(db))[key];
    const p = req.requirePrincipal();
    await db.transaction().execute(async (tx) => {
      await tx.insertInto('system_settings').values({ key, value: JSON.stringify(value), updated_by: p.userId, updated_at: new Date() })
        .onConflict((oc) => oc.column('key').doUpdateSet({ value: JSON.stringify(value), updated_by: p.userId, updated_at: new Date() })).execute();
      await appendAudit(tx, req.actor(), { action: 'SETTINGS_UPDATED', resourceType: 'setting', resourceId: key, details: { key, old: before, new: value } });
    });
    invalidateSettings();
    invalidatePrincipals();
    return effective();
  });

  app.delete('/:key', { preHandler: app.authorize('settings:manage'), schema: { tags: ['settings'], summary: 'Restore one settings group to its built-in default', params: keyParam } }, async (req) => {
    const key = req.params.key;
    const before = (await getSettings(db))[key];
    const exists = await db.selectFrom('system_settings').select('key').where('key', '=', key).executeTakeFirst();
    if (!exists) throw notFound('Setting override');
    await db.transaction().execute(async (tx) => {
      await tx.deleteFrom('system_settings').where('key', '=', key).execute();
      await appendAudit(tx, req.actor(), { action: 'SETTINGS_UPDATED', resourceType: 'setting', resourceId: key, details: { key, old: before, new: DEFAULT_SETTINGS[key], reset: true } });
    });
    invalidateSettings();
    invalidatePrincipals();
    return effective();
  });
}
