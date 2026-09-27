/**
 * Evidence signing: detached signatures over export manifests, custody reports and audit checkpoints using the
 * configured signing key + X.509 certificate. Providers (SIGNING_PROVIDER):
 *   pem     — PEM private key + certificate (SIGNING_PRIVATE_KEY / SIGNING_CERTIFICATE). Development and staging.
 *   pkcs11  — key inside an HSM / smart-card token via PKCS#11 (signing-pkcs11.ts). Production.
 * A DSC / CCA eSign-backed signer is a future `Signer` implementation (docs/SECURITY-ARCHITECTURE.md#signing).
 *
 * Every signer reports whether its certificate is a TEST certificate (`nonEvidentiary`): the development
 * self-signed certificate (CN "... NOT FOR COURT USE"), any self-signed certificate, or the dev key id. Documents
 * signed with such a key are stamped "NON-EVIDENTIARY – TEST KEY" and the production preflight refuses to start
 * with one unless KSP_ALLOW_NONEVIDENTIARY_SIGNING=true on a non-production KSP_ENVIRONMENT.
 */
import { constants, createPrivateKey, createPublicKey, sign, verify, X509Certificate, type KeyObject } from 'node:crypto';
import { loadConfig, type AppConfig } from './config.js';
import { Pkcs11Signer, pkcs11OptionsFromConfig } from './signing-pkcs11.js';

export interface SignatureResult {
  algorithm: string;
  keyId: string;
  signature: string; // base64
  certificatePem: string;
  certificateFingerprint256: string;
}

export interface Signer {
  readonly keyId: string;
  readonly certificatePem: string;
  /** Provider id for diagnostics ('pem', 'pkcs11', …). */
  readonly provider: string;
  /** True when the certificate is a development / self-signed test certificate (documents must be stamped). */
  readonly nonEvidentiary: boolean;
  sign(data: Buffer): Promise<SignatureResult>;
  verify(data: Buffer, signatureB64: string, certificatePem?: string): boolean;
}

export const DEV_SIGNING_KEY_ID = 'ksp-dev-signing-key';
export const NON_EVIDENTIARY_STAMP = 'NON-EVIDENTIARY – TEST KEY';

/** Why a certificate / key id is a test identity (empty = looks like a real, CA-issued identity). */
export function testCertificateReasons(certificatePem: string, keyId: string): string[] {
  const reasons: string[] = [];
  if (keyId === DEV_SIGNING_KEY_ID) reasons.push(`key id is the development id '${DEV_SIGNING_KEY_ID}'`);
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(certificatePem);
  } catch {
    return [...reasons, 'certificate cannot be parsed'];
  }
  if (/NOT FOR COURT USE|\bTEST\b|\bDEV(ELOPMENT)?\b/i.test(cert.subject)) reasons.push(`certificate subject marks it as a test certificate (${cert.subject.replace(/\n/g, ', ')})`);
  if (cert.subject === cert.issuer) {
    let selfSigned = false;
    try {
      selfSigned = cert.verify(cert.publicKey);
    } catch {
      selfSigned = false;
    }
    if (selfSigned) reasons.push('certificate is self-signed (not issued by a CA)');
  }
  return reasons;
}

export function isTestCertificate(certificatePem: string, keyId: string): boolean {
  return testCertificateReasons(certificatePem, keyId).length > 0;
}

const PSS = { padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 };

/**
 * Verify a detached signature with the public key of `certificatePem`: Ed25519, ECDSA-SHA256 (DER), RSA-SHA256
 * (PKCS#1 v1.5) and RSA-PSS-SHA256 (salt 32). Without an explicit algorithm RSA tries PKCS#1 v1.5 then PSS.
 */
export function verifyWithCertificate(data: Buffer, signatureB64: string, certificatePem: string, algorithm?: string): boolean {
  const cert = new X509Certificate(certificatePem);
  const pub = createPublicKey(cert.publicKey.export({ type: 'spki', format: 'pem' }));
  const sig = Buffer.from(signatureB64, 'base64');
  if (pub.asymmetricKeyType === 'ed25519') return verify(null, data, pub, sig);
  if (pub.asymmetricKeyType === 'rsa') {
    if (algorithm === 'RSA-PSS-SHA256') return verify('sha256', data, { key: pub, ...PSS }, sig);
    return verify('sha256', data, pub, sig) || (algorithm === undefined && verify('sha256', data, { key: pub, ...PSS }, sig));
  }
  return verify('sha256', data, pub, sig);
}

export class PemSigner implements Signer {
  private readonly key: KeyObject;
  private readonly cert: X509Certificate;
  readonly keyId: string;
  readonly provider = 'pem';
  readonly nonEvidentiary: boolean;

  constructor(privateKeyPem: string, certificatePem: string, keyId: string) {
    this.key = createPrivateKey(privateKeyPem);
    this.cert = new X509Certificate(certificatePem);
    this.keyId = keyId;
    if (!this.cert.checkPrivateKey(this.key)) throw new Error('signing certificate does not match private key');
    this.nonEvidentiary = isTestCertificate(certificatePem, keyId);
  }

  get certificatePem(): string {
    return this.cert.toString();
  }

  private alg(): { name: string; digest: string | null } {
    const t = this.key.asymmetricKeyType;
    if (t === 'ed25519') return { name: 'Ed25519', digest: null };
    if (t === 'ec') return { name: 'ECDSA-SHA256', digest: 'sha256' };
    return { name: 'RSA-SHA256', digest: 'sha256' };
  }

  async sign(data: Buffer): Promise<SignatureResult> {
    const { name, digest } = this.alg();
    const sig = sign(digest, data, this.key);
    return {
      algorithm: name,
      keyId: this.keyId,
      signature: sig.toString('base64'),
      certificatePem: this.cert.toString(),
      certificateFingerprint256: this.cert.fingerprint256,
    };
  }

  verify(data: Buffer, signatureB64: string, certificatePem?: string): boolean {
    return verifyWithCertificate(data, signatureB64, certificatePem ?? this.cert.toString());
  }
}

type SignerFactory = (cfg: AppConfig) => Signer;
const factories: Record<string, SignerFactory> = {
  pem: (cfg) => {
    if (!cfg.SIGNING_PRIVATE_KEY || !cfg.SIGNING_CERTIFICATE) throw new Error('SIGNING_PROVIDER=pem needs SIGNING_PRIVATE_KEY and SIGNING_CERTIFICATE');
    return new PemSigner(cfg.SIGNING_PRIVATE_KEY, cfg.SIGNING_CERTIFICATE, cfg.SIGNING_KEY_ID);
  },
  pkcs11: (cfg) => new Pkcs11Signer(pkcs11OptionsFromConfig(cfg)),
};

/** Register an additional signer provider (signing-pkcs11.ts registers 'pkcs11'). */
export function registerSignerProvider(name: string, factory: SignerFactory): void {
  factories[name] = factory;
}

export function createSigner(cfg: AppConfig = loadConfig()): Signer {
  const f = factories[cfg.SIGNING_PROVIDER];
  if (!f) throw new Error(`Unknown SIGNING_PROVIDER '${cfg.SIGNING_PROVIDER}'`);
  return f(cfg);
}

let signer: Signer | undefined;
export function evidenceSigner(): Signer {
  if (!signer) signer = createSigner(loadConfig());
  return signer;
}

/** For tests / key rotation: replace or forget the cached signer (the next call re-reads the configuration). */
export function resetEvidenceSigner(s?: Signer): void {
  signer = s;
}
