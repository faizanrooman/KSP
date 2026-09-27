/**
 * REPORT_BUILD handler: materialise a report run (CSV | PDF | JSON) into the reports bucket.
 *
 *  - CSV is streamed row by row straight to object storage (multipart), hashing as it goes.
 *  - JSON is streamed the same way: {"report": {...metadata}, "columns": [...], "rows": [...]}.
 *  - PDF (pdfkit, bundled Noto Sans / Noto Sans Kannada via @ksp/core/custody text helpers): header (force/system, title, parameters, generated-by/at), a paginated table, and on
 *    every page a footer with page X of Y and the content SHA-256. PDFs are capped at PDF_MAX_ROWS rows
 *    (the footer and a banner say so); the full data set is always available as CSV.
 *  - content_sha256 = SHA-256 of the canonical CSV serialisation of ALL rows (identical to the file hash
 *    for CSV runs), so a PDF/JSON can be tied back to the exact data; sha256 = hash of the stored object.
 * The run is idempotent: a COMPLETED run is left untouched; a failed build marks the run FAILED
 * (deterministic failures are not retried).
 */
import { createHash } from 'node:crypto';
import { PassThrough, Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { REPORT_TYPES, type ReportParams, type ReportType } from '@ksp/shared';
import { appendAudit, systemActor, type Database, type Storage } from '@ksp/core';
import { createDoc, drawText, measureText, KSP_KN } from '@ksp/core/custody';
import { REPORT_DEFINITIONS, type Cell, type ReportDefinition, type ReportScope, type Row } from './definitions.js';

export const PDF_MAX_ROWS = 5000;
const ACTOR = systemActor('report-builder');

export interface ReportDeps {
  db: Database;
  storage: Storage;
  log?: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
}

export interface ReportBuildResult {
  status: 'COMPLETED' | 'FAILED' | 'SKIPPED';
  rowCount?: number;
  sha256?: string;
  contentSha256?: string;
  error?: string;
}

// ---- cell formatting ------------------------------------------------------------------------------
export function cellText(v: Cell | undefined): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

/** RFC 4180 quoting + spreadsheet formula-injection neutralisation (leading = + - @ tab CR). */
export function csvCell(v: Cell | undefined): string {
  let s = cellText(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvLine = (cells: Array<Cell | undefined>) => `${cells.map(csvCell).join(',')}\r\n`;

function jsonValue(v: Cell | undefined): unknown {
  if (v instanceof Date) return v.toISOString();
  return v ?? null;
}

// ---- helpers ---------------------------------------------------------------------------------------
function hashTap(h: ReturnType<typeof createHash>, counter: { bytes: number }) {
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      h.update(chunk);
      counter.bytes += chunk.length;
      cb(null, chunk);
    },
  });
}

async function upload(st: Storage, bucket: string, key: string, source: Readable, contentType: string): Promise<{ sha256: string; size: number }> {
  const h = createHash('sha256');
  const counter = { bytes: 0 };
  const body = new PassThrough();
  await Promise.all([st.put(bucket, key, body, { contentType }), pipeline(source, hashTap(h, counter), body)]);
  return { sha256: h.digest('hex'), size: counter.bytes };
}

export function scopeFor(params: ReportParams, orgPath: string | null): ReportScope {
  return {
    paths: orgPath ? [orgPath] : params.scopePaths ?? [],
    from: params.from ? new Date(params.from) : null,
    to: params.to ? new Date(params.to) : null,
    actorId: params.actorId ?? null,
    inactiveDays: params.inactiveDays && params.inactiveDays > 0 ? params.inactiveDays : 90,
  };
}

// ---- renderers -------------------------------------------------------------------------------------
async function renderCsv(def: ReportDefinition, rows: AsyncGenerator<Row>, content: ReturnType<typeof createHash>, count: { n: number }): Promise<Readable> {
  async function* gen() {
    const header = csvLine(def.columns.map((c) => c.header));
    content.update(header);
    yield Buffer.from(header);
    for await (const r of rows) {
      const line = csvLine(def.columns.map((c) => r[c.key]));
      content.update(line);
      count.n++;
      yield Buffer.from(line);
    }
  }
  return Readable.from(gen());
}

async function renderJson(meta: Record<string, unknown>, def: ReportDefinition, rows: AsyncGenerator<Row>, content: ReturnType<typeof createHash>, count: { n: number }): Promise<Readable> {
  async function* gen() {
    content.update(csvLine(def.columns.map((c) => c.header)));
    yield Buffer.from(`{"report":${JSON.stringify(meta)},"columns":${JSON.stringify(def.columns.map((c) => ({ key: c.key, header: c.header })))},"rows":[`);
    let first = true;
    for await (const r of rows) {
      content.update(csvLine(def.columns.map((c) => r[c.key])));
      count.n++;
      const obj = Object.fromEntries(def.columns.map((c) => [c.key, jsonValue(r[c.key])]));
      yield Buffer.from(`${first ? '' : ','}\n${JSON.stringify(obj)}`);
      first = false;
    }
    yield Buffer.from('\n]}\n');
  }
  return Readable.from(gen());
}

