/**
 * Signed Chain-of-Custody report.
 *
 * The report is built from a canonical JSON payload (evidence identity + every custody event + ledger
 * verification result). That payload is signed (detached) with the evidence signing key; the PDF prints the
 * payload hash, signature, key id and certificate fingerprint, carries a verification QR code, and embeds
 * `custody-payload.json`, `custody-payload.sig` (raw signature bytes) and `signing-cert.pem` as PDF
 * attachments so anyone can verify offline:
 *
 *   openssl x509 -in signing-cert.pem -pubkey -noout > pub.pem
 *   openssl dgst -sha256 -verify pub.pem -signature custody-payload.sig custody-payload.json
 */
import { createHash } from 'node:crypto';
import QRCode from 'qrcode';
import type { Database, Tx } from '../db/index.js';
import { evidenceSigner, NON_EVIDENTIARY_STAMP, type SignatureResult, type Signer } from '../signing.js';
import { canonicalJson, loadCustodyEvents, verifyCustody, type CustodyEvent, type CustodyVerification } from './ledger.js';
import { createDoc, drawText, gap, KSP_KN, finish, fmtBytes, fmtDuration, fmtTime, heading, keyValues, para, table, wrapToken } from './pdf.js';
import { loadEvidenceRecord, personLabel, type EvidenceRecord } from './records.js';

export const CUSTODY_REPORT_TYPE = 'KSP-CUSTODY-REPORT';

export interface CustodyReportPayload {
  type: typeof CUSTODY_REPORT_TYPE;
  version: 1;
  generatedAt: string;
  generatedBy: { type: string; id: string | null; name: string | null };
  evidence: EvidenceRecord;
  events: CustodyEvent[];
  verification: CustodyVerification;
}

export interface CustodyReport {
  payload: CustodyReportPayload;
  canonical: string;
  payloadSha256: string;
  signature: SignatureResult;
  pdf: Buffer;
}

export function opensslVerifyCommands(algorithm: string, sigFile: string, dataFile: string, certFile = 'signing-cert.pem'): string[] {
  const pub = 'signing-pubkey.pem';
  const cmds = [`openssl x509 -in ${certFile} -pubkey -noout > ${pub}`];
  if (algorithm === 'Ed25519') cmds.push(`openssl pkeyutl -verify -pubin -inkey ${pub} -rawin -in ${dataFile} -sigfile ${sigFile}`);
  else cmds.push(`openssl dgst -sha256 -verify ${pub} -signature ${sigFile} ${dataFile}`);
  return cmds;
}

export async function buildCustodyReport(
  db: Database | Tx,
  evidenceId: string,
  generatedBy: { type: string; id: string | null; name: string | null },
  signer: Signer = evidenceSigner(),
): Promise<CustodyReport> {
  const evidence = await loadEvidenceRecord(db, evidenceId);
  if (!evidence) throw new Error(`evidence ${evidenceId} not found`);
  const events = await loadCustodyEvents(db, evidenceId);
  const verification = await verifyCustody(db, events);
  const generatedAt = new Date();
  const payload: CustodyReportPayload = { type: CUSTODY_REPORT_TYPE, version: 1, generatedAt: generatedAt.toISOString(), generatedBy, evidence, events, verification };
  const canonical = canonicalJson(payload);
  const payloadSha256 = createHash('sha256').update(canonical).digest('hex');
  const signature = await signer.sign(Buffer.from(canonical, 'utf8'));
  const pdf = await renderCustodyPdf(payload, canonical, payloadSha256, signature, generatedAt, signer.nonEvidentiary ? [NON_EVIDENTIARY_STAMP] : []);
  return { payload, canonical, payloadSha256, signature, pdf };
}

