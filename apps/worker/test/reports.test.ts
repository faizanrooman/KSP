import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { appendAudit, createDb, getQueue, loadConfig, stopQueue, storage, type Database } from '@ksp/core';
import type { ReportParams, ReportType } from '@ksp/shared';
import { createRegisteredEvidence, type CreatedEvidence } from '../../api/test/fixtures/evidence.js';
import { runReportBuild } from '../src/jobs/reports/index.js';
import { csvCell } from '../src/jobs/reports/build.js';

let db: Database;
let kavya: { id: string; name: string; username: string };
let orgs: Record<string, { id: string; path: string }>;
let cubbon: CreatedEvidence;
let nazarbad: CreatedEvidence;
let meeraId: string;

beforeAll(async () => {
  const cfg = loadConfig();
  db = createDb(cfg.DATABASE_URL, 4).db;
  await getQueue();
  const u = await db.selectFrom('users').select(['id', 'full_name', 'username']).where('username', '=', 'sup.kavya').executeTakeFirstOrThrow();
  kavya = { id: u.id, name: u.full_name, username: u.username };
  meeraId = (await db.selectFrom('users').select('id').where('username', '=', 'io.meera').executeTakeFirstOrThrow()).id;
  const op = (await db.selectFrom('users').select('id').where('username', '=', 'op.cubbon').executeTakeFirstOrThrow()).id;
  const units = await db.selectFrom('org_units').select(['id', 'code', 'path']).execute();
  orgs = Object.fromEntries(units.map((x) => [x.code, { id: x.id, path: x.path }]));
  cubbon = await createRegisteredEvidence({ db, orgCode: 'ps_cubbonpark', uploadedBy: op, title: '=HYPERLINK("http://evil")' });
  nazarbad = await createRegisteredEvidence({ db, orgCode: 'ps_nazarbad', uploadedBy: op, title: 'Mysuru item' });
  const actor = { type: 'USER' as const, id: meeraId, name: 'Meera Rao' };
  for (const e of [cubbon, nazarbad]) {
    await appendAudit(db, actor, { action: 'EVIDENCE_VIEWED', resourceType: 'evidence', resourceId: e.id, evidenceId: e.id, orgUnitId: e.orgUnitId });
    await appendAudit(db, actor, { action: 'EVIDENCE_PLAYED', resourceType: 'evidence', resourceId: e.id, evidenceId: e.id, orgUnitId: e.orgUnitId });
    await appendAudit(db, actor, { action: 'EVIDENCE_DOWNLOADED', resourceType: 'evidence', resourceId: e.id, evidenceId: e.id, orgUnitId: e.orgUnitId });
    await db.insertInto('integrity_checks').values({ evidence_id: e.id, trigger: 'SCHEDULED', expected_sha256: e.sha256, actual_sha256: e.sha256, ok: true }).execute();
  }
  await db.updateTable('evidence').set({ retain_until: new Date(Date.now() - 86_400_000) }).where('id', '=', cubbon.id).execute();
  await db.updateTable('evidence').set({ legal_hold: true, legal_hold_reason: 'court order 12/2026', legal_hold_at: new Date(), legal_hold_by: kavya.id }).where('id', '=', nazarbad.id).execute();
  await db.insertInto('upload_sessions').values({
    created_by: op, org_unit_id: orgs.ps_cubbonpark!.id, original_filename: 'x.mp4', declared_size: 10, chunk_size: 16 * 1024 * 1024, total_chunks: 1,
    staging_bucket: storage().bucket('staging'), staging_key: 'rt/x', expires_at: new Date(Date.now() + 3600_000), status: 'FAILED', error: 'unsupported codec',
  }).execute();
  await db.insertInto('shares').values({ created_by: meeraId, org_unit_id: orgs.ps_cubbonpark!.id, recipient_type: 'INTERNAL_USER', recipient_user_id: kavya.id, purpose: 'review footage', expires_at: new Date(Date.now() + 86_400_000) }).execute();
  const model = await db.insertInto('ai_models').values({ code: 'rep-test', name: 'Report test model', task: 'OBJECT_DETECTION', version: '1.2.3', artifact_uri: 'file:///dev/null' }).returning('id').executeTakeFirstOrThrow();
  const job = await db.insertInto('ai_jobs').values({ evidence_id: cubbon.id, requested_by: meeraId, tasks: ['OBJECT_DETECTION'], status: 'COMPLETED', input: JSON.stringify({}) }).returning('id').executeTakeFirstOrThrow();
  const det = (status: string) => ({ job_id: job.id, evidence_id: cubbon.id, model_id: model.id, model_code: 'rep-test', model_version: '1.2.3', task: 'OBJECT_DETECTION', label: 'car', confidence: 0.9, threshold: 0.5, frame_time_ms: 0, review_status: status });
  const dets = await db.insertInto('ai_detections').values([det('APPROVED'), det('REJECTED'), det('PENDING')]).returning(['id', 'review_status']).execute();
  for (const d of dets.filter((x) => x.review_status !== 'PENDING')) {
    await db.insertInto('ai_review_events').values({ detection_id: d.id, reviewer_id: kavya.id, action: d.review_status === 'APPROVED' ? 'APPROVE' : 'REJECT', previous_status: 'PENDING', new_status: d.review_status, model_id: model.id, model_version: '1.2.3', confidence: 0.9 }).execute();
  }
}, 180_000);

