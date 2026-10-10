/**
 * Production preflight (docs/GO-LIVE-CHECKLIST.md). Run by api / worker / ai-worker at startup and by
 * `npm run preflight`. With NODE_ENV=production the process REFUSES TO START while any `error` finding exists and
 * prints every violation with its remedy. Findings of severity `warning` are decisions a human must take (or has
 * recorded a waiver for); they are logged but never block. NODE_ENV=development/test skip the startup check.
 *
 * Waivers are explicit, named environment variables and every waiver produces a warning:
 *   KSP_ALLOW_NONEVIDENTIARY_SIGNING=true   test signing key (KSP_ENVIRONMENT=staging|demo only; PDFs stamped)
 *   OBJECT_LOCK_MODE_ACCEPT_GOVERNANCE=true GOVERNANCE object lock accepted by the custodian (EXT-8)
 *   DATABASE_TLS_WAIVED=true                database link without TLS (Unix socket / same-pod proxy)
 *   KSP_PREFLIGHT=warn                      log instead of refusing (KSP_ENVIRONMENT=staging|demo only)
 */
import { X509Certificate } from 'node:crypto';
import { sql } from 'kysely';
import { AI_TASKS, DEFAULT_SETTINGS, type AiTask } from '@ksp/shared';
import type { AppConfig } from './config.js';
import type { Database } from './db/index.js';
import { createSigner, testCertificateReasons, type Signer } from './signing.js';
import { verifySecret } from './crypto.js';
import { aiLegalGatesEnforced, enabledAiTasks, LEGALLY_GATED_AI_TASKS } from './ai-gates.js';

export type PreflightService = 'api' | 'worker' | 'ai-worker' | 'all';
export type PreflightSeverity = 'error' | 'warning';

export interface PreflightFinding {
  rule: string;
  severity: PreflightSeverity;
  message: string;
  remedy?: string;
}

export interface PreflightResult {
  service: PreflightService;
  environment: string;
  enforced: boolean;
  findings: PreflightFinding[];
  errors: PreflightFinding[];
  warnings: PreflightFinding[];
}

/** Usernames + password the development seed creates (packages/core/src/dev/seed.ts). Kept here so the preflight does not import the seed. */
export const DEV_SEED_USERNAMES = ['admin', 'fo.ravi', 'op.cubbon', 'io.meera', 'io.arjun', 'sup.kavya', 'fa.naveen', 'ec.latha', 'aud.suresh', 'io.mysuru'] as const;
export const DEV_SEED_ORG_CODES = ['blr_city', 'blr_central', 'ps_cubbonpark', 'ps_highgrounds', 'blr_east', 'ps_indiranagar', 'southern_range', 'mysuru_dist', 'ps_nazarbad'] as const;
export const DEV_SEED_PASSWORD = 'Ksp@Dev-Passw0rd!';

/** Literal values shipped in scripts/dev, scripts/ci, compose examples and docs. */
const KNOWN_DEV_VALUES = ['kspdevaccess', 'kspdevsecret-change-me', 'kspdevsecret', 'minioadmin', 'changeme', 'change-me', 'password', 'secret', 'ksp', 'test'];
const WEAK_PATTERNS = [/change[-_ ]?me/i, /^dev/i, /kspdev/i, /example/i, /^(test|secret|password|admin)\d*$/i, /placeholder/i, /not-available/i];

/** Reason a secret value looks like a development / default / weak value, or null. */
export function weakSecretReason(value: string | undefined, minLength: number): string | null {
  if (value === undefined || value === '') return 'not set';
  const v = value.trim();
  if (KNOWN_DEV_VALUES.includes(v.toLowerCase())) return 'is a known development/default value';
  for (const p of WEAK_PATTERNS) if (p.test(v)) return `matches the development/default pattern ${p}`;
  if (v.length < minLength) return `is shorter than ${minLength} characters`;
  if (new Set(v).size < Math.min(10, Math.ceil(minLength / 2))) return 'has too few distinct characters';
  return null;
}

function urlPassword(url: string | undefined): { user: string; password: string; params: URLSearchParams; host: string } | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return { user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), params: u.searchParams, host: u.hostname };
  } catch {
    return null;
  }
}

const isLocalHost = (h: string) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(h);

