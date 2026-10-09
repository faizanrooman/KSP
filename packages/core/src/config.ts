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
  SIGNING_PRIVATE_KEY: z.string().min(1).optional(),
  SIGNING_CERTIFICATE: z.string().min(1).optional(),
  SIGNING_KEY_ID: z.string().default('ksp-dev-signing-key'),
  /** `pem` (key + certificate PEM above) or `pkcs11` (HSM / token, PKCS11_* below; docs/SECRETS.md#hsm). */
  SIGNING_PROVIDER: z.enum(['pem', 'pkcs11']).default('pem'),
  /** Absolute path of the vendor PKCS#11 module (.so), e.g. /usr/lib/softhsm/libsofthsm2.so. */
  PKCS11_MODULE: z.string().optional(),
  /** Token selection: slot index/id (PKCS11_SLOT) or token label (PKCS11_TOKEN_LABEL, preferred). */
  PKCS11_SLOT: z.coerce.number().int().min(0).optional(),
  PKCS11_TOKEN_LABEL: z.string().optional(),
  /** File holding the user PIN (mounted secret; never an inline value). */
  PKCS11_PIN_FILE: z.string().optional(),
  /** CKA_LABEL of the private key (and of the certificate object when it is read from the token). */
  PKCS11_KEY_LABEL: z.string().optional(),
  /** Optional CKA_ID (hex) of the key when labels are not unique. */
  PKCS11_KEY_ID: z.string().regex(/^[0-9a-fA-F]*$/).optional(),
  /** Certificate PEM (inline or file:) when it is not stored on the token. */
  PKCS11_CERTIFICATE: z.string().optional(),
  /** RSA keys: `pkcs1` (RSA-SHA256, default — matches the PEM signer and `openssl dgst -verify`) or `pss`. */
  PKCS11_RSA_SCHEME: z.enum(['pkcs1', 'pss']).default('pkcs1'),

  /**
   * Deployment tier (docs/GO-LIVE-CHECKLIST.md). With NODE_ENV=production the default is `production`: the startup
   * preflight (preflight.ts) refuses to start on any violation. `staging` allows the documented waivers
   * (non-evidentiary test signing key); `demo` (minikube/training clusters) may additionally set KSP_PREFLIGHT=warn.
   */
  KSP_ENVIRONMENT: z.enum(['production', 'staging', 'demo', 'development', 'test']).optional(),
  /** `enforce` (default) or `warn` (log violations and start anyway — refused when KSP_ENVIRONMENT=production). */
  KSP_PREFLIGHT: z.enum(['enforce', 'warn', 'off']).default('enforce'),
  /** Staging only: allow the dev/self-signed signing key; every export / custody PDF is stamped NON-EVIDENTIARY. */
  KSP_ALLOW_NONEVIDENTIARY_SIGNING: bool.default('false'),
  /** Accept OBJECT_LOCK_MODE=GOVERNANCE in production (custodian decision EXT-8; preflight warns). */
  OBJECT_LOCK_MODE_ACCEPT_GOVERNANCE: bool.default('false'),
  /** Accept a database connection without TLS (e.g. Unix socket / same-pod proxy). Preflight warns. */
  DATABASE_TLS_WAIVED: bool.default('false'),
  /** Expected number of API replicas (preflight: an in-memory rate-limit store is refused with more than one). */
  KSP_EXPECTED_API_REPLICAS: z.coerce.number().int().min(1).optional(),

  /**
   * AI tasks this deployment may run (comma-separated AiTask codes). Default: all tasks in development/test;
   * OBJECT_DETECTION,PERSON_DETECTION,CLASSIFICATION in production. FACE_DETECTION, FACE_RECOGNITION and ANPR
   * additionally need a recorded legal approval (system setting aiLegalApprovals) while legal gates are enforced.
   */
  AI_TASKS_ENABLED: z.string().optional(),
  /** `enforce` (default in production) / `off` (default elsewhere): require aiLegalApprovals for gated tasks. */
  AI_LEGAL_GATES: z.enum(['enforce', 'off']).optional(),

  /**
   * Media derivative profile (docs/VIDEO-PIPELINE.md#profiles, EXT-9):
   *   full           proxy MP4 + HLS ladder + stills + sprites at ingest (default)
   *   proxy-only     proxy MP4 + stills + sprites; the player streams the MP4 with HTTP Range
   *   on-demand-hls  like proxy-only at ingest; the HLS ladder is built the first time someone plays the item
   */
  MEDIA_PROFILE: z.enum(['full', 'proxy-only', 'on-demand-hls']).default('full'),
  /** Preferred H.264 encoder; falls back to libx264 when FFmpeg lacks it or the device cannot open. */
  MEDIA_ENCODER: z.enum(['libx264', 'h264_nvenc', 'h264_qsv', 'h264_vaapi']).default('libx264'),
  /** DRM render node for h264_vaapi / h264_qsv. */
  MEDIA_HW_DEVICE: z.string().default('/dev/dri/renderD128'),

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
  // `VAR=` (empty) from compose/k8s templates means "not set": otherwise optional enums reject the empty string.
  const source = env.KSP_SERVICE === 'ksp-ai-worker' ? aiWorkerEnv(env) : env;
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== '')) as NodeJS.ProcessEnv;
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const cfg = parsed.data;
  cfg.JWT_PRIVATE_KEY = resolvePem(cfg.JWT_PRIVATE_KEY);
  cfg.JWT_PUBLIC_KEY = resolvePem(cfg.JWT_PUBLIC_KEY);
  for (const k of ['SIGNING_PRIVATE_KEY', 'SIGNING_CERTIFICATE', 'PKCS11_CERTIFICATE'] as const) {
    const v = cfg[k];
    // The isolated AI worker never signs: its inert placeholders are not file references.
    if (v !== undefined && v !== 'not-available-in-ai-worker') cfg[k] = resolvePem(v);
  }
  if (cfg.SIGNING_PROVIDER === 'pem' && (!cfg.SIGNING_PRIVATE_KEY || !cfg.SIGNING_CERTIFICATE)) {
    throw new Error('Invalid configuration: SIGNING_PRIVATE_KEY and SIGNING_CERTIFICATE are required when SIGNING_PROVIDER=pem');
  }
  if (cfg.SIGNING_PROVIDER === 'pkcs11' && env.KSP_SERVICE !== 'ksp-ai-worker' && (!cfg.PKCS11_MODULE || !cfg.PKCS11_KEY_LABEL || (cfg.PKCS11_SLOT === undefined && !cfg.PKCS11_TOKEN_LABEL))) {
    throw new Error('Invalid configuration: SIGNING_PROVIDER=pkcs11 needs PKCS11_MODULE, PKCS11_KEY_LABEL and PKCS11_TOKEN_LABEL or PKCS11_SLOT');
  }
  cfg.KSP_ENVIRONMENT ??= cfg.NODE_ENV === 'production' ? 'production' : cfg.NODE_ENV;
  cfg.AI_LEGAL_GATES ??= cfg.NODE_ENV === 'production' ? 'enforce' : 'off';
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
