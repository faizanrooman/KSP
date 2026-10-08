/**
 * AI job pipeline (runs as ksp_ai). Claims QUEUED jobs with FOR UPDATE SKIP LOCKED, reads ONLY the derived proxy
 * named in the job's input snapshot, runs the requested detectors on sampled frames, tracks/dedupes, writes crops to
 * the derived bucket under evidence/<evidenceId>/ai/<jobId>/ and inserts PENDING detections (never reviewed state).
 */
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline as streamPipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { appendAudit, sql, systemActor, type AuditActor } from '@ksp/core';
import { normalizePlate, type AiJobInput, type AiJobParams, type AiJobStats, type AiTask } from '@ksp/shared';
import type { AiContext } from './context.js';
import { SfaceEmbedder } from './models/sface.js';
import { FaceEmbeddingDetector } from './models/face-embedding.js';
import { analysisSize, sampleFrames, videoInfo } from './frames.js';
import { crop, encodeJpeg, type Box, type RgbImage } from './image.js';
import { anprDetector, baseDetector, faceRecognitionDetector, FilteredDetector, MemoDetector, type Detector, type ModelRow, type RawDetection } from './models/index.js';
import type { GalleryEntry } from './models/sface.js';
import type { PlateWatch } from './models/anpr.js';
import { IouTracker, type Emitted } from './tracker.js';
import { aiMetrics } from './metrics.js';

export interface ClaimedJob {
  id: string;
  evidence_id: string;
  tasks: AiTask[];
  input: AiJobInput;
  params: Partial<AiJobParams>;
  model_ids: string[];
  /** Seconds the job waited in QUEUED before this claim. */
  queue_wait_seconds?: number;
}

export class JobError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'JobError';
  }
}

class Cancelled extends Error {}

const actorOf = (ctx: AiContext): AuditActor => systemActor(ctx.workerName);

/** Claim the oldest QUEUED job (or null). Marks it RUNNING and writes AI_ANALYSIS_STARTED in the same tx. */
export async function claimJob(ctx: AiContext): Promise<ClaimedJob | null> {
  return ctx.db.transaction().execute(async (tx) => {
    const { rows } = await sql<ClaimedJob>`
      UPDATE ai_jobs SET status = 'RUNNING', started_at = now(), progress = 0,
             stats = jsonb_build_object('heartbeatAt', now(), 'worker', ${ctx.workerName}::text)
       WHERE id = (SELECT id FROM ai_jobs WHERE status = 'QUEUED' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING id, evidence_id, tasks, input, params, model_ids, extract(epoch FROM now() - created_at)::float8 AS queue_wait_seconds`.execute(tx);
    const job = rows[0];
    if (!job) return null;
    await appendAudit(tx, actorOf(ctx), {
      action: 'AI_ANALYSIS_STARTED', resourceType: 'ai_job', resourceId: job.id, evidenceId: job.evidence_id,
      orgUnitId: job.input.orgUnitId ?? null, details: { tasks: job.tasks, modelIds: job.model_ids },
    });
    return job;
  });
}

interface Pending {
  id: string;
  task: AiTask;
  model: ModelRow;
  threshold: number;
  det: RawDetection;
  timeMs: number;
  frameIndex: number;
  trackId: string | null;
  crop: RgbImage | null;
  observations: number;
}

interface TaskRun {
  task: AiTask;
  model: ModelRow;
  detector: Detector;
  threshold: number;
  store: boolean;
  tracker: IouTracker<{ det: RawDetection; crop: RgbImage | null }>;
}

const DEFAULTS: AiJobParams = { sampleFps: 1, thresholds: {}, watchlistIds: [], keepEveryMs: 10_000, crowdMinPersons: 8 };
const VEHICLES = ['car', 'truck', 'bus', 'motorcycle', 'bicycle'];

