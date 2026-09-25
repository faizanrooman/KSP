/**
 * E2E environment: reads the checkout's root .env (written by scripts/dev/agent-env.sh) so the suite
 * talks to THIS checkout's API/web ports, database and buckets.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const ROOT = resolve(__dirname, '../../..');
export const E2E_DIR = resolve(__dirname, '..');
export const STATE_DIR = resolve(E2E_DIR, '.state');
export const MEDIA_DIR = resolve(E2E_DIR, '.media');
export const ARTIFACT_DIR = resolve(E2E_DIR, 'artifacts');

function parseEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!.replace(/^"(.*)"$/, '$1');
  }
  return out;
}

export const ENV: Record<string, string> = {
  ...parseEnv(resolve(ROOT, process.env.KSP_ENV_FILE ?? '.env')),
  ...(Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('E2E_'))) as Record<string, string>),
};

/** The web UI (Vite dev server proxies /api to the API). */
export const BASE_URL = process.env.E2E_BASE_URL ?? ENV.APP_BASE_URL ?? 'http://localhost:5173';
export const API_URL = process.env.E2E_API_URL ?? `http://127.0.0.1:${ENV.API_PORT ?? 4000}`;
export const DEV_PASSWORD = 'Ksp@Dev-Passw0rd!';

const esc = (s: string) => s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');

/** Strings that must never reach a browser: presigned-URL markers, our bucket names and the S3 endpoint. */
export const STORAGE_LEAK_PATTERNS: RegExp[] = [
  /X-Amz-/i,
  /AWSAccessKeyId/,
  ...Object.entries(ENV)
    .filter(([k, v]) => k.startsWith('S3_BUCKET_') && v)
    .map(([, v]) => new RegExp(`(^|[^A-Za-z0-9-])${esc(v)}($|[^A-Za-z0-9-])`)),
  ...(ENV.S3_ENDPOINT ? [new RegExp(esc(ENV.S3_ENDPOINT.replace(/^https?:\/\//, '')))] : []),
];

export const FFMPEG = ENV.FFMPEG_PATH || 'ffmpeg';
export const MIGRATION_DB_URL = ENV.DATABASE_MIGRATION_URL ?? '';
