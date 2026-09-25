/**
 * Court export Fact Sheet (FACT_SHEET.pdf): case/FIR details, item list with hashes, durations, recording
 * times, officer/device, export purpose/court/recipient, requesting & approving officers, generation time,
 * statement of integrity and a PRE-FILLED TEMPLATE of the certificate under Section 63(4) of the Bharatiya
 * Sakshya Adhiniyam, 2023 (formerly Section 65B(4) of the Indian Evidence Act, 1872) for the responsible
 * officer to complete and sign by hand. The template is an aid only; it does not claim legal compliance.
 */
import { createDoc, finish, fmtBytes, fmtDuration, fmtTime, heading, keyValues, para, table, wrapToken, ensureSpace } from './pdf.js';
import { personLabel, type EvidenceRecord, type PersonRef } from './records.js';

export interface FactSheetItem {
  record: EvidenceRecord;
  verifiedSha256: string;
  verifiedSha512: string;
  verifiedAt: string;
  files: string[];
}

export interface FactSheetData {
  exportNumber: string;
  exportId: string;
  purpose: string;
  courtName: string | null;
  courtCaseNumber: string | null;
  recipient: string | null;
  requestedAt: string;
  approvedAt: string | null;
  requestedBy: PersonRef | null;
  approvedBy: PersonRef | null;
  approvalNote: string | null;
  orgUnit: { name: string; code: string };
  caseInfo: null | {
    caseNumber: string;
    title: string;
    status: string;
    courtName: string | null;
    courtCaseNumber: string | null;
    investigatingOfficer: PersonRef | null;
    fir: null | { firNumber: string; firYear: number; registeredAt: string; actsSections: string[]; placeOfOccurrence: string | null; briefFacts: string | null; station: string | null };
  };
  items: FactSheetItem[];
  generatedAt: string;
  ledgerHead: { seq: number; hash: string } | null;
  signing: { algorithm: string; keyId: string; certificateFingerprint256: string };
  includesWatermarked: boolean;
}

