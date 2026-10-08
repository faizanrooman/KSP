/**
 * Signed audit-ledger checkpoints. A checkpoint signs the ledger head (seq, hash) with the evidence signing
 * key. Copies exported to an external notary / WORM location let auditors prove that even a database
 * superuser did not rewrite history before that point (see docs/AUDIT.md).
 */
import { sql } from 'kysely';
import { X509Certificate } from 'node:crypto';
import type { Database, Tx } from '../db/index.js';
import { appendAudit, type AuditActor } from '../audit.js';
import { evidenceSigner, type Signer } from '../signing.js';
import { verifyLedger, type LedgerVerifyResult } from './ledger.js';

const remembered = new Set<string>();
/** Archive the signer's certificate (idempotent) so checkpoints keep verifying after a key rotation. */
export async function rememberSigningCertificate(db: Database | Tx, signer: Signer): Promise<string> {
  const cert = new X509Certificate(signer.certificatePem);
  if (remembered.has(cert.fingerprint256)) return cert.fingerprint256;
  await db.insertInto('signing_certificates')
    .values({ fingerprint256: cert.fingerprint256, key_id: signer.keyId, provider: signer.provider, non_evidentiary: signer.nonEvidentiary, certificate_pem: cert.toString() })
    .onConflict((oc) => oc.column('fingerprint256').doNothing()).execute();
  remembered.add(cert.fingerprint256);
  return cert.fingerprint256;
}

/** The certificate that signed a checkpoint: the current signer's, or the archived one with the recorded fingerprint. */
export async function checkpointCertificate(db: Database | Tx, certFingerprint: string | null, signer: Signer): Promise<string> {
  const current = signer.certificatePem;
  if (!certFingerprint || certFingerprint === new X509Certificate(current).fingerprint256) return current;
  const r = await db.selectFrom('signing_certificates').select('certificate_pem').where('fingerprint256', '=', certFingerprint).executeTakeFirst();
  return r?.certificate_pem ?? current;
}

export function checkpointPayload(c: { headSeq: number; headHash: string; createdAt: Date; keyId: string }): string {
  return `KSP-AUDIT-CHECKPOINT\nv=1\nseq=${c.headSeq}\nhash=${c.headHash}\ncreated=${c.createdAt.toISOString()}\nkey=${c.keyId}\n`;
}

export interface CheckpointRow {
  id: number;
  headSeq: number;
  headHash: string;
  createdAt: string;
  keyId: string;
  algorithm: string;
  signature: string;
  certFingerprint: string | null;
  verifiedFromSeq: number | null;
  chainOk: boolean | null;
}

type RawCheckpoint = { id: string | number; head_seq: string | number; head_hash: string; created_at: Date; key_id: string; algorithm: string; signature: string; cert_fingerprint: string | null; verified_from_seq: string | number | null; chain_ok: boolean | null };

export function mapCheckpoint(r: RawCheckpoint): CheckpointRow {
  return {
    id: Number(r.id),
    headSeq: Number(r.head_seq),
    headHash: r.head_hash,
    createdAt: r.created_at.toISOString(),
    keyId: r.key_id,
    algorithm: r.algorithm,
    signature: r.signature,
    certFingerprint: r.cert_fingerprint,
    verifiedFromSeq: r.verified_from_seq === null ? null : Number(r.verified_from_seq),
    chainOk: r.chain_ok,
  };
}

/** Raise (or bump) an alert, deduplicated on open alerts by dedupe_key. */
export async function raiseAlert(
  db: Database | Tx,
  a: { ruleCode: string; severity: 'INFO' | 'WARNING' | 'CRITICAL'; title: string; message: string; resourceType?: string; resourceId?: string; orgUnitId?: string | null; dedupeKey: string },
): Promise<void> {
  await sql`INSERT INTO alerts (rule_code, severity, title, message, resource_type, resource_id, org_unit_id, dedupe_key)
    VALUES (${a.ruleCode}, ${a.severity}, ${a.title}, ${a.message}, ${a.resourceType ?? null}, ${a.resourceId ?? null}, ${a.orgUnitId ?? null}::uuid, ${a.dedupeKey})
    ON CONFLICT (dedupe_key) WHERE status <> 'RESOLVED' AND dedupe_key IS NOT NULL
    DO UPDATE SET occurrences = alerts.occurrences + 1, last_seen_at = now(), message = EXCLUDED.message`.execute(db);
}

export async function chainBrokenAlert(db: Database | Tx, firstBadSeq: number, context: string): Promise<void> {
  await raiseAlert(db, {
    ruleCode: 'AUDIT_CHAIN_BROKEN',
    severity: 'CRITICAL',
    title: 'Audit ledger hash chain broken',
    message: `Ledger verification (${context}) failed at seq ${firstBadSeq}: a ledger row was modified, removed or inserted outside audit_append().`,
    resourceType: 'audit_events',
    resourceId: String(firstBadSeq),
    dedupeKey: `AUDIT_CHAIN_BROKEN:${firstBadSeq}`,
  });
}

