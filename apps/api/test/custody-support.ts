/** Shared helpers for the custody / audit / export / sharing test files. */
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger, runProcess } from '@ksp/core';
import type { Permission } from '@ksp/shared';
import { createUser, getApp } from './helpers.js';
import { createMediaEvidence, type MediaEvidence, type MediaKind } from './fixtures/media-evidence.js';
import { processMedia } from '../../worker/src/jobs/media/process.js';

/** Register + run the real media pipeline (proxy/HLS/poster) for a generated clip. */
export async function processedEvidence(kind: MediaKind = 'h264', org = 'ps_cubbonpark', uploadedBy = 'io.meera'): Promise<MediaEvidence> {
  const app = await getApp();
  const ev = await createMediaEvidence(app.db, app.storage, { kind, org, uploadedBy });
  const r = await processMedia({ db: app.db, storage: app.storage, cfg: app.cfg, log: logger().child({ test: 'custody' }) }, { evidenceId: ev.id });
  if (r.status !== 'READY') throw new Error(`media processing failed: ${JSON.stringify(r)}`);
  return ev;
}

/** A user holding a custom role with exactly `perms` at `org`. */
export async function userWithPerms(perms: Permission[], org = 'ps_cubbonpark'): Promise<{ id: string; username: string }> {
  const app = await getApp();
  const code = `T_${randomUUID().slice(0, 8).toUpperCase()}`;
  await app.db.insertInto('roles').values({ code, name: `Test role ${code}`, description: 'test', permissions: perms, is_system: false } as never).execute();
  return createUser({ role: code, org });
}

/**
 * Extract an embedded file (PDF attachment) from an UNCOMPRESSED pdfkit PDF: the /EmbeddedFile stream whose
 * file-spec name is `name`.
 */
export function pdfAttachment(pdf: Buffer, name: string): Buffer {
  const text = pdf.toString('latin1');
  // File spec: << /Type /Filespec /F (name) ... /EF << /F 12 0 R >> >>
  const specRe = new RegExp(`/F \\(${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)[\\s\\S]*?/EF\\s*<<\\s*/F\\s+(\\d+)\\s+0\\s+R`);
  const m = specRe.exec(text);
  if (!m) throw new Error(`attachment ${name} not found`);
  const objRe = new RegExp(`(?:^|\\n)${m[1]} 0 obj\\s*<<([\\s\\S]*?)>>\\s*stream\\n`);
  const o = objRe.exec(text);
  if (!o) throw new Error(`attachment object ${m[1]} not found`);
  const len = /\/Length (\d+)/.exec(o[1]!);
  if (!len) throw new Error('attachment length missing');
  const start = o.index + o[0].length;
  return pdf.subarray(start, start + Number(len[1]));
}

export async function tmpDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/** Run the openssl verification commands we print for recipients; returns combined output of the verify step. */
export async function opensslVerify(dir: string, files: { data: string; sig: string; cert: string }, contents: { data: Buffer; sig: Buffer; cert: string }): Promise<{ code: number; out: string }> {
  await writeFile(join(dir, files.data), contents.data);
  await writeFile(join(dir, files.sig), contents.sig);
  await writeFile(join(dir, files.cert), contents.cert);
  const pub = join(dir, 'pub.pem');
  const x = await runProcess('openssl', ['x509', '-in', join(dir, files.cert), '-pubkey', '-noout']);
  await writeFile(pub, x.stdout);
  const v = await runProcess('openssl', ['dgst', '-sha256', '-verify', pub, '-signature', join(dir, files.sig), join(dir, files.data)]);
  return { code: v.code, out: `${v.stdout}${v.stderr}` };
}

export async function auditRows(filter: { evidenceId?: string; action?: string; resourceId?: string }) {
  const app = await getApp();
  let q = app.db.selectFrom('audit_events').selectAll();
  if (filter.evidenceId) q = q.where('evidence_id', '=', filter.evidenceId);
  if (filter.action) q = q.where('action', '=', filter.action);
  if (filter.resourceId) q = q.where('resource_id', '=', filter.resourceId);
  return q.orderBy('seq').execute();
}
