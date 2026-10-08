/** Test PKI: a throw-away CA and a CA-issued signing certificate made with the openssl CLI (real X.509, no mocks). */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TestIdentity {
  dir: string;
  keyPem: string;
  certPem: string;
  caCertPem: string;
  keyFile: string;
  certFile: string;
}

/** `keyType`: 'rsa' (3072) or 'ec' (P-256). The leaf subject has no test markers; it is issued by a separate CA. */
export function caIssuedIdentity(keyType: 'rsa' | 'ec' = 'rsa', cn = 'KSP Evidence Signing 2026'): TestIdentity {
  const dir = mkdtempSync(join(tmpdir(), 'ksp-pki-'));
  const o = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  const gen = (file: string) => (keyType === 'rsa'
    ? o('genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:3072', '-out', file)
    : o('genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', file));
  gen('ca.key');
  o('req', '-new', '-x509', '-key', 'ca.key', '-out', 'ca.crt', '-days', '365', '-subj', '/C=IN/O=Karnataka State Police/CN=KSP Issuing CA G1');
  gen('leaf.key');
  o('req', '-new', '-key', 'leaf.key', '-out', 'leaf.csr', '-subj', `/C=IN/ST=Karnataka/O=Karnataka State Police/CN=${cn}`);
  writeFileSync(join(dir, 'ext.cnf'), 'keyUsage=critical,digitalSignature,nonRepudiation\nbasicConstraints=CA:FALSE\n');
  o('x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'leaf.crt', '-days', '365', '-extfile', 'ext.cnf');
  return {
    dir,
    keyPem: readFileSync(join(dir, 'leaf.key'), 'utf8'),
    certPem: readFileSync(join(dir, 'leaf.crt'), 'utf8'),
    caCertPem: readFileSync(join(dir, 'ca.crt'), 'utf8'),
    keyFile: join(dir, 'leaf.key'),
    certFile: join(dir, 'leaf.crt'),
  };
}
