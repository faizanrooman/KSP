/**
 * Build a labelled training dataset from human-reviewed AI detections (owned by the AI workstream).
 * Output (reports bucket, prefix ai-training/<exportId>/): dataset.jsonl, coco.json, crops/<detectionId>.jpg,
 * manifest.json (SHA-256 of every file). Positives = APPROVED or label-corrected; negatives = REJECTED.
 * Embeddings are never exported.
 */
import { sql } from 'kysely';
import { appendAudit, sha256Hex, systemActor, type Database, type Storage } from '@ksp/core';
import type { Logger } from 'pino';

export interface TrainingDeps {
  db: Database;
  storage: Storage;
  log: Logger;
}

const MAX_SAMPLES = 50_000;

/** Width/height from a baseline/progressive JPEG SOF marker. */
export function jpegSize(buf: Buffer): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1]!;
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

export async function runTrainingExport(deps: TrainingDeps, exportId: string): Promise<void> {
  const { db, storage, log } = deps;
  const actor = systemActor('worker:ai-training');
  const exp = await db.selectFrom('ai_training_exports').selectAll().where('id', '=', exportId).executeTakeFirst();
  if (!exp || exp.status === 'COMPLETED') return;
  await db.updateTable('ai_training_exports').set({ status: 'RUNNING', error: null }).where('id', '=', exportId).execute();
  try {
    const f = exp.filter as { from: string; to: string; orgPaths: string[] };
    if (!f.orgPaths?.length) throw new Error('export has no jurisdiction scope');
    let q = db.selectFrom('ai_detections as d').innerJoin('evidence as e', 'e.id', 'd.evidence_id')
      .select(['d.id', 'd.evidence_id', 'e.org_unit_id', 'd.task', 'd.label', 'd.corrected_label', 'd.review_status', 'd.confidence', 'd.threshold', 'd.model_code', 'd.model_version',
        'd.frame_time_ms', 'd.bbox_x', 'd.bbox_y', 'd.bbox_w', 'd.bbox_h', 'd.attributes', 'd.crop_key', 'd.reviewed_at', 'd.created_at'])
      .where('d.task', '=', exp.task)
      .where('d.created_at', '>=', new Date(f.from)).where('d.created_at', '<', new Date(f.to))
      .where((eb) => eb.or([eb('d.review_status', 'in', ['APPROVED', 'REJECTED']), eb('d.corrected_label', 'is not', null)]))
      .where(sql<boolean>`e.org_path <@ ${sql.val(f.orgPaths)}::ltree[]`)
      .where('e.status', '<>', 'DISPOSED');
    if (exp.model_id) q = q.where('d.model_id', '=', exp.model_id);
    const rows = await q.orderBy('d.created_at').limit(MAX_SAMPLES).execute();

    const bucket = storage.bucket('reports');
    const prefix = `ai-training/${exportId}/`;
    const derived = storage.bucket('derived');
    const files: Array<{ name: string; sha256: string; bytes: number }> = [];
    const put = async (name: string, body: Buffer, contentType: string) => {
      await storage.put(bucket, `${prefix}${name}`, body, { contentType });
      files.push({ name, sha256: sha256Hex(body), bytes: body.length });
    };
    const lines: string[] = [];
    const categories = new Map<string, number>();
    const images: unknown[] = [];
    const annotations: unknown[] = [];
    let positives = 0, negatives = 0, crops = 0;
    for (const [i, r] of rows.entries()) {
      const negative = r.review_status === 'REJECTED' && !r.corrected_label;
      const label = r.corrected_label ?? r.label;
      let cropName: string | null = null;
      let size: { width: number; height: number } | null = null;
      if (r.crop_key) {
        try {
          const buf = await storage.getBuffer(derived, r.crop_key);
          cropName = `crops/${r.id}.jpg`;
          size = jpegSize(buf);
          await put(cropName, buf, 'image/jpeg');
          crops++;
        } catch (err) {
          log.warn({ err, detectionId: r.id }, 'crop missing for training sample');
        }
      }
      const { observations: _o, sampleIndex: _s, cocoClass: _c, ...attributes } = (r.attributes ?? {}) as Record<string, unknown>;
      lines.push(JSON.stringify({
        detectionId: r.id, evidenceId: r.evidence_id, task: r.task, label, originalLabel: r.label, sample: negative ? 'negative' : 'positive',
        reviewStatus: r.review_status, confidence: r.confidence, threshold: r.threshold, model: { code: r.model_code, version: r.model_version },
        frameTimeMs: Number(r.frame_time_ms), bbox: r.bbox_x === null ? null : { x: r.bbox_x, y: r.bbox_y, w: r.bbox_w, h: r.bbox_h },
        attributes, crop: cropName, reviewedAt: r.reviewed_at,
      }));
      if (negative) negatives++;
      else positives++;
      if (cropName && size) {
        if (!negative && !categories.has(label)) categories.set(label, categories.size + 1);
        images.push({ id: i + 1, file_name: cropName, width: size.width, height: size.height, ksp_detection_id: r.id });
        if (!negative) annotations.push({ id: annotations.length + 1, image_id: i + 1, category_id: categories.get(label), bbox: [0, 0, size.width, size.height], area: size.width * size.height, iscrowd: 0 });
      }
    }
    await put('dataset.jsonl', Buffer.from(lines.join('\n') + (lines.length ? '\n' : '')), 'application/x-ndjson');
    await put('coco.json', Buffer.from(JSON.stringify({
      info: { description: `KSP reviewed AI detections (${exp.task})`, version: exportId, date_created: new Date().toISOString(), note: 'Images are detection crops (10% margin); negatives are images without annotations.' },
      images, annotations, categories: [...categories.entries()].map(([name, id]) => ({ id, name })),
    })), 'application/json');
    const manifest = { exportId, task: exp.task, modelId: exp.model_id, filter: f, createdAt: new Date().toISOString(), counts: { samples: rows.length, positives, negatives, crops }, truncated: rows.length >= MAX_SAMPLES, files };
    await storage.put(bucket, `${prefix}manifest.json`, Buffer.from(JSON.stringify(manifest, null, 2)), { contentType: 'application/json' });

    const evidence = new Map<string, string>();
    for (const r of rows) evidence.set(r.evidence_id, r.org_unit_id);
    await db.transaction().execute(async (tx) => {
      await tx.updateTable('ai_training_exports').set({ status: 'COMPLETED', sample_count: rows.length, bucket, object_key: prefix, finished_at: new Date() }).where('id', '=', exportId).execute();
      for (const [evidenceId, orgUnitId] of evidence) {
        await appendAudit(tx, actor, { action: 'AI_TRAINING_EXPORTED', resourceType: 'ai_training_export', resourceId: exportId, evidenceId, orgUnitId, details: { task: exp.task } });
      }
      await appendAudit(tx, actor, { action: 'AI_TRAINING_EXPORTED', resourceType: 'ai_training_export', resourceId: exportId, details: { task: exp.task, samples: rows.length, positives, negatives, evidenceItems: evidence.size, manifestSha256: sha256Hex(JSON.stringify(manifest, null, 2)) } });
    });
  } catch (err) {
    log.error({ err, exportId }, 'training export failed');
    await db.updateTable('ai_training_exports').set({ status: 'FAILED', error: (err as Error).message.slice(0, 1000), finished_at: new Date() }).where('id', '=', exportId).execute();
  }
}
