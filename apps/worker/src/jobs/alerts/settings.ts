import { DEFAULT_SETTINGS, type SettingKey, type SystemSettings } from '@ksp/shared';
import type { Database, Tx } from '@ksp/core';

/** Effective system settings (DB overrides merged over defaults) — worker-side, uncached. */
export async function loadSettings(db: Database | Tx): Promise<SystemSettings> {
  const rows = await db.selectFrom('system_settings').select(['key', 'value']).execute();
  const value = structuredClone(DEFAULT_SETTINGS) as SystemSettings;
  for (const r of rows) {
    const k = r.key as SettingKey;
    if (k in value) (value as unknown as Record<string, unknown>)[k] = { ...(value[k] as object), ...(r.value as object) };
  }
  return value;
}
