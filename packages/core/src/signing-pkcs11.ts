/**
 * PKCS#11 (HSM / smart-card token) evidence signer — SIGNING_PROVIDER=pkcs11 (EXT-3).
 *
 * The private key never leaves the token: the signer opens a session on the token selected by PKCS11_TOKEN_LABEL
 * (or PKCS11_SLOT), logs in with the user PIN read from PKCS11_PIN_FILE and signs with the key whose CKA_LABEL is
 * PKCS11_KEY_LABEL (optionally CKA_ID = PKCS11_KEY_ID). The certificate comes from PKCS11_CERTIFICATE (PEM / file:)
 * or from the token (CKO_CERTIFICATE with the same label / id). On construction a self-test signature is verified
 * against the certificate's public key, so a key/certificate mismatch fails at startup, not at the first export.
 *
 * Mechanisms (signatures stay verifiable with the same OpenSSL commands as the PEM signer, VERIFY.txt):
 *   RSA   CKM_SHA256_RSA_PKCS      -> "RSA-SHA256"      (PKCS11_RSA_SCHEME=pkcs1, default)
 *         CKM_SHA256_RSA_PKCS_PSS  -> "RSA-PSS-SHA256"  (PKCS11_RSA_SCHEME=pss, MGF1-SHA256, salt 32)
 *   EC    CKM_ECDSA over a SHA-256 digest computed here, raw r||s converted to DER -> "ECDSA-SHA256"
 *
 * The session is re-opened (and the user logged in again) once when the token reports a lost session / login
 * (HSM restart, network HSM failover). Tested against SoftHSM2 2.6 (apps/api/test/pkcs11-signer.test.ts); vendor
 * HSMs (Thales Luna, Utimaco, nCipher, YubiHSM) are UNVERIFIED — see docs/SECRETS.md#hsm.
 *
 * `pkcs11js` is an OPTIONAL native dependency (node-gyp build); it is loaded only when this provider is selected.
 */
import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { AppConfig } from './config.js';
import { isTestCertificate, verifyWithCertificate, type SignatureResult, type Signer } from './signing.js';

export interface Pkcs11SignerOptions {
  module: string;
  slot?: number;
  tokenLabel?: string;
  pin: string;
  keyLabel: string;
  keyIdHex?: string;
  certificatePem?: string;
  rsaScheme?: 'pkcs1' | 'pss';
  /** SIGNING_KEY_ID written into manifests / checkpoints. */
  keyId: string;
}

/**
 * The subset of the `pkcs11js` API used here. Declared locally (not `import type 'pkcs11js'`) so the code type-checks
 * and builds in images where the optional native package was not installed.
 */
type Handle = Buffer;
interface Attribute { type: number; value?: number | boolean | string | Buffer }
type Template = Attribute[];
interface Mechanism { mechanism: number; parameter?: Buffer | number | { type: number; hashAlg: number; mgf: number; saltLen: number } }
interface Pkcs11Api {
  load(path: string): void;
  C_Initialize(): void;
  C_Finalize(): void;
  C_GetSlotList(tokenPresent?: boolean): Handle[];
  C_GetTokenInfo(slot: Handle): { label: string };
  C_OpenSession(slot: Handle, flags: number): Handle;
  C_CloseSession(session: Handle): void;
  C_Login(session: Handle, userType: number, pin?: string): void;
  C_Logout(session: Handle): void;
  C_FindObjectsInit(session: Handle, template: Template): void;
  C_FindObjects(session: Handle, max: number): Handle[];
  C_FindObjectsFinal(session: Handle): void;
  C_GetAttributeValue(session: Handle, object: Handle, template: Template): Attribute[];
  C_SignInit(session: Handle, mechanism: Mechanism, key: Handle): void;
  C_Sign(session: Handle, data: Buffer, out: Buffer): Buffer;
}
const P11_CONSTANTS = ['CKA_CLASS', 'CKA_ID', 'CKA_KEY_TYPE', 'CKA_LABEL', 'CKA_VALUE', 'CKF_SERIAL_SESSION', 'CKG_MGF1_SHA256', 'CKK_EC', 'CKK_RSA', 'CKM_ECDSA', 'CKM_SHA256',
  'CKM_SHA256_RSA_PKCS', 'CKM_SHA256_RSA_PKCS_PSS', 'CKO_CERTIFICATE', 'CKO_PRIVATE_KEY', 'CK_PARAMS_RSA_PSS', 'CKU_USER'] as const;