interface PdfMeta {
  title: string;
  reportType: string;
  runId: string;
  generatedBy: string;
  generatedAt: string;
  parameters: Array<[string, string]>;
}

/** PDF needs the content hash in every footer, so rows are collected (capped) before rendering. */
async function renderPdf(meta: PdfMeta, def: ReportDefinition, rows: AsyncGenerator<Row>, content: ReturnType<typeof createHash>, count: { n: number }): Promise<Readable> {
  const kept: Row[] = [];
  content.update(csvLine(def.columns.map((c) => c.header)));
  for await (const r of rows) {
    content.update(csvLine(def.columns.map((c) => r[c.key])));
    count.n++;
    if (kept.length < PDF_MAX_ROWS) kept.push(r);
  }
  const contentSha = content.copy().digest('hex');
  const doc = await createDoc({ title: meta.title, author: meta.generatedBy, subject: `KSP VMS report ${meta.reportType}`, layout: def.columns.length > 7 ? 'landscape' : 'portrait', margins: { top: 50, bottom: 60, left: 36, right: 36 }, compress: true });
  const out = new PassThrough();
  doc.pipe(out);
  const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const left = doc.page.margins.left;
  const line = (text: string, size: number, opts: { bold?: boolean; color?: string } = {}) => {
    drawText(doc, text, left, doc.y, { size, width: W, paginate: true, color: opts.color ?? '#222222', bold: opts.bold });
  };

  drawText(doc, `KARNATAKA STATE POLICE (${KSP_KN}) — VIDEO EVIDENCE MANAGEMENT SYSTEM`, left, 30, { size: 9, bold: true, color: '#444444', width: W });
  doc.y += 6;
  line(meta.title, 16, { bold: true, color: '#000000' });
  doc.y += 3;
  line(`Report type: ${meta.reportType}    Run: ${meta.runId}`, 9);
  line(`Generated by: ${meta.generatedBy}    Generated at: ${meta.generatedAt}`, 9);
  line(`Parameters: ${meta.parameters.map(([k, v]) => `${k}=${v}`).join('; ') || 'none'}`, 9);
  line(`Rows: ${count.n}${count.n > kept.length ? ` (PDF shows the first ${kept.length}; download CSV for the full data set)` : ''}`, 9);
  doc.y += 10;

  // Table
  const weights = def.columns.map((c) => c.width ?? 1);
  const total = weights.reduce((a, b) => a + b, 0);
  const widths = weights.map((w) => (w / total) * W);
  const fontSize = def.columns.length > 10 ? 6.5 : 7.5;
  const bottom = () => doc.page.height - doc.page.margins.bottom;
  const drawRow = (cells: string[], bold: boolean) => {
    const heights = cells.map((t, i) => measureText(doc, t, { size: fontSize, bold, width: widths[i]! - 4, maxHeight: 114 }));
    const h = Math.min(Math.max(...heights, fontSize + 2) + 4, 120);
    if (doc.y + h > bottom()) {
      doc.addPage();
      doc.y = doc.page.margins.top;
      if (!bold) drawRow(def.columns.map((c) => c.header), true);
    }
    const y = doc.y;
    if (bold) doc.rect(left, y, W, h).fill('#e8e8e8').fillColor('#000');
    let x = left;
    cells.forEach((t, i) => {
      drawText(doc, t, x + 2, y + 2, { size: fontSize, bold, width: widths[i]! - 4, maxHeight: h - 4 });
      x += widths[i]!;
    });
    doc.moveTo(left, y + h).lineTo(left + W, y + h).lineWidth(0.3).strokeColor('#bbb').stroke();
    doc.y = y + h;
    doc.x = left;
  };
  drawRow(def.columns.map((c) => c.header), true);
  if (!kept.length) drawText(doc, 'No rows match the report parameters within your jurisdiction.', left, doc.y + 6, { size: 9, width: W });
  for (const r of kept) drawRow(def.columns.map((c) => cellText(r[c.key]).slice(0, 400)), false);

  // Footers on every page (page X of Y + content hash)
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const fy = doc.page.height - 42;
    const f = { size: 6.5, color: '#444444', maxHeight: 8 };
    drawText(doc, `CONFIDENTIAL — generated by ${meta.generatedBy} at ${meta.generatedAt} — run ${meta.runId}`, left, fy, { ...f, width: W });
    drawText(doc, `Content SHA-256 (canonical CSV of ${count.n} rows): ${contentSha}`, left, fy + 10, { ...f, width: W - 70 });
    drawText(doc, `Page ${i - range.start + 1} of ${range.count}`, left + W - 70, fy + 10, { ...f, width: 70, align: 'right' });
  }
  doc.end();
  return out;
}