/** Checks on configuration only (no network). */
export function staticPreflight(cfg: AppConfig, service: PreflightService, env: NodeJS.ProcessEnv = process.env, signer?: Signer | Error): PreflightFinding[] {
  const out: PreflightFinding[] = [];
  const err = (rule: string, message: string, remedy?: string) => out.push({ rule, severity: 'error', message, remedy });
  const warn = (rule: string, message: string, remedy?: string) => out.push({ rule, severity: 'warning', message, remedy });
  const tier = cfg.KSP_ENVIRONMENT ?? (cfg.NODE_ENV === 'production' ? 'production' : cfg.NODE_ENV);
  const isProdTier = tier === 'production';
  const app = service !== 'ai-worker';
  const signs = service === 'api' || service === 'worker' || service === 'all';

  if (cfg.NODE_ENV !== 'production') err('NODE_ENV', `NODE_ENV is '${cfg.NODE_ENV}'`, 'set NODE_ENV=production');
  if (cfg.KSP_PREFLIGHT !== 'enforce') {
    if (isProdTier) err('PREFLIGHT_MODE', `KSP_PREFLIGHT=${cfg.KSP_PREFLIGHT} is not permitted when KSP_ENVIRONMENT=production`, 'remove KSP_PREFLIGHT');
    else warn('PREFLIGHT_MODE', `KSP_PREFLIGHT=${cfg.KSP_PREFLIGHT}: violations are logged but do not stop the service (KSP_ENVIRONMENT=${tier})`);
  }
  if (!isProdTier) warn('ENVIRONMENT_TIER', `KSP_ENVIRONMENT=${tier}: this deployment is not a production tier`);

  // --- signing -------------------------------------------------------------------------------------------------
  if (signs) {
    if (signer instanceof Error) err('SIGNING_KEY', `signing key cannot be loaded: ${signer.message}`, 'fix SIGNING_* / PKCS11_* (docs/SECRETS.md#hsm)');
    else if (signer) {
      const reasons = testCertificateReasons(signer.certificatePem, signer.keyId);
      if (reasons.length) {
        if (cfg.KSP_ALLOW_NONEVIDENTIARY_SIGNING && !isProdTier) {
          warn('SIGNING_TEST_KEY', `test signing key accepted by KSP_ALLOW_NONEVIDENTIARY_SIGNING (${reasons.join('; ')}); every export / custody PDF is stamped "NON-EVIDENTIARY – TEST KEY"`);
        } else {
          err('SIGNING_TEST_KEY', `the evidence signing key is a development/test key: ${reasons.join('; ')}`, 'install the HSM/DSC key and CA-issued certificate (SIGNING_PROVIDER=pkcs11, docs/SECRETS.md#hsm); staging only: KSP_ALLOW_NONEVIDENTIARY_SIGNING=true with KSP_ENVIRONMENT=staging');
        }
      }
      try {
        const c = new X509Certificate(signer.certificatePem);
        const left = (new Date(c.validTo).getTime() - Date.now()) / 86_400_000;
        if (left < 0) err('SIGNING_CERT_EXPIRY', `signing certificate expired on ${c.validTo}`, 'renew the certificate');
        else if (left < 30) warn('SIGNING_CERT_EXPIRY', `signing certificate expires in ${Math.floor(left)} days (${c.validTo})`, 'renew and rotate SIGNING_KEY_ID');
        const pk = c.publicKey;
        if (pk.asymmetricKeyType === 'rsa' && (pk.asymmetricKeyDetails?.modulusLength ?? 0) < 3072) warn('SIGNING_KEY_STRENGTH', `RSA signing key is ${pk.asymmetricKeyDetails?.modulusLength} bits (3072+ recommended)`);
      } catch {
        err('SIGNING_KEY', 'signing certificate cannot be parsed');
      }
      if (signer.provider === 'pem') warn('SIGNING_PROVIDER', 'signing key is a PEM file on disk (SIGNING_PROVIDER=pem), not in an HSM', 'SIGNING_PROVIDER=pkcs11 (docs/SECRETS.md#hsm)');
    }
    if (cfg.KSP_ALLOW_NONEVIDENTIARY_SIGNING && isProdTier) err('SIGNING_TEST_KEY_WAIVER', 'KSP_ALLOW_NONEVIDENTIARY_SIGNING=true is not permitted when KSP_ENVIRONMENT=production', 'remove it (staging only)');
  }

  // --- storage -------------------------------------------------------------------------------------------------
  if (app) {
    if (cfg.OBJECT_LOCK_MODE !== 'COMPLIANCE') {
      if (cfg.OBJECT_LOCK_MODE === 'GOVERNANCE' && cfg.OBJECT_LOCK_MODE_ACCEPT_GOVERNANCE) warn('OBJECT_LOCK_MODE', 'OBJECT_LOCK_MODE=GOVERNANCE accepted by OBJECT_LOCK_MODE_ACCEPT_GOVERNANCE: privileged storage credentials can shorten retention', 'record the custodian decision (EXT-8)');
      else err('OBJECT_LOCK_MODE', `OBJECT_LOCK_MODE=${cfg.OBJECT_LOCK_MODE}; originals must be locked in COMPLIANCE mode`, 'OBJECT_LOCK_MODE=COMPLIANCE (or, by custodian decision, OBJECT_LOCK_MODE_ACCEPT_GOVERNANCE=true)');
    }
    const s3 = weakSecretReason(cfg.S3_SECRET_KEY, 20);
    if (s3) err('DEV_SECRET_S3', `S3_SECRET_KEY ${s3}`, 'use the production application identity');
    if (KNOWN_DEV_VALUES.includes(cfg.S3_ACCESS_KEY.toLowerCase())) err('DEV_SECRET_S3', 'S3_ACCESS_KEY is a known development value');
  }
  if (service === 'ai-worker' || service === 'all') {
    if (!cfg.S3_AI_ACCESS_KEY || !cfg.S3_AI_SECRET_KEY) err('S3_AI_CREDENTIALS', 'S3_AI_ACCESS_KEY / S3_AI_SECRET_KEY are not set: the AI worker must use its own derived-bucket-only identity', 'create the AI identity (deploy/s3/policies/ai.json)');
    else if (cfg.S3_AI_ACCESS_KEY === cfg.S3_ACCESS_KEY && service === 'all') err('S3_AI_CREDENTIALS', 'S3_AI_ACCESS_KEY equals S3_ACCESS_KEY: the AI worker would have access to originals');
    else {
      const r = weakSecretReason(cfg.S3_AI_SECRET_KEY, 20);
      if (r) err('DEV_SECRET_S3', `S3_AI_SECRET_KEY ${r}`);
    }
    if (!cfg.DATABASE_AI_URL) err('DB_ROLE', 'DATABASE_AI_URL (role ksp_ai) is not set');
  }
  if (cfg.S3_ENDPOINT && cfg.S3_ENDPOINT.startsWith('http:')) warn('S3_TLS', `S3_ENDPOINT ${cfg.S3_ENDPOINT} is not https (acceptable only inside a trusted cluster network)`);

  // --- web / cookies ---------------------------------------------------------------------------------------------
  if (service === 'api' || service === 'all') {
    if (!cfg.COOKIE_SECURE) err('COOKIE_SECURE', 'COOKIE_SECURE is false', 'COOKIE_SECURE=true');
    if (!cfg.APP_BASE_URL.startsWith('https://')) err('APP_BASE_URL_HTTPS', `APP_BASE_URL ${cfg.APP_BASE_URL} is not https`, 'serve the SPA over TLS and set the https URL');
    const origins = cfg.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
    const bad = origins.filter((o) => !o.startsWith('https://') || o === '*');
    if (bad.length) err('CORS_HTTPS', `CORS_ORIGINS contains non-https origins: ${bad.join(', ')}`, 'list only the https origin(s) of the SPA');
    if (!cfg.TRUST_PROXY) warn('TRUST_PROXY', 'TRUST_PROXY=false: client IPs in the audit trail will be the ingress address', 'TRUST_PROXY=true behind the ingress');
    if (!cfg.ALLOWED_NETWORKS.trim()) warn('ALLOWED_NETWORKS', 'ALLOWED_NETWORKS is empty: the staff API answers from any network (tender §50 expects authorised internal networks only)', 'ALLOWED_NETWORKS=<KSP/VPN CIDRs>; the share portal and tokenised media stay exempt');
    if ((cfg.RATE_LIMIT_STORE ?? 'postgres') === 'memory') {
      if ((cfg.KSP_EXPECTED_API_REPLICAS ?? 2) > 1) err('RATE_LIMIT_STORE', 'RATE_LIMIT_STORE=memory with more than one API replica (or KSP_EXPECTED_API_REPLICAS unset): limits are per replica', 'RATE_LIMIT_STORE=postgres (default)');
      else warn('RATE_LIMIT_STORE', 'RATE_LIMIT_STORE=memory (single replica declared)');
    }
    if (!cfg.DATA_ENCRYPTION_KEY && !cfg.DATA_ENCRYPTION_KEYS) err('DATA_ENCRYPTION_KEY', 'no DATA_ENCRYPTION_KEY(S): MFA secrets cannot be encrypted at rest', 'generate with scripts/ops/generate-secrets.sh');
    const mt = weakSecretReason(cfg.MEDIA_TOKEN_SECRET, 32);
    if (mt) err('DEV_SECRET_MEDIA_TOKEN', `MEDIA_TOKEN_SECRET ${mt}`);
    if (/\.local\/secrets\//.test(env.JWT_PRIVATE_KEY ?? '') || /\.local\/secrets\//.test(env.SIGNING_PRIVATE_KEY ?? '')) err('DEV_SECRET_FILES', 'JWT / signing keys are read from the development secret store (.local/secrets)', 'mount production secrets (docs/SECRETS.md)');
  }
  if (app && env.DATA_ENCRYPTION_KEY && Buffer.from(env.DATA_ENCRYPTION_KEY, 'base64').every((b) => b === 0)) err('DEV_SECRET_DATA_KEY', 'DATA_ENCRYPTION_KEY is all zeros');

  // --- database ------------------------------------------------------------------------------------------------
  const dbUrl = service === 'ai-worker' ? cfg.DATABASE_AI_URL : cfg.DATABASE_URL;
  const u = urlPassword(dbUrl);
  if (u) {
    const pw = weakSecretReason(u.password, 16);
    if (pw && !(u.password === '' && (u.host === '' || u.host.startsWith('/')))) err('DEV_SECRET_DB', `database password for role ${u.user || '(default)'} ${pw}`, 'use the generated role password');
    const mode = u.params.get('sslmode') ?? process.env.PGSSLMODE ?? '';
    if (!['require', 'verify-ca', 'verify-full'].includes(mode)) {
      if (cfg.DATABASE_TLS_WAIVED) warn('DB_TLS', `database connection without enforced TLS (sslmode=${mode || 'unset'}) accepted by DATABASE_TLS_WAIVED`);
      else err('DB_TLS', `database connection does not enforce TLS (sslmode=${mode || 'unset'})`, 'append ?sslmode=verify-full (or require) to the database URL, or DATABASE_TLS_WAIVED=true for a Unix socket / same-pod proxy');
    }
    if (isLocalHost(u.host) && isProdTier) warn('DB_HOST', `database host is ${u.host}`);
  }
  if (cfg.LOG_LEVEL === 'debug' || cfg.LOG_LEVEL === 'trace') warn('LOG_LEVEL', `LOG_LEVEL=${cfg.LOG_LEVEL} in production`, 'LOG_LEVEL=info');

  // --- AI legal gates ---------------------------------------------------------------------------------------------
  if (cfg.AI_LEGAL_GATES !== 'enforce') err('AI_LEGAL_GATES', 'AI_LEGAL_GATES=off: face recognition / ANPR could run without a recorded legal approval', 'remove AI_LEGAL_GATES (enforce is the production default)');
  const unknownTasks = (cfg.AI_TASKS_ENABLED ?? '').split(',').map((t) => t.trim()).filter((t) => t && !(AI_TASKS as readonly string[]).includes(t));
  if (unknownTasks.length) err('AI_TASKS_ENABLED', `AI_TASKS_ENABLED contains unknown tasks: ${unknownTasks.join(', ')}`);
  return out;
}

/** Checks that need the database (role, TLS in use, seeded dev data, integration adapters, settings). */
export async function databasePreflight(db: Database, cfg: AppConfig, service: PreflightService): Promise<PreflightFinding[]> {
  const out: PreflightFinding[] = [];
  const err = (rule: string, message: string, remedy?: string) => out.push({ rule, severity: 'error', message, remedy });
  const warn = (rule: string, message: string, remedy?: string) => out.push({ rule, severity: 'warning', message, remedy });

  const role = await sql<{ usr: string; superuser: boolean; createrole: boolean; bypassrls: boolean; owns: boolean; evidence_select: boolean; ssl: boolean | null; jit: string }>`
    SELECT current_user AS usr, r.rolsuper AS superuser, r.rolcreaterole AS createrole, r.rolbypassrls AS bypassrls,
           EXISTS (SELECT 1 FROM pg_tables t WHERE t.schemaname = 'public' AND t.tablename = 'evidence' AND t.tableowner = current_user) AS owns,
           has_table_privilege('public.evidence', 'SELECT') AS evidence_select,
           (SELECT s.ssl FROM pg_stat_ssl s WHERE s.pid = pg_backend_pid()) AS ssl,
           current_setting('jit') AS jit
    FROM pg_roles r WHERE r.rolname = current_user`.execute(db);
  const r = role.rows[0];
  if (r) {
    if (r.superuser || r.createrole || r.bypassrls) err('DB_ROLE', `connected as ${r.usr}, a privileged role (superuser/createrole/bypassrls): triggers and grants could be bypassed`, service === 'ai-worker' ? 'connect as ksp_ai' : 'connect as ksp_app (db/bootstrap/roles.sql)');
    else if (r.owns) err('DB_ROLE', `connected as ${r.usr}, the owner of the schema: DDL and trigger changes are possible`, 'connect as ksp_app; the owner is for the migrate job only');
    if (service === 'ai-worker' && r.evidence_select) err('DB_ROLE', `AI worker role ${r.usr} can read the evidence table`, 'connect as ksp_ai (explicit grants only)');
    if (r.ssl === false && !cfg.DATABASE_TLS_WAIVED) err('DB_TLS', 'the current database session is not encrypted (pg_stat_ssl.ssl = false)');
    if (r.jit === 'on') warn('DB_JIT', 'PostgreSQL JIT is on for this database (dashboard queries are ~10x slower)', 'ALTER DATABASE <db> SET jit = off (migration 0901; lost by a single-database restore)');
  }
  if (service === 'ai-worker') return out;

  // Seeded development users / org units.
  const devUsers = await db.selectFrom('users').select(['username', 'password_hash', 'status']).where('username', 'in', [...DEV_SEED_USERNAMES]).execute();
  const nonAdmin = devUsers.filter((u) => u.username !== 'admin' && u.status !== 'DISABLED'); // DISABLED = purged (ops:purge-demo-data)
  if (nonAdmin.length) err('DEV_SEED_USERS', `development seed users exist: ${nonAdmin.map((u) => u.username).join(', ')}`, 'npm run ops:purge-demo-data (staging/UAT DB) or rebuild with npm run db:seed -- --production');
  for (const u of devUsers) {
    if (u.password_hash && (await verifySecret(u.password_hash, DEV_SEED_PASSWORD).catch(() => false))) {
      err('DEV_SEED_PASSWORD', `user '${u.username}' still has the development seed password`, 'reset the password / remove the user');
    }
  }
  const devOrg = await db.selectFrom('org_units').select('code').where('code', 'in', [...DEV_SEED_ORG_CODES]).where('active', '=', true).execute();
  if (devOrg.length) warn('DEV_SEED_ORG', `development seed org units exist: ${devOrg.map((o) => o.code).join(', ')}`, 'import the real hierarchy with npm run ops:bootstrap-org and purge demo data');

  // Integration systems backed by synthetic fixtures.
  const fixtures = await db.selectFrom('integration_systems').select(['code', 'enabled']).where('adapter', '=', 'fixture').execute();
  const enabledFixtures = fixtures.filter((f) => f.enabled);
  if (enabledFixtures.length) err('FIXTURE_INTEGRATION', `integration systems use the synthetic 'fixture' adapter and are enabled: ${enabledFixtures.map((f) => f.code).join(', ')}`, 'disable them (Admin → Integrations) or switch to http-json (docs/CCTNS-INTEGRATION-REQUEST.md)');
  else if (fixtures.length) warn('FIXTURE_INTEGRATION', `disabled fixture integration systems exist: ${fixtures.map((f) => f.code).join(', ')}`);

  // Settings that encode human decisions.
  const rows = await db.selectFrom('system_settings').select(['key', 'value']).where('key', 'in', ['sessionPolicy', 'aiLegalApprovals', 'exportLegalApproval']).execute();
  const get = (k: string) => rows.find((x) => x.key === k)?.value as Record<string, unknown> | undefined;
  const session = { ...DEFAULT_SETTINGS.sessionPolicy, ...(get('sessionPolicy') ?? {}) } as { requireMfaForRoles: string[]; mfaForPrivilegedPermissions?: boolean };
  const privilegedMfa = session.mfaForPrivilegedPermissions !== false;
  const missingMfa = ['SYSTEM_ADMINISTRATOR', 'SUPERVISOR', 'AUDITOR', 'EVIDENCE_CUSTODIAN'].filter((c) => !session.requireMfaForRoles.includes(c));
  if (!privilegedMfa) (isProdTier ? err : warn)('MFA_PRIVILEGED', 'MFA for roles holding administrative / approval rights is switched off', 'Settings → Sessions & MFA');
  if (!session.requireMfaForRoles.includes('SYSTEM_ADMINISTRATOR') && isProdTier) err('MFA_ADMIN', 'MFA is not mandatory for SYSTEM_ADMINISTRATOR', 'Settings → Sessions & MFA');
  if (missingMfa.length && !privilegedMfa) warn('MFA_POLICY', `MFA is not mandatory for: ${missingMfa.join(', ')}`, 'Settings → Session policy');
  const approvals = { ...DEFAULT_SETTINGS.aiLegalApprovals, ...(get('aiLegalApprovals') ?? {}) } as Record<string, unknown>;
  const enabled = enabledAiTasks(cfg);
  for (const t of LEGALLY_GATED_AI_TASKS) {
    if (aiLegalGatesEnforced(cfg) && enabled.includes(t as AiTask) && !approvals[t]) warn('AI_LEGAL_APPROVAL', `${t} is in AI_TASKS_ENABLED but no legal approval is recorded: requests will be refused`, 'record the approval reference in Settings → Legal approvals (docs/DPIA-INPUT.md)');
  }
  const exportApproval = (get('exportLegalApproval') ?? DEFAULT_SETTINGS.exportLegalApproval) as { approval?: unknown };
  if (!exportApproval.approval) warn('EXPORT_LEGAL_APPROVAL', 'court export Fact Sheet / BSA s.63 template not legally approved: PDFs are stamped "TEMPLATE – PENDING LEGAL APPROVAL"', 'record the approval in Settings → Legal approvals (EXT-6)');
  return out;
}

export async function runPreflight(opts: { cfg: AppConfig; service: PreflightService; db?: Database; env?: NodeJS.ProcessEnv; signer?: Signer }): Promise<PreflightResult> {
  const { cfg, service } = opts;
  let signer: Signer | Error | undefined;
  if (service !== 'ai-worker') {
    try {
      signer = opts.signer ?? createSigner(cfg);
    } catch (e) {
      signer = e as Error;
    }
  }
  const findings = staticPreflight(cfg, service, opts.env ?? process.env, signer);
  if (opts.db) {
    try {
      findings.push(...(await databasePreflight(opts.db, cfg, service)));
    } catch (e) {
      findings.push({ rule: 'DB_CHECK', severity: 'error', message: `database checks failed: ${(e as Error).message}` });
    }
  }
  const tier = cfg.KSP_ENVIRONMENT ?? 'production';
  const enforced = cfg.NODE_ENV === 'production' && !(cfg.KSP_PREFLIGHT !== 'enforce' && tier !== 'production');
  return { service, environment: tier, enforced, findings, errors: findings.filter((f) => f.severity === 'error'), warnings: findings.filter((f) => f.severity === 'warning') };
}

export function formatPreflight(r: PreflightResult): string {
  const lines = [`KSP preflight (${r.service}, KSP_ENVIRONMENT=${r.environment}): ${r.errors.length} violation(s), ${r.warnings.length} warning(s)`];
  for (const f of [...r.errors, ...r.warnings]) {
    lines.push(`  [${f.severity === 'error' ? 'VIOLATION' : 'warning  '}] ${f.rule}: ${f.message}${f.remedy ? `\n                 -> ${f.remedy}` : ''}`);
  }
  return lines.join('\n');
}

export class PreflightError extends Error {
  constructor(readonly result: PreflightResult) {
    super(`${formatPreflight(result)}\nRefusing to start with development/demo settings in production (docs/GO-LIVE-CHECKLIST.md).`);
    this.name = 'PreflightError';
  }
}

/**
 * Startup hook: no-op outside NODE_ENV=production (and with KSP_PREFLIGHT=off on a non-production tier). Throws
 * PreflightError when enforced and a violation exists; otherwise logs the findings through `log`.
 */
export async function enforcePreflight(opts: { cfg: AppConfig; service: PreflightService; db?: Database; log?: { warn: (o: object, m: string) => void; error: (o: object, m: string) => void } }): Promise<PreflightResult | null> {
  const { cfg } = opts;
  if (cfg.NODE_ENV !== 'production') return null;
  if (cfg.KSP_PREFLIGHT === 'off' && (cfg.KSP_ENVIRONMENT ?? 'production') !== 'production') return null;
  const result = await runPreflight(opts);
  if (result.errors.length && result.enforced) throw new PreflightError(result);
  if (result.findings.length) {
    const fn = result.errors.length ? opts.log?.error : opts.log?.warn;
    fn?.call(opts.log, { preflight: result.findings }, formatPreflight(result));
  }
  return result;
}
