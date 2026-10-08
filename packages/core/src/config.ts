import { z } from 'zod';
import { config as loadDotenv } from 'dotenv';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

/** Locate the repository root (directory containing db/migrations) from cwd upwards. */
export function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(resolve(dir, 'db/migrations'))) return dir;
    dir = resolve(dir, '..');
  }
  return process.cwd();
}

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  APP_BASE_URL: z.string().url().default('http://localhost:5173'),
  API_PORT: z.coerce.number().int().default(4000),
  API_HOST: z.string().default('127.0.0.1'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  COOKIE_SECURE: bool.default('false'),
  TRUST_PROXY: bool.default('false'),
  /** Rate-limit counter store: `postgres` shares counts across API replicas (default in production), `memory` is per process (default elsewhere). */
  RATE_LIMIT_STORE: z.enum(['memory', 'postgres']).optional(),
  /**
   * Tender §50: access from authorised internal networks only. Comma-separated CIDRs (IPv4/IPv6) allowed to reach the
   * staff application and API. Empty = no network restriction (perimeter firewall only). Requests from other networks get
   * 403 NETWORK_NOT_ALLOWED and an audit event. Paths in ALLOWED_NETWORKS_EXEMPT_PREFIXES stay reachable from anywhere
   * (default: the external share portal and health probes).
   */
  ALLOWED_NETWORKS: z.string().default(''),
  ALLOWED_NETWORKS_EXEMPT_PREFIXES: z.string().default('/api/v1/share-portal,/api/v1/media/stream,/api/v1/media/download,/health'),

  DATABASE_URL: z.string().min(1), // ksp_app
  DATABASE_MIGRATION_URL: z.string().optional(), // schema owner, used by migrate only
  DATABASE_AI_URL: z.string().optional(), // ksp_ai, used by ai-worker only
  DATABASE_POOL_MAX: z.coerce.number().int().default(20),

  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  /** Separate, derived-bucket-only credentials for the isolated AI worker (falls back to main creds in dev). */
  S3_AI_ACCESS_KEY: z.string().optional(),
  S3_AI_SECRET_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool.default('true'),
  S3_BUCKET_STAGING: z.string().default('ksp-staging'),
  S3_BUCKET_EVIDENCE: z.string().default('ksp-evidence'),
  S3_BUCKET_ARCHIVE: z.string().default('ksp-evidence-archive'),
  S3_BUCKET_LONG_TERM: z.string().default('ksp-evidence-longterm'),
  S3_BUCKET_DERIVED: z.string().default('ksp-derived'),
  S3_BUCKET_EXPORTS: z.string().default('ksp-exports'),
  S3_BUCKET_REPORTS: z.string().default('ksp-reports'),
  /** S3 Object Lock for originals. NONE only permitted outside production. */
  OBJECT_LOCK_MODE: z.enum(['GOVERNANCE', 'COMPLIANCE', 'NONE']).default('GOVERNANCE'),
  OBJECT_LOCK_DAYS: z.coerce.number().int().positive().default(3650),

  /** Ed25519 PEM keys for access-token JWTs. */
  JWT_PRIVATE_KEY: z.string().min(1),
  JWT_PUBLIC_KEY: z.string().min(1),
  JWT_ISSUER: z.string().default('ksp-vms'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().default(900),
  REFRESH_TOKEN_TTL_HOURS: z.coerce.number().int().default(12),
  /** 32-byte base64 key: AES-256-GCM for secrets at rest in the DB (MFA secrets). */
  DATA_ENCRYPTION_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes base64').optional(),
  /**
   * Versioned keyring (OPS-10): comma-separated `id:base64` entries, the FIRST is the current (encrypting) key;
   * the others only decrypt. When set, DATA_ENCRYPTION_KEY (if also set) is kept as a decrypt-only key with id
   * `default`. Rotate with `npm run keys:rotate-data -w @ksp/core`.
   */
  DATA_ENCRYPTION_KEYS: z.string().optional().refine((v) => v === undefined || v.trim() === '' || v.split(',').every((e) => {
    const m = /^([A-Za-z0-9_-]{1,32}):(.+)$/.exec(e.trim());
    return !!m && Buffer.from(m[2]!, 'base64').length === 32;
  }), 'must be a comma-separated list of <id>:<32-byte base64> entries'),
  /** HMAC secret for short-lived media/playback tokens. */
  MEDIA_TOKEN_SECRET: z.string().min(32),
  MEDIA_TOKEN_TTL_SECONDS: z.coerce.number().int().default(300),
  /** Evidence/ledger signing key (PEM) and certificate (PEM) used for export manifests & audit checkpoints. */
  SIGNING_PRIVATE_KEY: z.string().min(1),
  SIGNING_CERTIFICATE: z.string().min(1),
  SIGNING_KEY_ID: z.string().default('ksp-dev-signing-key'),

  FFMPEG_PATH: z.string().default('ffmpeg'),
  FFPROBE_PATH: z.string().default('ffprobe'),
  WORK_DIR: z.string().default('/tmp/ksp-work'),
  AI_MODELS_DIR: z.string().default('./models'),
  WORKER_CONCURRENCY: z.coerce.number().int().default(2),
  METRICS_PORT: z.coerce.number().int().default(9464),
  /** Bind address of the internal Prometheus endpoint (0.0.0.0 inside containers; never exposed via ingress). */
  METRICS_HOST: z.string().default('127.0.0.1'),
});