async function renderCustodyPdf(p: CustodyReportPayload, canonical: string, payloadSha256: string, sig: SignatureResult, at: Date, stamps: string[]): Promise<Buffer> {
  const ev = p.evidence;
  const doc = await createDoc({ title: `Chain of Custody Report ${ev.evidenceNumber ?? ev.id}`, createdAt: at });
  para(doc, 'CHAIN OF CUSTODY REPORT', { size: 16, bold: true, color: '#0b2a4a', align: 'center' });
  para(doc, `Karnataka State Police (${KSP_KN}) - Video Evidence Management System`, { size: 9, color: '#333333', align: 'center' });
  gap(doc, 0.3);
  para(doc, `Generated ${fmtTime(p.generatedAt)} by ${p.generatedBy.name ?? p.generatedBy.id ?? p.generatedBy.type}`, { size: 8, color: '#333333', align: 'center' });

  heading(doc, '1. Evidence identity');
  keyValues(doc, [
    ['Evidence number', ev.evidenceNumber],
    ['Evidence ID', ev.id, true],
    ['Title', ev.title],
    ['Category', ev.category],
    ['Status', `${ev.status}${ev.legalHold ? ' (LEGAL HOLD)' : ''}`],
    ['Original filename', ev.originalFilename],
    ['Size', fmtBytes(ev.sizeBytes)],
    ['SHA-256', ev.sha256, true],
    ['SHA-512', ev.sha512 ? wrapToken(ev.sha512, 64) : null, true],
    ['Storage tier', ev.storageTier],
    ['Last fixity verification', fmtTime(ev.lastVerifiedAt)],
  ]);

  heading(doc, '2. Registration details');
  keyValues(doc, [
    ['Station / unit', `${ev.orgUnit.name} (${ev.orgUnit.code})`],
    ['Uploaded by', personLabel(ev.uploadedBy)],
    ['Recording officer', personLabel(ev.officer)],
    ['Device', ev.device ? `${ev.device.deviceType} ${ev.device.make ?? ''} ${ev.device.model ?? ''} S/N ${ev.device.serialNumber}`.replace(/\s+/g, ' ') : null],
    ['Recorded', `${fmtTime(ev.recordedAt)} to ${fmtTime(ev.recordedEndAt)}`],
    ['Duration', fmtDuration(ev.durationMs)],
    ['Registered', fmtTime(ev.registeredAt)],
    ['GPS', ev.gps ? `${ev.gps.latitude}, ${ev.gps.longitude} (${ev.gps.source ?? 'unknown source'})` : null],
    ['Linked cases', ev.cases.map((c) => `${c.caseNumber} - ${c.title}`).join('; ') || null],
  ]);

  heading(doc, `3. Custody events (${p.events.length})`);
  table(
    doc,
    [
      { header: 'Seq', width: 0.07 },
      { header: 'Time (UTC)', width: 0.17 },
      { header: 'Action', width: 0.2 },
      { header: 'Actor', width: 0.18 },
      { header: 'Outcome', width: 0.09 },
      { header: 'Hash (first 16)', width: 0.19, mono: true },
      { header: 'Chk', width: 0.1 },
    ],
    p.events.map((e) => [
      String(e.seq),
      fmtTime(e.occurredAt).replace(' UTC', ''),
      e.action,
      `${e.actorFullName ?? e.actorName ?? e.actorId ?? '-'} (${e.actorType})${e.actorIp ? ` ${e.actorIp}` : ''}`,
      e.outcome,
      e.hash.slice(0, 16),
      e.hashOk && e.linkOk ? 'OK' : 'BROKEN',
    ]),
  );

  heading(doc, '4. Ledger verification');
  const v = p.verification;
  keyValues(doc, [
    ['Result', v.chainIntact ? 'INTACT - every event hash recomputed and linked to its predecessor in the ledger' : `BROKEN at seq ${v.brokenSeqs.join(', ')}`],
    ['Events checked', v.eventsChecked],
    ['Ledger head at generation', v.ledgerHead ? `seq ${v.ledgerHead.seq}` : '-'],
    ['Ledger head hash', v.ledgerHead?.hash ?? null, true],
    ['Verified at', fmtTime(v.verifiedAt)],
  ]);

  heading(doc, '5. Digital signature');
  keyValues(doc, [
    ['Signed payload', 'custody-payload.json (attached to this PDF) - canonical JSON of sections 1-4'],
    ['Payload SHA-256', payloadSha256, true],
    ['Algorithm', sig.algorithm],
    ['Key ID', sig.keyId],
    ['Certificate SHA-256 fingerprint', sig.certificateFingerprint256, true],
    ['Signature (base64)', wrapToken(sig.signature, 64), true],
  ]);
  para(doc, 'Offline verification: open the PDF attachments (custody-payload.json, custody-payload.sig, signing-cert.pem) and run:', { size: 8 });
  for (const c of opensslVerifyCommands(sig.algorithm, 'custody-payload.sig', 'custody-payload.json')) para(doc, c, { mono: true, size: 7.5 });
  const qr = await QRCode.toBuffer(JSON.stringify({ t: 'ksp-custody-report', e: ev.evidenceNumber ?? ev.id, sha256: ev.sha256, p: payloadSha256, k: sig.keyId, f: sig.certificateFingerprint256, s: sig.signature }), { errorCorrectionLevel: 'L', margin: 1, scale: 2 });
  if (doc.y + 180 > doc.page.height - doc.page.margins.bottom) doc.addPage();
  doc.moveDown(0.5);
  const y = doc.y;
  doc.image(qr, doc.page.margins.left, y, { width: 170 });
  drawText(doc, 'Verification QR: evidence number, evidence SHA-256, payload SHA-256, key id, certificate fingerprint and signature.', doc.page.margins.left + 185, y + 10, { size: 8, color: '#333333', width: 300 });
  doc.y = y + 180;
  para(doc, 'This report was generated automatically from the tamper-evident audit ledger. It is a record of system events and does not by itself constitute a certificate under Section 63 of the Bharatiya Sakshya Adhiniyam, 2023.', { size: 7.5, color: '#555555' });

  doc.file(Buffer.from(canonical, 'utf8'), { name: 'custody-payload.json', type: 'application/json', description: 'Signed canonical custody payload', creationDate: at, modifiedDate: at });
  doc.file(Buffer.from(sig.signature, 'base64'), { name: 'custody-payload.sig', type: 'application/octet-stream', description: `Detached ${sig.algorithm} signature`, creationDate: at, modifiedDate: at });
  doc.file(Buffer.from(sig.certificatePem, 'utf8'), { name: 'signing-cert.pem', type: 'application/x-pem-file', description: 'Signing certificate', creationDate: at, modifiedDate: at });
  return finish(doc, `Chain of Custody ${ev.evidenceNumber ?? ev.id} - payload SHA-256 ${payloadSha256.slice(0, 16)}...`, stamps);
}
