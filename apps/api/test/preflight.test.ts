/**
 * Production preflight (packages/core/src/preflight.ts): every rule is triggered from a known-good production
 * configuration by changing exactly one thing, and the database rules run against the real test database
 * (ksp_app / ksp_ai / owner connections, seeded dev users, a fixture integration system).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  createDb, DEV_SIGNING_KEY_ID, enforcePreflight, isTestCertificate, loadConfig, PemSigner, PreflightError, runPreflight, staticPreflight, weakSecretReason,
  type AppConfig, type Database, type PreflightService,
} from '@ksp/core';
import { caIssuedIdentity, type TestIdentity } from './signing-support.js';

let id: TestIdentity;
let goodEnv: NodeJS.ProcessEnv;
let owner: Database;
let aiDb: Database;
let appDb: Database;

const pemFile = (v: string | undefined) => (v?.startsWith('file:') ? readFileSync(v.slice(5), 'utf8') : v ?? '');
const rand = (n: number) => randomBytes(n).toString('base64url');

beforeAll(() => {
  const test = loadConfig(); // loads .env.test into process.env
  id = caIssuedIdentity('rsa');
  goodEnv = {
    ...process.env,
    NODE_ENV: 'production',
    KSP_ENVIRONMENT: 'production',
    APP_BASE_URL: 'https://vms.ksp.gov.in',
    CORS_ORIGINS: 'https://vms.ksp.gov.in',
    COOKIE_SECURE: 'true',
    TRUST_PROXY: 'true',
    OBJECT_LOCK_MODE: 'COMPLIANCE',
    S3_ACCESS_KEY: 'KSPAPPPRODIDENTITY01',
    S3_SECRET_KEY: rand(30),
    S3_AI_ACCESS_KEY: 'KSPAIPRODIDENTITY001',
    S3_AI_SECRET_KEY: rand(30),
    MEDIA_TOKEN_SECRET: randomBytes(32).toString('hex'),
    DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    JWT_PRIVATE_KEY: pemFile(process.env.JWT_PRIVATE_KEY),
    JWT_PUBLIC_KEY: pemFile(process.env.JWT_PUBLIC_KEY),
    SIGNING_PRIVATE_KEY: id.keyPem,
    SIGNING_CERTIFICATE: id.certPem,
    SIGNING_KEY_ID: 'ksp-evidence-signing-2026',
    DATABASE_URL: `${test.DATABASE_URL}?sslmode=verify-full`,
    DATABASE_AI_URL: `${test.DATABASE_AI_URL}?sslmode=verify-full`,
    LOG_LEVEL: 'info',
  };
  for (const k of ['KSP_PREFLIGHT', 'KSP_ALLOW_NONEVIDENTIARY_SIGNING', 'OBJECT_LOCK_MODE_ACCEPT_GOVERNANCE', 'DATABASE_TLS_WAIVED', 'RATE_LIMIT_STORE', 'AI_LEGAL_GATES', 'AI_TASKS_ENABLED', 'SIGNING_PROVIDER']) delete goodEnv[k];
  owner = createDb(test.DATABASE_MIGRATION_URL!, 2).db;
  aiDb = createDb(test.DATABASE_AI_URL!, 2).db;
  appDb = createDb(test.DATABASE_URL, 2).db;
});
afterAll(async () => {
  await owner?.destroy();
  await aiDb?.destroy();
  await appDb?.destroy();
});

const cfgWith = (over: Record<string, string | undefined> = {}): AppConfig => {
  const env = { ...goodEnv, ...over };
  for (const [k, v] of Object.entries(over)) if (v === undefined) delete env[k];
  return loadConfig(env);
};
const rules = (cfg: AppConfig, service: PreflightService = 'all', env?: NodeJS.ProcessEnv) =>
  staticPreflight(cfg, service, env ?? goodEnv, new PemSigner(cfg.SIGNING_PRIVATE_KEY!, cfg.SIGNING_CERTIFICATE!, cfg.SIGNING_KEY_ID));
const errorsOf = (f: ReturnType<typeof rules>) => f.filter((x) => x.severity === 'error').map((x) => x.rule);
const warningsOf = (f: ReturnType<typeof rules>) => f.filter((x) => x.severity === 'warning').map((x) => x.rule);

describe('static rules', () => {
  it('a correct production configuration has no violations (only warnings for human decisions)', () => {
    const f = rules(cfgWith());
    expect(errorsOf(f)).toEqual([]);
    expect(warningsOf(f)).toContain('SIGNING_PROVIDER'); // PEM on disk instead of HSM
  });

  it('dev self-signed / NOT FOR COURT USE certificate and dev key id are refused', () => {
    const dev = cfgWith({ SIGNING_PRIVATE_KEY: process.env.SIGNING_PRIVATE_KEY, SIGNING_CERTIFICATE: process.env.SIGNING_CERTIFICATE, SIGNING_KEY_ID: DEV_SIGNING_KEY_ID });
    expect(isTestCertificate(dev.SIGNING_CERTIFICATE!, DEV_SIGNING_KEY_ID)).toBe(true);
    const f = rules(dev, 'api', { ...goodEnv, SIGNING_PRIVATE_KEY: process.env.SIGNING_PRIVATE_KEY });
    const e = f.find((x) => x.rule === 'SIGNING_TEST_KEY')!;
    expect(e.severity).toBe('error');
    expect(e.message).toMatch(/NOT FOR COURT USE/);
    expect(e.message).toMatch(/self-signed/);
    expect(e.message).toMatch(/ksp-dev-signing-key/);
    expect(errorsOf(f)).toContain('DEV_SECRET_FILES'); // key read from .local/secrets
    // Only the key id: still a test identity.
    expect(errorsOf(rules(cfgWith({ SIGNING_KEY_ID: DEV_SIGNING_KEY_ID }), 'api'))).toContain('SIGNING_TEST_KEY');
    // The CA-issued certificate is not a test certificate.
    expect(isTestCertificate(id.certPem, 'ksp-evidence-signing-2026')).toBe(false);
  });

  it('KSP_ALLOW_NONEVIDENTIARY_SIGNING is a warning on staging and a violation on production', () => {
    const over = { SIGNING_KEY_ID: DEV_SIGNING_KEY_ID, KSP_ALLOW_NONEVIDENTIARY_SIGNING: 'true' };
    const staging = rules(cfgWith({ ...over, KSP_ENVIRONMENT: 'staging' }), 'api');
    expect(errorsOf(staging)).not.toContain('SIGNING_TEST_KEY');
    expect(staging.find((x) => x.rule === 'SIGNING_TEST_KEY')!.message).toMatch(/NON-EVIDENTIARY/);
    const prod = rules(cfgWith(over), 'api');
    expect(errorsOf(prod)).toEqual(expect.arrayContaining(['SIGNING_TEST_KEY', 'SIGNING_TEST_KEY_WAIVER']));
  });

  it('object lock must be COMPLIANCE unless GOVERNANCE is explicitly accepted', () => {
    expect(errorsOf(rules(cfgWith({ OBJECT_LOCK_MODE: 'GOVERNANCE' })))).toContain('OBJECT_LOCK_MODE');
    const accepted = rules(cfgWith({ OBJECT_LOCK_MODE: 'GOVERNANCE', OBJECT_LOCK_MODE_ACCEPT_GOVERNANCE: 'true' }));
    expect(errorsOf(accepted)).not.toContain('OBJECT_LOCK_MODE');
    expect(warningsOf(accepted)).toContain('OBJECT_LOCK_MODE');
  });

  it('https-only URLs and secure cookies', () => {
    expect(errorsOf(rules(cfgWith({ APP_BASE_URL: 'http://vms.ksp.gov.in' }), 'api'))).toContain('APP_BASE_URL_HTTPS');
    expect(errorsOf(rules(cfgWith({ CORS_ORIGINS: 'https://vms.ksp.gov.in,http://localhost:5173' }), 'api'))).toContain('CORS_HTTPS');
    // COOKIE_SECURE=false is already refused by the config loader in production; the rule covers direct config objects.
    expect(() => cfgWith({ COOKIE_SECURE: 'false' })).toThrow(/COOKIE_SECURE/);
    expect(errorsOf(rules({ ...cfgWith(), COOKIE_SECURE: false }, 'api'))).toContain('COOKIE_SECURE');
  });

  it('development / default / weak secrets are detected', () => {
    expect(weakSecretReason('kspdevsecret-change-me', 20)).toMatch(/development|default/);
    expect(weakSecretReason('CHANGE_ME', 8)).toMatch(/pattern/);
    expect(weakSecretReason('short', 16)).toMatch(/shorter/);
    expect(weakSecretReason('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 32)).toMatch(/distinct/);
    expect(weakSecretReason(rand(30), 20)).toBeNull();
    expect(errorsOf(rules(cfgWith({ S3_ACCESS_KEY: 'kspdevaccess', S3_SECRET_KEY: 'kspdevsecret-change-me' })))).toContain('DEV_SECRET_S3');
    expect(errorsOf(rules(cfgWith({ MEDIA_TOKEN_SECRET: 'change-me-change-me-change-me-change-me' }), 'api'))).toContain('DEV_SECRET_MEDIA_TOKEN');
    const weakDb = goodEnv.DATABASE_URL!.replace(/\/\/ksp_app:[^@]+@/, '//ksp_app:ksp@');
    expect(errorsOf(rules(cfgWith({ DATABASE_URL: weakDb }), 'api'))).toContain('DEV_SECRET_DB');
    expect(errorsOf(rules(cfgWith({ DATA_ENCRYPTION_KEY: undefined, DATA_ENCRYPTION_KEYS: undefined }), 'api'))).toContain('DATA_ENCRYPTION_KEY');
  });

  it('the AI worker must have its own S3 identity and role', () => {
    expect(errorsOf(rules(cfgWith({ S3_AI_ACCESS_KEY: undefined, S3_AI_SECRET_KEY: undefined }), 'ai-worker'))).toContain('S3_AI_CREDENTIALS');
    expect(errorsOf(rules(cfgWith({ S3_AI_ACCESS_KEY: 'KSPAPPPRODIDENTITY01' }), 'all'))).toContain('S3_AI_CREDENTIALS');
    expect(errorsOf(rules(cfgWith({ DATABASE_AI_URL: undefined }), 'ai-worker'))).toContain('DB_ROLE');
  });

  it('database TLS is required unless explicitly waived', () => {
    const plain = goodEnv.DATABASE_URL!.replace('?sslmode=verify-full', '');
    expect(errorsOf(rules(cfgWith({ DATABASE_URL: plain }), 'api'))).toContain('DB_TLS');
    const waived = rules(cfgWith({ DATABASE_URL: plain, DATABASE_TLS_WAIVED: 'true' }), 'api');
    expect(errorsOf(waived)).not.toContain('DB_TLS');
    expect(warningsOf(waived)).toContain('DB_TLS');
  });

  it('in-memory rate limiting is refused with more than one API replica', () => {
    expect(errorsOf(rules(cfgWith({ RATE_LIMIT_STORE: 'memory' }), 'api'))).toContain('RATE_LIMIT_STORE');
    const single = rules(cfgWith({ RATE_LIMIT_STORE: 'memory', KSP_EXPECTED_API_REPLICAS: '1' }), 'api');
    expect(errorsOf(single)).not.toContain('RATE_LIMIT_STORE');
    expect(warningsOf(single)).toContain('RATE_LIMIT_STORE');
  });

  it('AI legal gates cannot be switched off and unknown AI tasks are rejected', () => {
    expect(errorsOf(rules(cfgWith({ AI_LEGAL_GATES: 'off' })))).toContain('AI_LEGAL_GATES');
    expect(errorsOf(rules(cfgWith({ AI_TASKS_ENABLED: 'OBJECT_DETECTION,IRIS_SCAN' })))).toContain('AI_TASKS_ENABLED');
  });

  it('KSP_PREFLIGHT=warn is refused on the production tier', () => {
    expect(errorsOf(rules(cfgWith({ KSP_PREFLIGHT: 'warn' })))).toContain('PREFLIGHT_MODE');
    expect(warningsOf(rules(cfgWith({ KSP_PREFLIGHT: 'warn', KSP_ENVIRONMENT: 'demo' })))).toContain('PREFLIGHT_MODE');
  });

  it('an unloadable signing key is a violation', async () => {
    const r = await runPreflight({ cfg: { ...cfgWith(), SIGNING_CERTIFICATE: caIssuedIdentity('ec').certPem }, service: 'api' });
    expect(r.errors.map((e) => e.rule)).toContain('SIGNING_KEY'); // certificate does not match the key
  });
});

describe('database rules', () => {
  it('ksp_app: seeded dev users + dev password, dev org units, unencrypted session, JIT', async () => {
    const r = await runPreflight({ cfg: cfgWith(), service: 'api', db: appDb, signer: new PemSigner(id.keyPem, id.certPem, 'ksp-evidence-signing-2026') });
    const e = r.errors.map((x) => x.rule);
    expect(e).toEqual(expect.arrayContaining(['DEV_SEED_USERS', 'DEV_SEED_PASSWORD', 'DB_TLS']));
    expect(e).not.toContain('DB_ROLE');
    expect(r.errors.find((x) => x.rule === 'DEV_SEED_USERS')!.message).toMatch(/io\.meera/);
    expect(r.errors.filter((x) => x.rule === 'DEV_SEED_PASSWORD').map((x) => x.message).join(' ')).toMatch(/'admin'/);
    expect(r.warnings.map((x) => x.rule)).toEqual(expect.arrayContaining(['DEV_SEED_ORG', 'EXPORT_LEGAL_APPROVAL']));
    expect(r.enforced).toBe(true);
  });

  it('the schema owner / a superuser connection is refused', async () => {
    const r = await runPreflight({ cfg: cfgWith({ DATABASE_TLS_WAIVED: 'true' }), service: 'api', db: owner, signer: new PemSigner(id.keyPem, id.certPem, 'k1') });
    expect(r.errors.map((x) => x.rule)).toContain('DB_ROLE');
  });

  it('ksp_ai passes the role check (cannot read evidence) and skips the application-data rules', async () => {
    const r = await runPreflight({ cfg: cfgWith({ DATABASE_TLS_WAIVED: 'true' }), service: 'ai-worker', db: aiDb });
    expect(r.errors.map((x) => x.rule)).toEqual([]);
  });

  it('an enabled fixture integration system is refused', async () => {
    const code = `pf_fixture_${Date.now()}`;
    await owner.insertInto('integration_systems').values({ code, name: 'Preflight fixture', system_type: 'CCTNS', adapter: 'fixture', enabled: true }).execute();
    try {
      const r = await runPreflight({ cfg: cfgWith(), service: 'worker', db: appDb, signer: new PemSigner(id.keyPem, id.certPem, 'k1') });
      expect(r.errors.find((x) => x.rule === 'FIXTURE_INTEGRATION')?.message).toContain(code);
    } finally {
      await owner.deleteFrom('integration_systems').where('code', '=', code).execute();
    }
  });
});

describe('startup enforcement', () => {
  it('is a no-op in development and test', async () => {
    expect(await enforcePreflight({ cfg: loadConfig(), service: 'api', db: appDb })).toBeNull();
    expect(await enforcePreflight({ cfg: cfgWith({ NODE_ENV: 'development', COOKIE_SECURE: 'false' }), service: 'api' })).toBeNull();
  });

  it('refuses to start in production and lists every violation', async () => {
    const cfg = cfgWith({ OBJECT_LOCK_MODE: 'GOVERNANCE', SIGNING_PRIVATE_KEY: process.env.SIGNING_PRIVATE_KEY, SIGNING_CERTIFICATE: process.env.SIGNING_CERTIFICATE, SIGNING_KEY_ID: DEV_SIGNING_KEY_ID });
    const err = await enforcePreflight({ cfg, service: 'api', db: appDb }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(PreflightError);
    const msg = (err as Error).message;
    for (const rule of ['SIGNING_TEST_KEY', 'OBJECT_LOCK_MODE', 'DEV_SEED_USERS', 'DB_TLS']) expect(msg).toContain(rule);
    expect(msg).toMatch(/Refusing to start/);
  });

  it('KSP_PREFLIGHT=warn on a demo tier logs and starts; on the production tier it still refuses', async () => {
    const logged: string[] = [];
    const log = { warn: (_o: object, m: string) => logged.push(m), error: (_o: object, m: string) => logged.push(m) };
    const r = await enforcePreflight({ cfg: cfgWith({ KSP_PREFLIGHT: 'warn', KSP_ENVIRONMENT: 'demo', OBJECT_LOCK_MODE: 'GOVERNANCE' }), service: 'api', db: appDb, log });
    expect(r?.enforced).toBe(false);
    expect(r?.errors.map((e) => e.rule)).toContain('OBJECT_LOCK_MODE');
    expect(logged.join('\n')).toContain('VIOLATION');
    await expect(enforcePreflight({ cfg: cfgWith({ KSP_PREFLIGHT: 'warn', OBJECT_LOCK_MODE: 'GOVERNANCE' }), service: 'api', db: appDb })).rejects.toBeInstanceOf(PreflightError);
  });
});