export type Pkcs11Module = { PKCS11: new () => Pkcs11Api } & Record<(typeof P11_CONSTANTS)[number], number>;

function loadPkcs11js(): Pkcs11Module {
  try {
    const mod = createRequire(import.meta.url)('pkcs11js') as Pkcs11Module;
    const missing = P11_CONSTANTS.filter((c) => typeof mod[c] !== 'number');
    if (missing.length) throw new Error(`pkcs11js does not export ${missing.join(', ')}`);
    return mod;
  } catch (e) {
    throw new Error(`SIGNING_PROVIDER=pkcs11 needs the optional native package 'pkcs11js' (npm install pkcs11js; build tools python3/make/g++ at image build time): ${(e as Error).message}`);
  }
}

export function pkcs11OptionsFromConfig(cfg: AppConfig): Pkcs11SignerOptions {
  if (!cfg.PKCS11_MODULE || !cfg.PKCS11_KEY_LABEL) throw new Error('SIGNING_PROVIDER=pkcs11 needs PKCS11_MODULE and PKCS11_KEY_LABEL');
  if (!cfg.PKCS11_PIN_FILE) throw new Error('SIGNING_PROVIDER=pkcs11 needs PKCS11_PIN_FILE (the PIN is never accepted inline)');
  let pin: string;
  try {
    pin = readFileSync(cfg.PKCS11_PIN_FILE, 'utf8').trim();
  } catch (e) {
    throw new Error(`cannot read PKCS11_PIN_FILE: ${(e as Error).message}`);
  }
  return {
    module: cfg.PKCS11_MODULE, slot: cfg.PKCS11_SLOT, tokenLabel: cfg.PKCS11_TOKEN_LABEL, pin, keyLabel: cfg.PKCS11_KEY_LABEL,
    keyIdHex: cfg.PKCS11_KEY_ID || undefined, certificatePem: cfg.PKCS11_CERTIFICATE, rsaScheme: cfg.PKCS11_RSA_SCHEME, keyId: cfg.SIGNING_KEY_ID,
  };
}

/** DER-encode an ECDSA signature given as raw r||s (PKCS#11 CKM_ECDSA output). */
export function ecdsaRawToDer(raw: Buffer): Buffer {
  const half = raw.length / 2;
  const int = (b: Buffer) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.subarray(i);
    if (v[0]! & 0x80) v = Buffer.concat([Buffer.from([0]), v]);
    return Buffer.concat([Buffer.from([0x02, v.length]), v]);
  };
  const body = Buffer.concat([int(raw.subarray(0, half)), int(raw.subarray(half))]);
  const len = body.length < 128 ? Buffer.from([body.length]) : Buffer.from([0x81, body.length]);
  return Buffer.concat([Buffer.from([0x30]), len, body]);
}

/** Library initialisation is process-wide: finalize only when the last signer using a module closes. */
const moduleRefs = new Map<string, number>();

const RETRY_CODES = ['CKR_SESSION_HANDLE_INVALID', 'CKR_SESSION_CLOSED', 'CKR_USER_NOT_LOGGED_IN', 'CKR_DEVICE_REMOVED', 'CKR_TOKEN_NOT_PRESENT', 'CKR_DEVICE_ERROR'];

export class Pkcs11Signer implements Signer {
  readonly provider = 'pkcs11';
  readonly keyId: string;
  readonly certificatePem: string;
  readonly nonEvidentiary: boolean;
  readonly keyType: 'rsa' | 'ec';
  private readonly p: Pkcs11Module;
  private readonly m: Pkcs11Api;
  private readonly slot: Handle;
  private session: Handle | null = null;
  private key: Handle | null = null;
  private readonly cert: X509Certificate;
  private closed = false;

