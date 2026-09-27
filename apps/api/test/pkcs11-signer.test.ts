/**
 * PKCS#11 signer against a REAL SoftHSM2 token (EXT-3): RSA (PKCS#1 v1.5 and PSS) and ECDSA P-256 keys imported
 * into a fresh token, certificate from the token or from a file, signatures over export manifests, custody reports
 * and audit checkpoints verified with the OpenSSL commands printed in VERIFY.txt / the custody PDF, session loss
 * recovery, wrong PIN / label / certificate. Skipped (with a warning) only when SoftHSM2 is not installed:
 * set SOFTHSM2_MODULE / SOFTHSM2_UTIL or install it under <main checkout>/.local/softhsm (docs/SECRETS.md#hsm).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createSigner, ecdsaRawToDer, loadConfig, Pkcs11Signer, repoRoot, systemActor, type Database, type Pkcs11Module, type Signer } from '@ksp/core';
import { buildCustodyReport, canonicalJson, createCheckpoint, opensslVerifyCommands, verifyCheckpoint } from '@ksp/core/custody';
import { closeApp } from './helpers.js';
import { evidenceTestSetup, evidenceTestTeardown, userId } from './evidence-setup.js';
import { createRegisteredEvidence } from './fixtures/evidence.js';
import { caIssuedIdentity, type TestIdentity } from './signing-support.js';

function findSoftHsm(): { module: string; util: string } | null {
  const roots = [repoRoot(), resolve(repoRoot(), '../../..')].map((r) => join(r, '.local/softhsm/usr'));
  const mods = [process.env.SOFTHSM2_MODULE, ...roots.map((r) => join(r, 'lib/softhsm/libsofthsm2.so')), '/usr/lib/softhsm/libsofthsm2.so'].filter(Boolean) as string[];
  const utils = [process.env.SOFTHSM2_UTIL, ...roots.map((r) => join(r, 'bin/softhsm2-util')), '/usr/bin/softhsm2-util'].filter(Boolean) as string[];
  const module = mods.find((m) => existsSync(m));
  const util = utils.find((u) => existsSync(u));
  return module && util ? { module, util } : null;
}

const HSM = findSoftHsm();
if (!HSM) console.warn('[pkcs11 tests] SKIPPED: SoftHSM2 not found (SOFTHSM2_MODULE / SOFTHSM2_UTIL)');
const PIN = '482915';
const TOKEN = 'ksp-evidence-test';

let dir: string;
let rsa: TestIdentity;
let ec: TestIdentity;
let db: Database;
const signers: Pkcs11Signer[] = [];

function util(...args: string[]) {
  return execFileSync(HSM!.util, ['--module', HSM!.module, ...args], { env: { ...process.env }, encoding: 'utf8' });
}
function mk(over: Partial<ConstructorParameters<typeof Pkcs11Signer>[0]> = {}): Pkcs11Signer {
  const s = new Pkcs11Signer({ module: HSM!.module, tokenLabel: TOKEN, pin: PIN, keyLabel: 'ksp-rsa', keyId: 'ksp-evidence-hsm-2026', ...over });
  signers.push(s);
  return s;
}
/** Run the documented OpenSSL verification commands in a scratch directory; resolves to their output. */
function opensslVerify(sig: { algorithm: string; signature: string; certificatePem: string }, data: Buffer): string {
  const d = mkdtempSync(join(tmpdir(), 'ksp-p11v-'));
  writeFileSync(join(d, 'data.bin'), data);
  writeFileSync(join(d, 'data.sig'), Buffer.from(sig.signature, 'base64'));
  writeFileSync(join(d, 'signing-cert.pem'), sig.certificatePem);
  let cmds = opensslVerifyCommands(sig.algorithm, 'data.sig', 'data.bin');
  if (sig.algorithm === 'RSA-PSS-SHA256') cmds = cmds.map((c) => c.replace('openssl dgst -sha256', 'openssl dgst -sha256 -sigopt rsa_padding_mode:pss -sigopt rsa_pss_saltlen:32'));
  return execFileSync('sh', ['-c', cmds.join(' && ')], { cwd: d, encoding: 'utf8' });
}

