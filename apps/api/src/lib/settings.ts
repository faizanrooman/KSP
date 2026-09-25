import { DEFAULT_SETTINGS, type SettingKey, type SystemSettings } from '@ksp/shared';
import type { Database } from '@ksp/core';

let cache: { at: number; value: SystemSettings } | undefined;
const TTL_MS = 15_000;

/** Effective settings: DB overrides merged over defaults. Cached briefly; invalidated on update. */
export async function getSettings(db: Database): Promise<SystemSettings> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const rows = await db.selectFrom('system_settings').select(['key', 'value']).execute();
  const value = structuredClone(DEFAULT_SETTINGS) as SystemSettings;
  for (const r of rows) {
    const k = r.key as SettingKey;
    if (k in value) (value as unknown as Record<string, unknown>)[k] = { ...(value[k] as object), ...(r.value as object) };
  }
  cache = { at: Date.now(), value };
  return value;
}

export function invalidateSettings(): void {
  cache = undefined;
}