  constructor(private readonly opts: Pkcs11SignerOptions) {
    this.p = loadPkcs11js();
    this.m = new this.p.PKCS11();
    this.m.load(opts.module);
    try {
      this.m.C_Initialize();
    } catch (e) {
      if (!String((e as Error).message).includes('CKR_CRYPTOKI_ALREADY_INITIALIZED')) throw this.wrap(e, 'C_Initialize');
    }
    moduleRefs.set(opts.module, (moduleRefs.get(opts.module) ?? 0) + 1);
    this.slot = this.findSlot();
    this.openSession();
    const kt = this.m.C_GetAttributeValue(this.session!, this.key!, [{ type: this.p.CKA_KEY_TYPE }])[0]!.value as Buffer;
    const keyType = kt.readUIntLE(0, Math.min(kt.length, 6));
    if (keyType === this.p.CKK_RSA) this.keyType = 'rsa';
    else if (keyType === this.p.CKK_EC) this.keyType = 'ec';
    else throw new Error(`PKCS#11 key '${opts.keyLabel}' has unsupported CKA_KEY_TYPE ${keyType} (RSA or EC P-256 required)`);
    const pem = opts.certificatePem ?? this.certificateFromToken();
    this.cert = new X509Certificate(pem);
    this.certificatePem = this.cert.toString();
    this.keyId = opts.keyId;
    this.nonEvidentiary = isTestCertificate(this.certificatePem, opts.keyId);
    // Self-test: the token key must match the certificate.
    const probe = Buffer.from(`ksp-pkcs11-self-test:${Date.now()}`);
    const { signature, algorithm } = this.signSync(probe);
    if (!verifyWithCertificate(probe, signature, this.certificatePem, algorithm)) {
      throw new Error(`PKCS#11 key '${opts.keyLabel}' does not match the signing certificate (${this.cert.subject.replace(/\n/g, ', ')})`);
    }
  }

  private wrap(e: unknown, op: string): Error {
    const msg = (e as Error).message ?? String(e);
    return new Error(`PKCS#11 ${op} failed: ${msg.replace(/\s+/g, ' ').slice(0, 300)}`);
  }

  private findSlot(): Handle {
    const slots = this.m.C_GetSlotList(true);
    if (this.opts.tokenLabel !== undefined) {
      for (const s of slots) if (this.m.C_GetTokenInfo(s).label.trim() === this.opts.tokenLabel) return s;
      throw new Error(`PKCS#11 token with label '${this.opts.tokenLabel}' not found (${slots.length} slot(s) with a token)`);
    }
    const idx = this.opts.slot ?? 0;
    // PKCS11_SLOT may be a list index or a slot id.
    const byId = slots.find((s) => s.readUIntLE(0, Math.min(s.length, 6)) === idx);
    const s = byId ?? slots[idx];
    if (!s) throw new Error(`PKCS#11 slot ${idx} not found`);
    return s;
  }

  private openSession(): void {
    try {
      this.session = this.m.C_OpenSession(this.slot, this.p.CKF_SERIAL_SESSION);
    } catch (e) {
      throw this.wrap(e, 'C_OpenSession');
    }
    try {
      this.m.C_Login(this.session, this.p.CKU_USER, this.opts.pin);
    } catch (e) {
      if (!String((e as Error).message).includes('CKR_USER_ALREADY_LOGGED_IN')) {
        this.m.C_CloseSession(this.session);
        this.session = null;
        throw this.wrap(e, 'C_Login (check PKCS11_PIN_FILE)');
      }
    }
    this.key = this.findObject(this.p.CKO_PRIVATE_KEY);
    if (!this.key) throw new Error(`PKCS#11 private key with label '${this.opts.keyLabel}'${this.opts.keyIdHex ? ` and id ${this.opts.keyIdHex}` : ''} not found on the token`);
  }