afterAll(async () => {
  await stopQueue();
  await db.destroy();
});

const central = () => orgs.blr_central!.path;

async function run(type: ReportType, format: 'CSV' | 'PDF' | 'JSON', scopePaths: string[], extra: Partial<ReportParams> = {}, orgUnitId: string | null = null) {
  const params: ReportParams = { from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date(Date.now() + 86_400_000).toISOString(), scopePaths, requestedBy: kavya, ...extra };
  const r = await db.insertInto('report_runs').values({ report_type: type, format, params: JSON.stringify(params), created_by: kavya.id, org_unit_id: orgUnitId }).returning('id').executeTakeFirstOrThrow();
  const res = await runReportBuild({ db, storage: storage() }, r.id);
  const row = await db.selectFrom('report_runs').selectAll().where('id', '=', r.id).executeTakeFirstOrThrow();
  const body = row.object_key ? await storage().getBuffer(row.bucket!, row.object_key) : Buffer.alloc(0);
  return { res, row, body, text: body.toString('utf8') };
}

function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\r') continue;
    else if (ch === '\n') { row.push(cell); out.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  return out;
}
const records = (text: string) => {
  const [h, ...rows] = parseCsv(text);
  return rows.map((r) => Object.fromEntries(h!.map((k, i) => [k, r[i]!])));
};

