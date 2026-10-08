/**
 * Measure a model version's accuracy on a labelled dataset with the production detectors (tender §16) and, optionally,
 * record the result on the model (ai_models.metrics.kspEvaluation; audited AI_MODEL_UPDATED).
 *
 *   npm run evaluate -w @ksp/ai-worker -- --task PERSON_DETECTION --dataset ./eval/persons [--iou 0.5] [--out report.json] [--register]
 *   npm run evaluate -w @ksp/ai-worker -- --task FACE_DETECTION  --dataset ./eval/faces --label-map face=face
 *   npm run evaluate -w @ksp/ai-worker -- --task FACE_RECOGNITION --pairs ./eval/pairs.json
 *   npm run evaluate -w @ksp/ai-worker -- --task ANPR --plates ./eval/plates.json
 *
 * Model selection: the ACTIVE model of the task, or --model-code <code> [--model-version <v>].
 * Dataset formats are documented in src/evaluate.ts; the training-dataset export (COCO) can be used directly, which is
 * how accuracy on KSP's own reviewed footage is measured.
 */
import { writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { sql } from 'kysely';
import { appendAudit, createDb, loadConfig, systemActor } from '@ksp/core';
import type { AiTask } from '@ksp/shared';
import { evaluateDetector, evaluateFaceVerification, evaluatePlates, loadDataset, MIN_THRESHOLD, reportSummary, type FacePair, type PlateItem } from '../src/evaluate.js';
import { anprDetector, baseDetector, FilteredDetector, type Detector, type ModelRow } from '../src/models/index.js';
import { SfaceEmbedder } from '../src/models/sface.js';

const argv = process.argv.slice(2);
const opt = (name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const flag = (name: string) => argv.includes(`--${name}`);
const task = opt('task') as AiTask | undefined;
if (!task) { console.error('usage: --task <AI task> (--dataset <dir>|--pairs <file>|--plates <file>) [--model-code X --model-version Y] [--iou 0.5] [--out f.json] [--register]'); process.exit(2); }
const labelMap = Object.fromEntries((opt('label-map') ?? '').split(',').filter(Boolean).map((kv) => kv.split('=') as [string, string]));

const cfg = loadConfig();
const { db } = createDb(cfg.DATABASE_URL, 2);
try {
  const pick = async (t: AiTask, code?: string, version?: string): Promise<ModelRow> => {
    let q = db.selectFrom('ai_models').selectAll().where('task', '=', t);
    q = code ? q.where('code', '=', code) : q.where('status', '=', 'ACTIVE');
    if (version) q = q.where('version', '=', version);
    const m = (await q.orderBy('created_at', 'desc').executeTakeFirst()) as unknown as ModelRow | undefined;
    if (!m) throw new Error(`no ${code ? `${code}${version ? '@' + version : ''}` : 'ACTIVE'} model for ${t} (run fetch-models or register one)`);
    return m;
  };
  const m = await pick(task, opt('model-code'), opt('model-version'));
  const detectorFor = (row: ModelRow): Detector => {
    if (row.task === 'ANPR') return anprDetector(row, []);
    if (row.task === 'CLASSIFICATION') throw new Error('CLASSIFICATION is a deterministic rule set over detector output; evaluate the underlying OBJECT_DETECTION model');
    return new FilteredDetector(row, baseDetector(row), () => MIN_THRESHOLD);
  };
  const progress = (done: number, total: number) => { if (done % 25 === 0 || done === total) console.log(`  ${done}/${total} images`); };

  let report;
  if (task === 'FACE_RECOGNITION') {
    const pairsFile = opt('pairs'); if (!pairsFile) throw new Error('--pairs <pairs.json> is required for FACE_RECOGNITION');
    const file = JSON.parse(await readFile(pairsFile, 'utf8')) as { name?: string; pairs: FacePair[] };
    const fd = await pick('FACE_DETECTION');
    const embedder = Object.assign(new SfaceEmbedder(m), { modelId: m.id, code: m.code, version: m.version });
    console.log(`evaluating ${m.code}@${m.version} (face detector ${fd.code}@${fd.version}) on ${file.pairs.length} pairs…`);
    report = await evaluateFaceVerification(detectorFor(fd), embedder, file.pairs, dirname(resolve(pairsFile)), { threshold: Number(opt('threshold') ?? m.default_threshold), name: file.name });
  } else if (task === 'ANPR') {
    const platesFile = opt('plates'); if (!platesFile) throw new Error('--plates <plates.json> is required for ANPR');
    const file = JSON.parse(await readFile(platesFile, 'utf8')) as { name?: string; items: PlateItem[] };
    console.log(`evaluating ${m.code}@${m.version} on ${file.items.length} plate images…`);
    report = await evaluatePlates(detectorFor(m), file.items, dirname(resolve(platesFile)), { threshold: Number(opt('threshold') ?? m.default_threshold), name: file.name });
  } else {
    const dir = opt('dataset'); if (!dir) throw new Error('--dataset <dir|annotations.json> is required');
    const ds = await loadDataset(dir, labelMap);
    console.log(`evaluating ${m.code}@${m.version} on "${ds.name}": ${ds.images.length} images, labels ${ds.labels.join(', ')}…`);
    report = await evaluateDetector(detectorFor(m), ds, { defaultThreshold: Number(opt('threshold') ?? m.default_threshold), iouMin: Number(opt('iou') ?? 0.5), labelMap, onImage: progress });
  }

  const summary = reportSummary(report);
  console.log('\nSummary (recorded on the model with --register):');
  for (const [k, v] of Object.entries(summary)) console.log(`  ${k.padEnd(20)} ${typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(4)) : String(v)}`);
  if (report.kind === 'detection') {
    console.log('\nthreshold  precision  recall   F1      img-FPR  FNR');
    for (const s of report.sweep) console.log(`  ${s.threshold.toFixed(2)}      ${f(s.precision)}     ${f(s.recall)}   ${f(s.f1)}   ${f(s.falsePositiveRate)}    ${f(s.falseNegativeRate)}`);
    if (report.skipped.length) console.log(`\n${report.skipped.length} image(s) could not be decoded: ${report.skipped.map((s) => s.file).join(', ')}`);
  }
  const out = opt('out') ?? `evaluation-${task}-${new Date().toISOString().slice(0, 10)}.json`;
  await writeFile(out, JSON.stringify(report, null, 2));
  console.log(`\nfull report: ${out}`);

  if (flag('register')) {
    await db.transaction().execute(async (tx) => {
      await sql`UPDATE ai_models SET metrics = metrics || jsonb_build_object('kspEvaluation', ${JSON.stringify(summary)}::jsonb) WHERE id = ${m.id}::uuid`.execute(tx);
      await appendAudit(tx, systemActor('evaluate-model'), { action: 'AI_MODEL_UPDATED', resourceType: 'ai_model', resourceId: m.id, details: { code: m.code, version: m.version, task: m.task, kspEvaluation: summary } });
    });
    console.log(`recorded on ${m.code}@${m.version} (ai_models.metrics.kspEvaluation; audited)`);
  }
} finally {
  await db.destroy();
}

function f(v: number | null): string { return v === null ? '  –  ' : v.toFixed(3); }