describe.skipIf(!HSM)('Pkcs11Signer on SoftHSM2', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ksp-softhsm-')); // no spaces: SoftHSM's config parser splits on them
    const conf = join(dir, 'softhsm2.conf');
    execFileSync('mkdir', ['-p', join(dir, 'tokens')]);
    writeFileSync(conf, `directories.tokendir = ${join(dir, 'tokens')}\nobjectstore.backend = file\nlog.level = ERROR\n`);
    process.env.SOFTHSM2_CONF = conf; // read by the module at C_Initialize
    util('--init-token', '--free', '--label', TOKEN, '--so-pin', '10293847', '--pin', PIN);
    rsa = caIssuedIdentity('rsa', 'KSP Evidence Signing HSM RSA');
    ec = caIssuedIdentity('ec', 'KSP Evidence Signing HSM EC');
    util('--import', rsa.keyFile, '--token', TOKEN, '--label', 'ksp-rsa', '--id', '01', '--pin', PIN);
    util('--import', ec.keyFile, '--token', TOKEN, '--label', 'ksp-ec', '--id', '02', '--pin', PIN);
    // Put the RSA certificate on the token (CKO_CERTIFICATE, same label/id as the key) with the signer's own binding.
    const { createRequire } = await import('node:module');
    const p = createRequire(import.meta.url)('pkcs11js') as Pkcs11Module & Record<string, number> & { PKCS11: new () => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const m = new p.PKCS11();
    m.load(HSM!.module);
    try { m.C_Initialize(); } catch { /* already initialised */ }
    const slot = m.C_GetSlotList(true).find((s) => m.C_GetTokenInfo(s).label.trim() === TOKEN)!;
    const sess = m.C_OpenSession(slot, p.CKF_SERIAL_SESSION | p.CKF_RW_SESSION);
    m.C_Login(sess, p.CKU_USER, PIN);
    const { X509Certificate } = await import('node:crypto');
    m.C_CreateObject(sess, [
      { type: p.CKA_CLASS, value: p.CKO_CERTIFICATE }, { type: p.CKA_CERTIFICATE_TYPE, value: p.CKC_X_509 }, { type: p.CKA_TOKEN, value: true },
      { type: p.CKA_LABEL, value: 'ksp-rsa' }, { type: p.CKA_ID, value: Buffer.from('01', 'hex') }, { type: p.CKA_VALUE, value: new X509Certificate(rsa.certPem).raw },
      { type: p.CKA_SUBJECT, value: subjectDer(new X509Certificate(rsa.certPem).raw) },
    ]);
    m.C_Logout(sess);
    m.C_CloseSession(sess);
    db = (await evidenceTestSetup()).db;
  }, 180_000);

  afterAll(async () => {
    for (const s of signers) s.close();
    await evidenceTestTeardown();
    await closeApp();
  });

  it('RSA key + certificate from the token: RSA-SHA256 verifiable with openssl; CA-issued cert is evidentiary', async () => {
    const s = mk();
    expect(s.keyType).toBe('rsa');
    expect(s.nonEvidentiary).toBe(false);
    expect(s.certificatePem).toContain('BEGIN CERTIFICATE');
    const data = Buffer.from(canonicalJson({ type: 'KSP-EXPORT-MANIFEST', version: 1, files: [{ path: 'originals/a.mp4', sha256: 'ab'.repeat(32) }] }));
    const sig = await s.sign(data);
    expect(sig).toMatchObject({ algorithm: 'RSA-SHA256', keyId: 'ksp-evidence-hsm-2026' });
    expect(s.verify(data, sig.signature)).toBe(true);
    expect(s.verify(Buffer.concat([data, Buffer.from('x')]), sig.signature)).toBe(false);
    expect(opensslVerify(sig, data)).toContain('Verified OK');
  });

  it('RSA-PSS (PKCS11_RSA_SCHEME=pss) verifies with openssl PSS options', async () => {
    const s = mk({ rsaScheme: 'pss' });
    const data = Buffer.from('audit checkpoint payload');
    const sig = await s.sign(data);
    expect(sig.algorithm).toBe('RSA-PSS-SHA256');
    expect(s.verify(data, sig.signature)).toBe(true);
    expect(opensslVerify(sig, data)).toContain('Verified OK');
  });

  it('ECDSA P-256 key with the certificate from a file: DER signature verifiable with openssl', async () => {
    const s = mk({ keyLabel: 'ksp-ec', keyIdHex: '02', certificatePem: ec.certPem });
    expect(s.keyType).toBe('ec');
    const data = Buffer.from('custody payload');
    const sig = await s.sign(data);
    expect(sig.algorithm).toBe('ECDSA-SHA256');
    expect(opensslVerify(sig, data)).toContain('Verified OK');
    expect(ecdsaRawToDer(Buffer.alloc(64, 0x81))[0]).toBe(0x30);
  });

  it('signs a custody report and an audit checkpoint; both verify', async () => {
    const s = mk();
    const ev = await createRegisteredEvidence({ orgCode: 'ps_cubbonpark', uploadedBy: await userId('io.meera') });
    const report = await buildCustodyReport(db, ev.id, { type: 'SYSTEM', id: 'pkcs11-test', name: 'pkcs11 test' }, s);
    expect(report.signature.algorithm).toBe('RSA-SHA256');
    expect(opensslVerify(report.signature, Buffer.from(report.canonical, 'utf8'))).toContain('Verified OK');
    const cp = await createCheckpoint(db, systemActor('pkcs11-test'), s);
    expect(cp.created, cp.reason).toBe(true);
    expect(await verifyCheckpoint(db, cp.checkpoint!.id, s)).toMatchObject({ signatureValid: true, headMatches: true, ok: true });
    // Key rotation: the (dev-key) default signer still verifies the HSM-signed checkpoint via the archived certificate.
    expect(await verifyCheckpoint(db, cp.checkpoint!.id)).toMatchObject({ signatureValid: true, ok: true });
    const archived = await db.selectFrom('signing_certificates').selectAll().where('fingerprint256', '=', cp.checkpoint!.certFingerprint!).executeTakeFirstOrThrow();
    expect(archived).toMatchObject({ provider: 'pkcs11', non_evidentiary: false, key_id: 'ksp-evidence-hsm-2026' });
  });

  it('re-opens the session after it is lost (HSM restart / failover)', async () => {
    const s = mk();
    s.dropSession();
    const data = Buffer.from('after reconnect');
    const sig = await s.sign(data);
    expect(s.verify(data, sig.signature)).toBe(true);
  });

  it('fails fast with clear errors: wrong PIN, unknown label, unknown token, key/certificate mismatch', () => {
    // PKCS#11 login state is per application + token: close every session first so the wrong PIN really reaches C_Login.
    for (const x of signers.splice(0)) x.close();
    expect(() => mk({ pin: '000000' })).toThrow(/C_Login.*PIN|CKR_PIN_INCORRECT/);
    expect(() => mk({ keyLabel: 'no-such-key' })).toThrow(/not found/);
    expect(() => mk({ tokenLabel: 'no-such-token' })).toThrow(/token with label 'no-such-token' not found/);
    expect(() => mk({ keyLabel: 'ksp-ec', keyIdHex: '02', certificatePem: rsa.certPem })).toThrow(/does not match the signing certificate/);
  });

  it('SIGNING_PROVIDER=pkcs11 via configuration (PIN from file)', async () => {
    const pinFile = join(dir, 'pin');
    writeFileSync(pinFile, `${PIN}\n`);
    const cfg = loadConfig({
      ...process.env, SIGNING_PROVIDER: 'pkcs11', SIGNING_PRIVATE_KEY: undefined, SIGNING_CERTIFICATE: undefined, SIGNING_KEY_ID: 'ksp-evidence-hsm-2026',
      PKCS11_MODULE: HSM!.module, PKCS11_TOKEN_LABEL: TOKEN, PKCS11_PIN_FILE: pinFile, PKCS11_KEY_LABEL: 'ksp-ec', PKCS11_KEY_ID: '02', PKCS11_CERTIFICATE: `file:${ec.certFile}`,
    });
    const s = createSigner(cfg) as Signer & Pkcs11Signer;
    signers.push(s);
    expect(s.provider).toBe('pkcs11');
    const sig = await s.sign(Buffer.from('config path'));
    expect(sig.algorithm).toBe('ECDSA-SHA256');
    expect(() => loadConfig({ ...process.env, SIGNING_PROVIDER: 'pkcs11', PKCS11_MODULE: HSM!.module })).toThrow(/PKCS11_KEY_LABEL/);
  });
});

/** Extract the DER-encoded subject Name from a DER X.509 certificate (CKA_SUBJECT is mandatory for certificate objects). */
function subjectDer(cert: Buffer): Buffer {
  const read = (b: Buffer, o: number) => {
    let len = b[o + 1]!;
    let hdr = 2;
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let i = 0; i < n; i++) len = (len << 8) | b[o + 2 + i]!;
      hdr = 2 + n;
    }
    return { tag: b[o]!, start: o, hdr, len, end: o + hdr + len };
  };
  const certSeq = read(cert, 0);
  const tbs = read(cert, certSeq.start + certSeq.hdr);
  let o = tbs.start + tbs.hdr;
  const fields: Array<ReturnType<typeof read>> = [];
  while (o < tbs.end) {
    const f = read(cert, o);
    fields.push(f);
    o = f.end;
  }
  const i = fields[0]!.tag === 0xa0 ? 1 : 0; // optional [0] version
  const subject = fields[i + 4]!; // serial, signature, issuer, validity, subject
  return cert.subarray(subject.start, subject.end);
}