export async function renderFactSheet(d: FactSheetData): Promise<Buffer> {
  const at = new Date(d.generatedAt);
  const doc = createDoc({ title: `Court Export Fact Sheet ${d.exportNumber}`, createdAt: at });
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#0b2a4a').text('EVIDENCE EXPORT FACT SHEET', { align: 'center' });
  doc.font('Helvetica').fontSize(9).fillColor('#333333').text('Karnataka State Police - Video Evidence Management System', { align: 'center' });
  doc.moveDown(0.3).fontSize(10).fillColor('#000000').text(`Export ${d.exportNumber}`, { align: 'center' });

  heading(doc, '1. Export');
  keyValues(doc, [
    ['Export number', d.exportNumber],
    ['Export ID', d.exportId, true],
    ['Purpose', d.purpose],
    ['Court', d.courtName],
    ['Court case number', d.courtCaseNumber],
    ['Recipient', d.recipient],
    ['Issuing unit', `${d.orgUnit.name} (${d.orgUnit.code})`],
    ['Requested by', `${personLabel(d.requestedBy)}${d.requestedBy?.designation ? `, ${d.requestedBy.designation}` : ''} on ${fmtTime(d.requestedAt)}`],
    ['Approved by', `${personLabel(d.approvedBy)}${d.approvedBy?.designation ? `, ${d.approvedBy.designation}` : ''} on ${fmtTime(d.approvedAt)}`],
    ['Approval note', d.approvalNote],
    ['Package generated', fmtTime(d.generatedAt)],
  ]);

  heading(doc, '2. Case / FIR');
  if (!d.caseInfo) para(doc, 'No case was specified for this export.');
  else {
    const c = d.caseInfo;
    keyValues(doc, [
      ['Case number', c.caseNumber],
      ['Title', c.title],
      ['Status', c.status],
      ['Court (case record)', [c.courtName, c.courtCaseNumber].filter(Boolean).join(' / ') || null],
      ['Investigating officer', personLabel(c.investigatingOfficer)],
      ['FIR', c.fir ? `${c.fir.firNumber}/${c.fir.firYear}${c.fir.station ? `, ${c.fir.station}` : ''}, registered ${fmtTime(c.fir.registeredAt)}` : null],
      ['Acts / sections', c.fir?.actsSections.join(', ') || null],
      ['Place of occurrence', c.fir?.placeOfOccurrence ?? null],
      ['Brief facts', c.fir?.briefFacts ? c.fir.briefFacts.slice(0, 1500) : null],
    ]);
  }

  heading(doc, `3. Evidence items (${d.items.length})`);
  table(
    doc,
    [
      { header: 'Evidence no.', width: 0.2 },
      { header: 'Recorded (UTC)', width: 0.17 },
      { header: 'Duration', width: 0.1 },
      { header: 'Officer / device', width: 0.21 },
      { header: 'SHA-256 (verified at export)', width: 0.32, mono: true },
    ],
    d.items.map((i) => [
      i.record.evidenceNumber ?? i.record.id,
      fmtTime(i.record.recordedAt).replace(' UTC', ''),
      fmtDuration(i.record.durationMs).split(' ')[0]!,
      `${i.record.officer?.fullName ?? '-'} / ${i.record.device?.serialNumber ?? '-'}`,
      wrapToken(i.verifiedSha256, 32),
    ]),
  );
  for (const i of d.items) {
    ensureSpace(doc, 120);
    heading(doc, `Item ${i.record.evidenceNumber ?? i.record.id}`, 10);
    keyValues(doc, [
      ['Title', i.record.title],
      ['Original filename', i.record.originalFilename],
      ['Size', fmtBytes(i.record.sizeBytes)],
      ['Registered SHA-256', i.record.sha256, true],
      ['Verified SHA-256', i.verifiedSha256, true],
      ['Verified SHA-512', wrapToken(i.verifiedSha512, 64), true],
      ['Verified at', fmtTime(i.verifiedAt)],
      ['Recorded', `${fmtTime(i.record.recordedAt)} to ${fmtTime(i.record.recordedEndAt)}`],
      ['Recording officer', personLabel(i.record.officer)],
      ['Device', i.record.device ? `${i.record.device.deviceType} S/N ${i.record.device.serialNumber}` : null],
      ['Station', `${i.record.orgUnit.name} (${i.record.orgUnit.code})`],
      ['GPS', i.record.gps ? `${i.record.gps.latitude}, ${i.record.gps.longitude}` : null],
      ['Files in package', i.files.join('\n')],
    ]);
  }

  heading(doc, '4. Statement of integrity');
  para(doc, [
    `Each original evidence file listed above was re-read from immutable (object-locked) storage at ${fmtTime(d.generatedAt)} and its SHA-256 and SHA-512 digests were recomputed. For every item the recomputed digests are identical to the digests recorded when the file was first registered in the system; the files under originals/ in this package are byte-for-byte copies of the stored originals.`,
    d.includesWatermarked ? 'Files under watermarked/ are viewing copies derived from the playback proxy, with a visible "COPY - NOT ORIGINAL" watermark; they are NOT the original evidence.' : '',
    `manifest.json lists every file in the package with its size and SHA-256 and is digitally signed (${d.signing.algorithm}, key ${d.signing.keyId}, certificate SHA-256 fingerprint ${d.signing.certificateFingerprint256}); manifest.sig is the detached signature and VERIFY.txt gives the commands to check it offline.`,
    d.ledgerHead ? `The audit ledger head at packaging time was seq ${d.ledgerHead.seq}, hash ${d.ledgerHead.hash}.` : '',
  ].filter(Boolean).join('\n\n'), { size: 8.5 });

  doc.addPage();
  heading(doc, 'ANNEX - Certificate under Section 63(4), Bharatiya Sakshya Adhiniyam, 2023 (TEMPLATE)');
  para(doc, 'PRE-FILLED TEMPLATE FOR COMPLETION AND SIGNATURE BY THE RESPONSIBLE OFFICER. This template is generated by the system as an aid. It is not itself a certificate and the system makes no claim that it satisfies Section 63 (formerly Section 65B of the Indian Evidence Act, 1872). The prosecuting authority must confirm the required form (Schedule, Part A / Part B) before use.', { size: 8, bold: true, color: '#8a1c1c' });
  doc.moveDown(0.5);
  heading(doc, 'Part A - to be filled by the party producing the electronic record', 10);
  para(doc, [
    'I, ______________________________ (name), ______________________ (rank/designation), of ____________________________ (unit), do hereby solemnly affirm and sincerely state and submit as follows:',
    `1. The electronic records listed below (${d.items.length} item(s), export ${d.exportNumber}) were produced from the KSP Video Evidence Management System, a computer system regularly used to store and process body-worn camera and other video recordings, which were captured by the device(s) listed below.`,
    '2. During the relevant period the computer system and the capturing device(s) were operating properly, or, if not, any malfunction did not affect the electronic records or their accuracy.',
    '3. The information contained in the electronic records was regularly fed into the computer system in the ordinary course of activities.',
    '4. The hash values of the electronic records, computed by the system, are stated below and in manifest.json of export package ' + d.exportNumber + '.',
  ].join('\n\n'), { size: 8.5 });
  doc.moveDown(0.4);
  table(
    doc,
    [
      { header: 'Evidence no.', width: 0.22 },
      { header: 'Device (type / serial)', width: 0.22 },
      { header: 'Hash algorithm and value', width: 0.56, mono: true },
    ],
    d.items.map((i) => [i.record.evidenceNumber ?? i.record.id, i.record.device ? `${i.record.device.deviceType} / ${i.record.device.serialNumber}` : '________________', `SHA-256 ${i.verifiedSha256}`]),
  );
  doc.moveDown(1);
  para(doc, 'Place: ____________________     Date: ____________________', { size: 9 });
  doc.moveDown(1.5);
  para(doc, 'Signature: ______________________________     Name / designation / seal: ______________________________', { size: 9 });
  doc.moveDown(1);
  heading(doc, 'Part B - to be filled by the expert (if required)', 10);
  para(doc, 'I, ______________________________ (name), ______________________ (designation), certify that I have verified the hash values stated in Part A against the electronic records and that they match.\n\nSignature: ______________________________     Date: ____________________', { size: 8.5 });
  return finish(doc, `Fact Sheet ${d.exportNumber} - generated ${fmtTime(d.generatedAt)}`);
}
