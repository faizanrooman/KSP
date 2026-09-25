/**
 * Evidence signing: detached signatures over export manifests and audit checkpoints using the configured
 * signing key (PEM) + X.509 certificate. In production this key lives in an HSM / DSC token; the
 * `Signer` interface is the integration point (see docs/SECURITY-ARCHITECTURE.md#signing).
 */
import { createPrivateKey, createPublicKey, sign, verify, X509Certificate, type KeyObject } from 'node:crypto';
import { loadConfig } from './config.js';

export interface SignatureResult {
  algorithm: string;
  keyId: string;
  signature: string; // base64
  certificatePem: string;
  certificateFingerprint256: string;
}

export interface Signer {
  sign(data: Buffer): Promise<SignatureResult>;
  verify(data: Buffer, signatureB64: string, certificatePem?: string): boolean;
}

export class PemSigner implements Signer {
  private readonly key: KeyObject;
  private readonly cert: X509Certificate;
  private readonly keyId: string;

  constructor(privateKeyPem: string, certificatePem: string, keyId: string) {
    this.key = createPrivateKey(privateKeyPem);
    this.cert = new X509Certificate(certificatePem);
    this.keyId = keyId;
    if (!this.cert.checkPrivateKey(this.key)) throw new Error('signing certificate does not match private key');
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
    const cert = certificatePem ? new X509Certificate(certificatePem) : this.cert;
    const pub = createPublicKey(cert.publicKey.export({ type: 'spki', format: 'pem' }));
    const digest = pub.asymmetricKeyType === 'ed25519' ? null : 'sha256';
    return verify(digest, data, pub, Buffer.from(signatureB64, 'base64'));
  }
}

let signer: Signer | undefined;
export function evidenceSigner(): Signer {
  if (!signer) {
    const cfg = loadConfig();
    signer = new PemSigner(cfg.SIGNING_PRIVATE_KEY, cfg.SIGNING_CERTIFICATE, cfg.SIGNING_KEY_ID);
  }
  return signer;
}