export async function runJob(ctx: AiContext, job: ClaimedJob, opts: { signal?: AbortSignal } = {}): Promise<'COMPLETED' | 'FAILED' | 'CANCELLED'> {
  const started = Date.now();
  const log = ctx.log.child({ jobId: job.id });
  const params: AiJobParams = { ...DEFAULTS, ...job.params, thresholds: { ...(job.params.thresholds ?? {}) } };
  const workDir = join(ctx.cfg.WORK_DIR, 'ai', job.id);
  const abort = new AbortController();
  opts.signal?.addEventListener('abort', () => abort.abort(), { once: true });
  const stats: AiJobStats & Record<string, unknown> = { framesProcessed: 0, detections: {}, rawDetections: 0, worker: ctx.workerName };
  try {
    // ---- models ---------------------------------------------------------------------------------------------
    const models = (await ctx.db.selectFrom('ai_models').selectAll().where('id', 'in', job.model_ids.length ? job.model_ids : ['00000000-0000-0000-0000-000000000000']).execute()) as unknown as ModelRow[];
    const byTask = new Map<AiTask, ModelRow>();
    for (const m of models) byTask.set(m.task, m);
    const needed = new Set<AiTask>(job.tasks);
    if (needed.has('FACE_RECOGNITION')) needed.add('FACE_DETECTION');
    if (needed.has('CLASSIFICATION') && !byTask.has('OBJECT_DETECTION') && byTask.has('PERSON_DETECTION')) needed.add('PERSON_DETECTION');
    else if (needed.has('CLASSIFICATION')) needed.add('OBJECT_DETECTION');
    for (const t of needed) if (!byTask.get(t)) throw new JobError('MODEL_MISSING', `no model supplied for task ${t}`);

    const thr = (t: AiTask) => params.thresholds[t] ?? byTask.get(t)!.default_threshold;
    // Shared base inference per artefact (e.g. PERSON + OBJECT on one COCO model; face det shared with recognition).
    const bases = new Map<string, { det: MemoDetector; users: AiTask[] }>();
    const baseFor = (m: ModelRow, task: AiTask): MemoDetector => {
      const key = `${m.artifact_uri}#${m.artifact_sha256}`;
      let b = bases.get(key);
      if (!b) {
        const colorLabels = [...new Set(models.filter((x) => x.artifact_uri === m.artifact_uri).flatMap((x) => x.config.colorLabels ?? []))];
        b = { det: new MemoDetector(baseDetector({ ...m, config: { ...m.config, colorLabels } })), users: [] };
        bases.set(key, b);
      }
      b.users.push(task);
      return b.det;
    };
    const minThrFor = (key: string) => () => Math.min(...(bases.get(key)?.users ?? []).map(thr));

    // Watchlists snapshot (ids chosen & authorised by the API).
    const wlIds = params.watchlistIds.length ? params.watchlistIds : ['00000000-0000-0000-0000-000000000000'];
    const entries = await ctx.db
      .selectFrom('ai_watchlist_entries as e')
      .innerJoin('ai_watchlists as w', 'w.id', 'e.watchlist_id')
      .select(['e.id', 'e.watchlist_id', 'e.label', 'e.embedding', 'e.model_id', 'e.plate_normalized', 'w.kind'])
      .where('e.watchlist_id', 'in', wlIds)
      .execute();

    const recognitionModel = needed.has('FACE_DETECTION') && !needed.has('FACE_RECOGNITION')
      ? ((await ctx.db.selectFrom('ai_models').selectAll().where('task', '=', 'FACE_RECOGNITION').where('status', '=', 'ACTIVE').executeTakeFirst()) as unknown as ModelRow | undefined)
      : undefined;
    const runs: TaskRun[] = [];
    const emitted: Pending[] = [];
    const mkTracker = (task: AiTask, model: ModelRow, threshold: number) =>
      new IouTracker<{ det: RawDetection; crop: RgbImage | null }>({ minIou: 0.3, maxGapFrames: 2, keepEveryMs: params.keepEveryMs, prefix: `${task.slice(0, 3).toLowerCase()}-` }, (e: Emitted<{ det: RawDetection; crop: RgbImage | null }>) => {
        emitted.push({ id: randomUUID(), task, model, threshold, det: e.item.payload.det, timeMs: e.item.timeMs, frameIndex: e.item.frameIndex, trackId: e.trackId, crop: e.item.payload.crop, observations: e.observations });
      });
    for (const task of needed) {
      if (task === 'CLASSIFICATION') continue;
      const m = byTask.get(task)!;
      let detector: Detector;
      if (task === 'PERSON_DETECTION' || task === 'OBJECT_DETECTION' || task === 'FACE_DETECTION') {
        const key = `${m.artifact_uri}#${m.artifact_sha256}`;
        detector = new FilteredDetector(m, baseFor(m, task), minThrFor(key));
        if (task === 'FACE_DETECTION' && recognitionModel) {
          // Tender §20 (repository-wide suspect search): every detected face is embedded with the active recognition
          // model so it can be matched later — no identity is claimed here; the embedding is just stored.
          detector = new FaceEmbeddingDetector(detector, new SfaceEmbedder(recognitionModel), recognitionModel.id);
          stats.faceEmbeddingModel = `${recognitionModel.code}@${recognitionModel.version}`;
        }
      } else if (task === 'FACE_RECOGNITION') {
        const gallery: GalleryEntry[] = entries
          .filter((e) => e.kind === 'FACE' && e.embedding && e.model_id === m.id)
          .map((e) => ({ entryId: e.id, watchlistId: e.watchlist_id, label: e.label, embedding: Float32Array.from(e.embedding as number[]) }));
        stats.galleryEntries = gallery.length;
        const fd = byTask.get('FACE_DETECTION')!;
        const faceBase = new FilteredDetector(fd, baseFor(fd, 'FACE_DETECTION'), minThrFor(`${fd.artifact_uri}#${fd.artifact_sha256}`));
        detector = faceRecognitionDetector(m, faceBase, gallery, thr('FACE_DETECTION'));
      } else if (task === 'ANPR') {
        const watch: PlateWatch[] = entries
          .filter((e) => e.kind === 'VEHICLE' && e.plate_normalized)
          .map((e) => ({ entryId: e.id, watchlistId: e.watchlist_id, label: e.label, plate: normalizePlate(e.plate_normalized!) }));
        detector = anprDetector(m, watch);
      } else {
        throw new JobError('UNSUPPORTED_TASK', `task ${task} not supported`);
      }
      runs.push({ task, model: m, detector, threshold: thr(task), store: job.tasks.includes(task), tracker: mkTracker(task, m, thr(task)) });
    }
    for (const r of runs) await r.detector.load();

    // ---- proxy (derived bucket only) ------------------------------------------------------------------------
    const derived = ctx.storage.bucket('derived');
    if (job.input.derivativeBucket !== derived) throw new JobError('INPUT_NOT_DERIVED', 'job input is not in the derived bucket; refusing');
    if (!job.input.derivativeKey?.startsWith(`evidence/${job.evidence_id}/`)) throw new JobError('INPUT_KEY_MISMATCH', 'derivative key does not belong to the job evidence');
    const head = await ctx.storage.head(derived, job.input.derivativeKey);
    if (!head) throw new JobError('PROXY_NOT_FOUND', 'proxy derivative not found in derived storage');
    await mkdir(workDir, { recursive: true });
    const local = join(workDir, 'proxy.mp4');
    await streamPipeline((await ctx.storage.getStream(derived, job.input.derivativeKey)) as Readable, createWriteStream(local));
    const info = await videoInfo(local);
    const size = analysisSize(info.width, info.height);
    const fps = Math.min(5, Math.max(0.1, params.sampleFps));
    const frameRate = job.input.frameRate ?? info.frameRate;
    const framesTotal = Math.max(1, Math.ceil((info.durationMs / 1000) * fps));
    Object.assign(stats, { framesTotal, sampleFps: fps, analysisWidth: size.width, analysisHeight: size.height, sourceDurationMs: info.durationMs });

    // CLASSIFICATION evidence (from the object/person detector output)
    const cls = { maxPersons: 0, maxPersonsFrameMs: 0, maxPersonsConf: 0, crowdCrop: null as RgbImage | null, best: new Map<string, { conf: number; timeMs: number; crop: RgbImage | null; count: number }>() };
    const clsSource = job.tasks.includes('CLASSIFICATION') ? runs.find((r) => r.task === 'OBJECT_DETECTION') ?? runs.find((r) => r.task === 'PERSON_DETECTION') : undefined;
    const clsModel = byTask.get('CLASSIFICATION');
    const rules = clsModel?.config.rules ?? { vehicleLabels: VEHICLES, weaponLabels: ['knife', 'scissors', 'baseball bat'], crowdMinPersons: 8, minTrackDetections: 1 };
    const crowdMin = job.params.crowdMinPersons ?? rules.crowdMinPersons;

    // ---- frame loop -----------------------------------------------------------------------------------------
    let lastBeat = 0;
    let inferMs = 0;
    const flush = async () => {
      const batch = emitted.splice(0, emitted.length);
      await insertDetections(ctx, job, batch, frameRate, size, stats);
    };
    for await (const frame of sampleFrames(local, { fps, width: size.width, height: size.height, signal: abort.signal })) {
      const t0 = Date.now();
      for (const r of runs) {
        const ti = performance.now();
        const dets = await r.detector.detect(frame.image, r.threshold);
        aiMetrics.inference.observe({ model: r.model.code, task: r.task }, (performance.now() - ti) / 1000);
        stats.rawDetections = (stats.rawDetections ?? 0) + dets.length;
        if (r === clsSource) observeClassification(cls, dets, frame.image, frame.timeMs, rules);
        if (!r.store) continue;
        r.tracker.update(frame.index, dets.map((d) => ({ trackClass: d.trackClass ?? d.label, box: d.box, confidence: d.confidence, frameIndex: frame.index, timeMs: frame.timeMs, payload: { det: d, crop: cropFor(frame.image, d.box) } })));
      }
      inferMs += Date.now() - t0;
      stats.framesProcessed = frame.index + 1;
      aiMetrics.frames.inc();
      if (Date.now() - lastBeat > 1500) {
        lastBeat = Date.now();
        stats.msPerFrame = Math.round(inferMs / stats.framesProcessed);
        const alive = await heartbeat(ctx, job.id, Math.min(0.99, stats.framesProcessed / framesTotal), stats);
        if (!alive) throw new Cancelled();
        await flush();
      }
      if (abort.signal.aborted) throw new Cancelled();
    }
    for (const r of runs) if (r.store) r.tracker.finish();
    await flush();

    if (clsSource && clsModel) {
      const threshold = thr('CLASSIFICATION');
      const tags: Array<{ tag: string; conf: number; timeMs: number; crop: RgbImage | null; basis: Record<string, unknown> }> = [];
      const pick = (labels: string[]) => [...cls.best.entries()].filter(([l, v]) => labels.includes(l) && v.count >= rules.minTrackDetections).sort((a, b) => b[1].conf - a[1].conf)[0];
      const person = pick(['person']);
      if (person) tags.push({ tag: 'person', conf: person[1].conf, timeMs: person[1].timeMs, crop: person[1].crop, basis: { label: 'person', observations: person[1].count } });
      const veh = pick(rules.vehicleLabels);
      if (veh) tags.push({ tag: 'vehicle', conf: veh[1].conf, timeMs: veh[1].timeMs, crop: veh[1].crop, basis: { label: veh[0], observations: veh[1].count } });
      for (const w of rules.weaponLabels) {
        const hit = pick([w]);
        if (hit) tags.push({ tag: `weapon:${w.replace(/\s+/g, '-')}`, conf: hit[1].conf, timeMs: hit[1].timeMs, crop: hit[1].crop, basis: { label: w, observations: hit[1].count } });
      }
      if (cls.maxPersons >= crowdMin) tags.push({ tag: 'crowd', conf: cls.maxPersonsConf, timeMs: cls.maxPersonsFrameMs, crop: cls.crowdCrop, basis: { maxPersonsInFrame: cls.maxPersons, crowdMinPersons: crowdMin } });
      for (const t of tags) {
        if (t.conf < threshold) continue;
        emitted.push({
          id: randomUUID(), task: 'CLASSIFICATION', model: clsModel, threshold, timeMs: t.timeMs, frameIndex: Math.round((t.timeMs / 1000) * fps), trackId: null, crop: t.crop, observations: 1,
          det: { label: t.tag, confidence: t.conf, box: { x1: 0, y1: 0, x2: 0, y2: 0 }, attributes: { tag: t.tag, basis: t.basis, sourceModel: `${clsSource.model.code}@${clsSource.model.version}` } },
        });
      }
      await flush();
    }

    stats.wallMs = Date.now() - started;
    stats.msPerFrame = stats.framesProcessed ? Math.round(inferMs / stats.framesProcessed) : 0;
    const done = await ctx.db.transaction().execute(async (tx) => {
      const { rows } = await sql<{ id: string }>`
        UPDATE ai_jobs SET status = 'COMPLETED', progress = 1, finished_at = now(), stats = ${JSON.stringify({ ...stats, heartbeatAt: new Date().toISOString() })}::jsonb
         WHERE id = ${job.id}::uuid AND status = 'RUNNING' RETURNING id`.execute(tx);
      if (!rows.length) return false;
      await appendAudit(tx, actorOf(ctx), {
        action: 'AI_ANALYSIS_COMPLETED', resourceType: 'ai_job', resourceId: job.id, evidenceId: job.evidence_id, orgUnitId: job.input.orgUnitId ?? null,
        details: { tasks: job.tasks, detections: stats.detections, framesProcessed: stats.framesProcessed, msPerFrame: stats.msPerFrame },
      });
      return true;
    });
    log.info({ stats }, done ? 'ai job completed' : 'ai job finished after cancellation');
    return done ? 'COMPLETED' : 'CANCELLED';
  } catch (err) {
    abort.abort();
    const now = await ctx.db.selectFrom('ai_jobs').select('status').where('id', '=', job.id).executeTakeFirst().catch(() => undefined);
    if (err instanceof Cancelled || now?.status === 'CANCELLED') {
      log.info('ai job cancelled; stopped');
      return 'CANCELLED';
    }
    const message = err instanceof JobError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err);
    log.warn({ err }, 'ai job failed');
    await ctx.db.transaction().execute(async (tx) => {
      const { rows } = await sql<{ id: string }>`
        UPDATE ai_jobs SET status = 'FAILED', finished_at = now(), error = ${message.slice(0, 2000)}, stats = ${JSON.stringify(stats)}::jsonb
         WHERE id = ${job.id}::uuid AND status = 'RUNNING' RETURNING id`.execute(tx);
      if (!rows.length) return;
      await appendAudit(tx, actorOf(ctx), {
        action: 'AI_ANALYSIS_FAILED', outcome: 'FAILURE', resourceType: 'ai_job', resourceId: job.id, evidenceId: job.evidence_id,
        orgUnitId: job.input.orgUnitId ?? null, details: { tasks: job.tasks, error: message.slice(0, 500) },
      });
    });
    return 'FAILED';
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function cropFor(img: RgbImage, box: Box): RgbImage | null {
  if (box.x2 - box.x1 < 2 || box.y2 - box.y1 < 2) return null;
  return crop(img, box, 0.1);
}

function observeClassification(
  cls: { maxPersons: number; maxPersonsFrameMs: number; maxPersonsConf: number; crowdCrop: RgbImage | null; best: Map<string, { conf: number; timeMs: number; crop: RgbImage | null; count: number }> },
  dets: RawDetection[],
  frame: RgbImage,
  timeMs: number,
  rules: { vehicleLabels: string[]; weaponLabels: string[] },
): void {
  const persons = dets.filter((d) => d.label === 'person');
  if (persons.length > cls.maxPersons) {
    cls.maxPersons = persons.length;
    cls.maxPersonsFrameMs = timeMs;
    cls.maxPersonsConf = persons.reduce((a, d) => a + d.confidence, 0) / persons.length;
    cls.crowdCrop = { ...frame, data: new Uint8Array(frame.data) };
  }
  for (const d of dets) {
    if (d.label !== 'person' && !rules.vehicleLabels.includes(d.label) && !rules.weaponLabels.includes(d.label)) continue;
    const cur = cls.best.get(d.label);
    if (!cur) cls.best.set(d.label, { conf: d.confidence, timeMs, crop: cropFor(frame, d.box), count: 1 });
    else {
      cur.count++;
      if (d.confidence > cur.conf) Object.assign(cur, { conf: d.confidence, timeMs, crop: cropFor(frame, d.box) });
    }
  }
}

async function heartbeat(ctx: AiContext, jobId: string, progress: number, stats: AiJobStats): Promise<boolean> {
  const { rows } = await sql<{ id: string }>`
    UPDATE ai_jobs SET progress = ${progress}, stats = ${JSON.stringify({ ...stats, heartbeatAt: new Date().toISOString() })}::jsonb
     WHERE id = ${jobId}::uuid AND status = 'RUNNING' RETURNING id`.execute(ctx.db);
  return rows.length > 0;
}

const round4 = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 10000) / 10000;