export interface CreateCheckpointResult {
  created: boolean;
  checkpoint?: CheckpointRow;
  verification: LedgerVerifyResult;
  reason?: string;
}

/**
 * Verify the chain since the previous checkpoint, then sign the verified head. A broken chain is never
 * signed: a CRITICAL AUDIT_CHAIN_BROKEN alert is raised instead.
 */
export async function createCheckpoint(db: Database, actor: AuditActor, signer: Signer = evidenceSigner()): Promise<CreateCheckpointResult> {
  // Only checkpoints cut by this system after a successful verification anchor the incremental check.
  const last = await db.selectFrom('audit_checkpoints').select(['head_seq']).where('chain_ok', '=', true).orderBy('head_seq', 'desc').limit(1).executeTakeFirst();
  const from = last ? Number(last.head_seq) + 1 : 1;
  const verification = await verifyLedger(db, from, null);
  if (!verification.ok) {
    await chainBrokenAlert(db, verification.firstBadSeq!, 'checkpoint');
    await appendAudit(db, actor, { action: 'AUDIT_VERIFIED', outcome: 'FAILURE', resourceType: 'audit_ledger', details: { from, firstBadSeq: verification.firstBadSeq, checked: verification.checked, context: 'checkpoint' } });
    return { created: false, verification, reason: `chain broken at seq ${verification.firstBadSeq}` };
  }
  if (verification.headSeq === null || verification.headHash === null) return { created: false, verification, reason: 'no new ledger events since the last checkpoint' };
  const createdAt = new Date();
  const probe = await signer.sign(Buffer.from('probe'));
  const payload = checkpointPayload({ headSeq: verification.headSeq, headHash: verification.headHash, createdAt, keyId: probe.keyId });
  const sig = await signer.sign(Buffer.from(payload, 'utf8'));
  await rememberSigningCertificate(db, signer);
  const row = await db.transaction().execute(async (tx) => {
    const r = await tx
      .insertInto('audit_checkpoints')
      .values({ head_seq: verification.headSeq!, head_hash: verification.headHash!, created_at: createdAt, key_id: sig.keyId, algorithm: sig.algorithm, signature: sig.signature, cert_fingerprint: sig.certificateFingerprint256, verified_from_seq: from, chain_ok: true })
      .returningAll()
      .executeTakeFirstOrThrow();
    await appendAudit(tx, actor, { action: 'AUDIT_CHECKPOINT_CREATED', resourceType: 'audit_checkpoint', resourceId: String(r.id), details: { headSeq: verification.headSeq, headHash: verification.headHash, verifiedFromSeq: from, checked: verification.checked, keyId: sig.keyId, algorithm: sig.algorithm } });
    return r;
  });
  return { created: true, checkpoint: mapCheckpoint(row as RawCheckpoint), verification };
}

export interface CheckpointVerification {
  checkpoint: CheckpointRow;
  signatureValid: boolean;
  /** Ledger row at head_seq still carries head_hash. */
  headMatches: boolean;
  /** Chain recomputed from the previous checkpoint up to this one. */
  chain: LedgerVerifyResult;
  ok: boolean;
}

export async function verifyCheckpoint(db: Database | Tx, id: number, signer: Signer = evidenceSigner(), certificatePem?: string): Promise<CheckpointVerification | null> {
  const r = await db.selectFrom('audit_checkpoints').selectAll().where('id', '=', id).executeTakeFirst();
  if (!r) return null;
  const cp = mapCheckpoint(r as RawCheckpoint);
  const payload = checkpointPayload({ headSeq: cp.headSeq, headHash: cp.headHash, createdAt: new Date(cp.createdAt), keyId: cp.keyId });
  let signatureValid = false;
  try {
    signatureValid = signer.verify(Buffer.from(payload, 'utf8'), cp.signature, certificatePem ?? (await checkpointCertificate(db, cp.certFingerprint, signer)));
  } catch {
    signatureValid = false;
  }
  const at = await db.selectFrom('audit_events').select('hash').where('seq', '=', cp.headSeq).executeTakeFirst();
  const headMatches = !!at && at.hash === cp.headHash;
  const prev = await db.selectFrom('audit_checkpoints').select('head_seq').where('head_seq', '<', cp.headSeq).orderBy('head_seq', 'desc').limit(1).executeTakeFirst();
  const chain = await verifyLedger(db, prev ? Number(prev.head_seq) + 1 : 1, cp.headSeq);
  const chainOk = chain.ok && chain.headSeq === cp.headSeq && chain.headHash === cp.headHash;
  return { checkpoint: cp, signatureValid, headMatches, chain, ok: signatureValid && headMatches && chainOk };
}

export function certificateFingerprint(pem: string): string {
  return new X509Certificate(pem).fingerprint256;
}