  private findObject(cls: number): Handle | null {
    const tpl: Template = [{ type: this.p.CKA_CLASS, value: cls }, { type: this.p.CKA_LABEL, value: this.opts.keyLabel }];
    if (this.opts.keyIdHex) tpl.push({ type: this.p.CKA_ID, value: Buffer.from(this.opts.keyIdHex, 'hex') });
    this.m.C_FindObjectsInit(this.session!, tpl);
    try {
      const found = this.m.C_FindObjects(this.session!, 2);
      if (found.length > 1) throw new Error(`PKCS#11: more than one object with label '${this.opts.keyLabel}' — set PKCS11_KEY_ID`);
      return found[0] ?? null;
    } finally {
      this.m.C_FindObjectsFinal(this.session!);
    }
  }

  private certificateFromToken(): string {
    const h = this.findObject(this.p.CKO_CERTIFICATE);
    if (!h) throw new Error(`no certificate with label '${this.opts.keyLabel}' on the token; set PKCS11_CERTIFICATE`);
    const der = this.m.C_GetAttributeValue(this.session!, h, [{ type: this.p.CKA_VALUE }])[0]!.value as Buffer;
    return new X509Certificate(der).toString();
  }

  private mechanism(): { mech: Mechanism; algorithm: string; prehash: boolean; size: number } {
    if (this.keyType === 'ec') return { mech: { mechanism: this.p.CKM_ECDSA }, algorithm: 'ECDSA-SHA256', prehash: true, size: 132 };
    if (this.opts.rsaScheme === 'pss') {
      const parameter = { type: this.p.CK_PARAMS_RSA_PSS, hashAlg: this.p.CKM_SHA256, mgf: this.p.CKG_MGF1_SHA256, saltLen: 32 };
      return { mech: { mechanism: this.p.CKM_SHA256_RSA_PKCS_PSS, parameter }, algorithm: 'RSA-PSS-SHA256', prehash: false, size: 1024 };
    }
    return { mech: { mechanism: this.p.CKM_SHA256_RSA_PKCS }, algorithm: 'RSA-SHA256', prehash: false, size: 1024 };
  }

  private signOnce(data: Buffer): { signature: string; algorithm: string } {
    const { mech, algorithm, prehash, size } = this.mechanism();
    const input = prehash ? createHash('sha256').update(data).digest() : data;
    this.m.C_SignInit(this.session!, mech, this.key!);
    let sig = this.m.C_Sign(this.session!, input, Buffer.alloc(size));
    if (this.keyType === 'ec') sig = ecdsaRawToDer(sig);
    return { signature: sig.toString('base64'), algorithm };
  }

  private signSync(data: Buffer): { signature: string; algorithm: string } {
    if (this.closed) throw new Error('PKCS#11 signer is closed');
    try {
      return this.signOnce(data);
    } catch (e) {
      const msg = String((e as Error).message);
      if (!RETRY_CODES.some((c) => msg.includes(c))) throw this.wrap(e, 'C_Sign');
      // Lost session (HSM restart / failover): re-open, log in again and retry once.
      try {
        if (this.session) this.m.C_CloseSession(this.session);
      } catch {
        /* already gone */
      }
      this.session = null;
      this.openSession();
      try {
        return this.signOnce(data);
      } catch (e2) {
        throw this.wrap(e2, 'C_Sign (after session re-open)');
      }
    }
  }

  async sign(data: Buffer): Promise<SignatureResult> {
    const { signature, algorithm } = this.signSync(data);
    return { algorithm, keyId: this.keyId, signature, certificatePem: this.certificatePem, certificateFingerprint256: this.cert.fingerprint256 };
  }

  verify(data: Buffer, signatureB64: string, certificatePem?: string): boolean {
    return verifyWithCertificate(data, signatureB64, certificatePem ?? this.certificatePem);
  }

  /** Diagnostics / tests: close the current session as an HSM restart would (the next sign() re-opens it). */
  dropSession(): void {
    if (this.session) this.m.C_CloseSession(this.session);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.session) {
        this.m.C_Logout(this.session);
        this.m.C_CloseSession(this.session);
      }
    } catch {
      /* ignore */
    }
    const left = (moduleRefs.get(this.opts.module) ?? 1) - 1;
    moduleRefs.set(this.opts.module, left);
    if (left > 0) return;
    try {
      this.m.C_Finalize();
    } catch {
      /* ignore */
    }
  }
}