async function insertDetections(ctx: AiContext, job: ClaimedJob, batch: Pending[], frameRate: number | null, size: { width: number; height: number }, stats: AiJobStats): Promise<void> {
  if (!batch.length) return;
  const derived = ctx.storage.bucket('derived');
  const rows = [];
  for (const p of batch) {
    let cropKey: string | null = null;
    if (p.crop) {
      cropKey = `evidence/${job.evidence_id}/ai/${job.id}/${p.id}.jpg`;
      await ctx.storage.put(derived, cropKey, encodeJpeg(p.crop, 85), { contentType: 'image/jpeg', metadata: { 'ai-job': job.id, 'detection-id': p.id } });
    }
    const hasBox = p.det.box.x2 - p.det.box.x1 > 0 && p.task !== 'CLASSIFICATION';
    rows.push({
      id: p.id,
      job_id: job.id,
      evidence_id: job.evidence_id,
      model_id: p.model.id,
      model_code: p.model.code,
      model_version: p.model.version,
      task: p.task,
      label: p.det.label.slice(0, 200),
      confidence: Math.max(0, Math.min(1, p.det.confidence)),
      threshold: p.threshold,
      frame_time_ms: p.timeMs,
      frame_number: frameRate ? Math.round((p.timeMs / 1000) * frameRate) : null,
      // normalised [0,1] relative to the analysed frame
      bbox_x: hasBox ? round4(p.det.box.x1 / size.width) : null,
      bbox_y: hasBox ? round4(p.det.box.y1 / size.height) : null,
      bbox_w: hasBox ? round4((p.det.box.x2 - p.det.box.x1) / size.width) : null,
      bbox_h: hasBox ? round4((p.det.box.y2 - p.det.box.y1) / size.height) : null,
      track_id: p.trackId,
      attributes: JSON.stringify({ ...p.det.attributes, observations: p.observations, sampleIndex: p.frameIndex }),
      embedding: p.det.embedding ?? null,
      crop_key: cropKey,
    });
    stats.detections![p.task] = (stats.detections![p.task] ?? 0) + 1;
  }
  await ctx.db.insertInto('ai_detections').values(rows).execute();
}