// ---- entry point -----------------------------------------------------------------------------------
export async function runReportBuild(deps: ReportDeps, runId: string): Promise<ReportBuildResult> {
  const { db, storage: st } = deps;
  const run = await db
    .selectFrom('report_runs as r')
    .innerJoin('users as u', 'u.id', 'r.created_by')
    .leftJoin('org_units as o', 'o.id', 'r.org_unit_id')
    .select(['r.id', 'r.report_type', 'r.params', 'r.format', 'r.status', 'r.created_by', 'r.created_at', 'u.full_name', 'u.username', 'o.path as org_path', 'o.code as org_code'])
    .where('r.id', '=', runId)
    .executeTakeFirst();
  if (!run) return { status: 'SKIPPED', error: 'run not found' };
  if (run.status === 'COMPLETED') return { status: 'SKIPPED' };
  const type = run.report_type as ReportType;
  const def = REPORT_DEFINITIONS[type];
  const params = run.params as unknown as ReportParams;
  await db.updateTable('report_runs').set({ status: 'RUNNING', started_at: new Date(), error: null }).where('id', '=', runId).execute();
  try {
    if (!def) throw new Error(`unknown report type ${run.report_type}`);
    const scope = scopeFor(params, run.org_path);
    const generatedAt = new Date().toISOString();
    const generatedBy = `${run.full_name} (${run.username})`;
    const parameters: Array<[string, string]> = [
      ['from', params.from ?? '—'], ['to', params.to ?? '—'], ['orgUnit', run.org_code ?? 'all in jurisdiction'],
      ['jurisdiction', (params.scopePaths ?? []).join(', ') || 'none'],
      ...(params.actorId ? [['actorId', params.actorId] as [string, string]] : []),
      ...(type === 'USER_ACCESS_REVIEW' ? [['inactiveDays', String(scope.inactiveDays)] as [string, string]] : []),
    ];
    const content = createHash('sha256');
    const count = { n: 0 };
    const rows = def.rows(db, scope);
    const ext = run.format.toLowerCase();
    const contentType = run.format === 'CSV' ? 'text/csv; charset=utf-8' : run.format === 'PDF' ? 'application/pdf' : 'application/json';
    const source =
      run.format === 'CSV' ? await renderCsv(def, rows, content, count)
      : run.format === 'JSON' ? await renderJson({ type, title: REPORT_TYPES[type].title, runId, generatedBy, generatedAt, parameters: Object.fromEntries(parameters) }, def, rows, content, count)
      : await renderPdf({ title: REPORT_TYPES[type].title, reportType: type, runId, generatedBy, generatedAt, parameters }, def, rows, content, count);
    const d = new Date(run.created_at);
    const key = `reports/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${runId}.${ext}`;
    const bucket = st.bucket('reports');
    const { sha256, size } = await upload(st, bucket, key, source, contentType);
    const contentSha256 = content.digest('hex');
    await db.transaction().execute(async (tx) => {
      await tx
        .updateTable('report_runs')
        .set({ status: 'COMPLETED', bucket, object_key: key, sha256, content_sha256: contentSha256, size_bytes: size, row_count: count.n, finished_at: new Date(), error: null })
        .where('id', '=', runId)
        .execute();
      await appendAudit(tx, ACTOR, {
        action: 'REPORT_GENERATED', resourceType: 'report_run', resourceId: runId, orgUnitId: null,
        details: { reportType: type, format: run.format, rowCount: count.n, sha256, contentSha256, sizeBytes: size, requestedBy: run.created_by },
      });
    });
    deps.log?.info({ runId, type, rows: count.n, size }, 'report generated');
    return { status: 'COMPLETED', rowCount: count.n, sha256, contentSha256 };
  } catch (e) {
    const message = (e as Error).message.slice(0, 1000);
    await db.transaction().execute(async (tx) => {
      await tx.updateTable('report_runs').set({ status: 'FAILED', error: message, finished_at: new Date() }).where('id', '=', runId).execute();
      await appendAudit(tx, ACTOR, { action: 'REPORT_FAILED', outcome: 'FAILURE', resourceType: 'report_run', resourceId: runId, details: { reportType: run.report_type, format: run.format, error: message } });
    });
    deps.log?.warn({ runId, err: message }, 'report failed');
    return { status: 'FAILED', error: message };
  }
}