export type AppConfig = z.infer<typeof schema>;

let cached: AppConfig | undefined;

/** PEM values may be supplied inline (\n-escaped) or as file:/path references. */
function resolvePem(v: string): string {
  if (v.startsWith('file:')) return readFileSync(v.slice(5), 'utf8');
  return v.replace(/\\n/g, '\n');
}

/**
 * OPS-9: the isolated AI worker (KSP_SERVICE=ksp-ai-worker) never signs/verifies JWTs, media tokens or evidence
 * signatures, so it is deployed WITHOUT those secrets (no key-shaped placeholders in its ConfigMap). Missing values
 * are replaced by inert per-process values that cannot validate anything issued by the API.
 */
export const AI_WORKER_UNUSED_SECRETS = ['JWT_PRIVATE_KEY', 'JWT_PUBLIC_KEY', 'SIGNING_PRIVATE_KEY', 'SIGNING_CERTIFICATE', 'MEDIA_TOKEN_SECRET'] as const;
function aiWorkerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of AI_WORKER_UNUSED_SECRETS) {
    if (!out[k]) out[k] = k === 'MEDIA_TOKEN_SECRET' ? randomBytes(32).toString('hex') : 'not-available-in-ai-worker';
  }
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (cached && env === process.env) return cached;
  if (env === process.env) {
    const root = repoRoot();
    const file = env.KSP_ENV_FILE ?? resolve(root, env.NODE_ENV === 'test' ? '.env.test' : '.env');
    if (existsSync(file)) loadDotenv({ path: file, quiet: true } as never);
  }
  const parsed = schema.safeParse(env.KSP_SERVICE === 'ksp-ai-worker' ? aiWorkerEnv(env) : env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const cfg = parsed.data;
  for (const k of ['JWT_PRIVATE_KEY', 'JWT_PUBLIC_KEY', 'SIGNING_PRIVATE_KEY', 'SIGNING_CERTIFICATE'] as const) {
    cfg[k] = resolvePem(cfg[k]);
  }
  if (cfg.NODE_ENV === 'production') {
    if (cfg.OBJECT_LOCK_MODE === 'NONE') throw new Error('OBJECT_LOCK_MODE=NONE is not permitted in production');
    if (!cfg.COOKIE_SECURE) throw new Error('COOKIE_SECURE must be true in production');
  }
  if (env === process.env) cached = cfg;
  return cfg;
}

/** For tests: forget cached config. */
export function resetConfigCache(): void {
  cached = undefined;
}