describe('report builder', () => {
  it('CSV: sha256 of the stored object matches, row_count, audit REPORT_GENERATED; jurisdiction respected', async () => {
    const { res, row, body, text } = await run('EVIDENCE_INVENTORY', 'CSV', [central()]);
    expect(res.status).toBe('COMPLETED');
    expect(row.sha256).toBe(createHash('sha256').update(body).digest('hex'));
    expect(row.content_sha256).toBe(row.sha256);
    expect(Number(row.size_bytes)).toBe(body.length);
    const recs = records(text);
    expect(row.row_count).toBe(recs.length);
    const cp = recs.find((r) => r['Station code'] === 'ps_cubbonpark');
    expect(Number(cp!.Items)).toBeGreaterThanOrEqual(1);
    expect(recs.some((r) => r['Station code'] === 'ps_nazarbad')).toBe(false);
    const audit = await db.selectFrom('audit_events').select(['details', 'actor_type']).where('action', '=', 'REPORT_GENERATED').where('resource_id', '=', row.id).executeTakeFirstOrThrow();
    expect(audit.details).toMatchObject({ reportType: 'EVIDENCE_INVENTORY', rowCount: recs.length, sha256: row.sha256 });
    expect(JSON.stringify(audit.details)).not.toContain(row.object_key!);
    // idempotent: a COMPLETED run is not rebuilt
    expect((await runReportBuild({ db, storage: storage() }, row.id)).status).toBe('SKIPPED');
  });

  it('orgUnitId narrows the scope; a Mysuru-only scope never includes Bengaluru data', async () => {
    const my = records((await run('EVIDENCE_INVENTORY', 'CSV', [orgs.mysuru_dist!.path])).text);
    expect(my.map((r) => r['Station code'])).toEqual(['ps_nazarbad']);
    const narrowed = records((await run('EVIDENCE_INVENTORY', 'CSV', [orgs.ksp!.path], {}, orgs.ps_highgrounds!.id)).text);
    expect(narrowed.every((r) => r['Station code'] === 'ps_highgrounds')).toBe(true);
    const empty = await run('EVIDENCE_INVENTORY', 'CSV', []);
    expect(empty.row.row_count).toBe(0);
  });

  it('UPLOAD_ACTIVITY includes failures with reasons', async () => {
    const recs = records((await run('UPLOAD_ACTIVITY', 'CSV', [central()])).text);
    const r = recs.find((x) => x.Uploader === 'op.cubbon' && Number(x.Failed) >= 1);
    expect(r).toBeTruthy();
    expect(r!['Quarantine/failure reasons']).toContain('unsupported codec');
  });

  it('CHAIN_OF_CUSTODY_SUMMARY and ACCESS_AUDIT count access events per item; CSV formula injection is neutralised', async () => {
    const cs = records((await run('CHAIN_OF_CUSTODY_SUMMARY', 'CSV', [central()])).text);
    const item = cs.find((r) => r['Evidence no.'] === cubbon.evidenceNumber)!;
    expect(item).toMatchObject({ Views: '1', Plays: '1', Downloads: '1' });
    expect(item.Title).toBe(`'=HYPERLINK("http://evil")`);
    expect(cs.some((r) => r['Evidence no.'] === nazarbad.evidenceNumber)).toBe(false);
    const aa = records((await run('ACCESS_AUDIT', 'CSV', [central()], { actorId: meeraId })).text);
    const mine = aa.filter((r) => r['Evidence no.'] === cubbon.evidenceNumber).map((r) => r.Action).sort();
    expect(mine).toEqual(['EVIDENCE_DOWNLOADED', 'EVIDENCE_PLAYED', 'EVIDENCE_VIEWED']);
    expect(aa.every((r) => r.Actor === 'Meera Rao')).toBe(true);
  });

  it('RETENTION_COMPLIANCE, INTEGRITY, AI_REVIEW, USER_ACCESS_REVIEW, EXPORT_SHARE_ACTIVITY', async () => {
    const rc = records((await run('RETENTION_COMPLIANCE', 'CSV', [orgs.ksp!.path])).text);
    expect(rc.find((r) => r.Category === 'OVERDUE_RETENTION' && r['Evidence no.'] === cubbon.evidenceNumber)).toBeTruthy();
    expect(rc.find((r) => r.Category === 'LEGAL_HOLD' && r['Evidence no.'] === nazarbad.evidenceNumber)!.Note).toContain('court order');
    const ic = records((await run('INTEGRITY', 'CSV', [central()])).text);
    expect(ic.find((r) => r['Evidence no.'] === cubbon.evidenceNumber)).toMatchObject({ Result: 'OK', 'Expected SHA-256': cubbon.sha256 });
    const ai = records((await run('AI_REVIEW', 'CSV', [central()])).text);
    expect(ai.find((r) => r.Section === 'MODEL' && r['Model / reviewer'] === 'rep-test')).toMatchObject({ Detections: '3', Approved: '1', Rejected: '1', Pending: '1', 'Approval rate %': '50' });
    expect(ai.find((r) => r.Section === 'REVIEWER' && r['Model / reviewer'] === 'sup.kavya')).toMatchObject({ 'Review actions': '2' });
    const ua = records((await run('USER_ACCESS_REVIEW', 'CSV', [central()], { inactiveDays: 30 })).text);
    expect(ua.map((r) => r.Username)).toContain('io.meera');
    expect(ua.map((r) => r.Username)).not.toContain('io.arjun'); // Indiranagar is outside blr_central
    expect(ua.find((r) => r.Username === 'io.meera')!['Role grants']).toContain('INVESTIGATING_OFFICER@ps_cubbonpark');
    expect(ua.find((r) => r.Username === 'io.meera')!['Review flags']).toContain('NO_MFA');
    const es = records((await run('EXPORT_SHARE_ACTIVITY', 'CSV', [central()])).text);
    expect(es.find((r) => r.Kind === 'SHARE' && r.Purpose === 'review footage')).toMatchObject({ 'Created by': 'io.meera', Recipient: 'sup.kavya', Items: '0', Purpose: 'review footage' });
  });

  it('JSON is valid, carries metadata and the same content hash as CSV of the same data', async () => {
    const csv = await run('INTEGRITY', 'CSV', [central()]);
    const json = await run('INTEGRITY', 'JSON', [central()]);
    const doc = JSON.parse(json.text);
    expect(doc.report).toMatchObject({ type: 'INTEGRITY', runId: json.row.id });
    expect(doc.rows).toHaveLength(json.row.row_count!);
    expect(json.row.content_sha256).toBe(csv.row.content_sha256);
    expect(json.row.sha256).toBe(createHash('sha256').update(json.body).digest('hex'));
  });

  it('PDF has header, page X of Y and the content SHA-256 in the footer; Kannada renders as text (FN-9)', async () => {
    await appendAudit(db, { type: 'USER', id: meeraId, name: 'ಮೀರಾ ರಾವ್' }, { action: 'EVIDENCE_VIEWED', resourceType: 'evidence', resourceId: cubbon.id, evidenceId: cubbon.id, orgUnitId: cubbon.orgUnitId });
    const pdf = await run('ACCESS_AUDIT', 'PDF', [orgs.ksp!.path]);
    expect(pdf.res.status).toBe('COMPLETED');
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.row.sha256).toBe(createHash('sha256').update(pdf.body).digest('hex'));
    const text = await pdfText(pdf.body);
    expect(text).toContain('Access audit');
    expect(text).toContain('Generated by: Kavya Hegde (sup.kavya)');
    expect(text).toContain(pdf.row.content_sha256!);
    expect(text).toMatch(/Page 1 of \d+/);
    expect(text).toContain('ಕರ್ನಾಟಕ ರಾಜ್ಯ ಪೊಲೀಸ್'); // header
    expect(text).toContain('ಮೀರಾ ರಾವ್'); // actor name cell
    expect(text).not.toContain('???');
  });

  it('unknown report type fails the run and audits REPORT_FAILED', async () => {
    const r = await db.insertInto('report_runs').values({ report_type: 'NOPE', format: 'CSV', params: JSON.stringify({ scopePaths: [] }), created_by: kavya.id }).returning('id').executeTakeFirstOrThrow();
    const res = await runReportBuild({ db, storage: storage() }, r.id);
    expect(res.status).toBe('FAILED');
    expect((await db.selectFrom('report_runs').select(['status', 'error']).where('id', '=', r.id).executeTakeFirstOrThrow())).toMatchObject({ status: 'FAILED' });
    expect(await db.selectFrom('audit_events').select('seq').where('action', '=', 'REPORT_FAILED').where('resource_id', '=', r.id).executeTakeFirst()).toBeTruthy();
  });

  it('csvCell quoting', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('@SUM(1)')).toBe("'@SUM(1)");
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(null)).toBe('');
  });
});

/** Extract text with poppler's pdftotext (embedded CID fonts + /ActualText for shaped Kannada runs). */
async function pdfText(buf: Buffer): Promise<string> {
  const { execFileSync } = await import('node:child_process');
  return execFileSync('pdftotext', ['-raw', '-', '-'], { input: buf, encoding: 'utf8' }).normalize('NFC');
}
