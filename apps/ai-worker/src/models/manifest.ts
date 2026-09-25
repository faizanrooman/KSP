/**
 * Pinned model artefacts (URL + SHA-256 + licence) and the ai_models rows they back.
 * `npm run fetch-models -w @ksp/ai-worker` downloads, verifies and registers them.
 */
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { appendAudit, loadConfig, sql, systemActor, type Database } from '@ksp/core';
import type { AiTask } from '@ksp/shared';
import { fileSha256 } from './runtime.js';
import type { ModelConfig } from './types.js';

export interface Artifact {
  file: string;
  url: string;
  sha256: string;
  licence: string;
  source: string;
}

export const ARTIFACTS = {
  yoloxS: {
    file: 'yolox_s.onnx',
    url: 'https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_s.onnx',
    sha256: 'c5c2d13e59ae883e6af3b45daea64af4833a4951c92d116ec270d9ddbe998063',
    licence: 'Apache-2.0',
    source: 'https://github.com/Megvii-BaseDetection/YOLOX',
  },
  yunet: {
    file: 'face_detection_yunet_2023mar.onnx',
    url: 'https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx',
    sha256: '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4',
    licence: 'MIT',
    source: 'https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet',
  },
  sface: {
    file: 'face_recognition_sface_2021dec.onnx',
    url: 'https://github.com/opencv/opencv_zoo/raw/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx',
    sha256: '0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79',
    licence: 'Apache-2.0',
    source: 'https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface',
  },
  plateDet: {
    file: 'yolo-v9-t-384-license-plates-end2end.onnx',
    url: 'https://github.com/ankandrew/open-image-models/releases/download/assets/yolo-v9-t-384-license-plates-end2end.onnx',
    sha256: '888397b96d761c89db40bc9c305838e8652660f5e282c2cadebbe8d2951a77a8',
    licence: 'MIT (repository licence; weights trained with YOLOv9 tooling — see docs/AI-MODEL-LIFECYCLE.md licence notes)',
    source: 'https://github.com/ankandrew/open-image-models',
  },
  plateOcr: {
    file: 'cct_s_v1_global.onnx',
    url: 'https://github.com/ankandrew/fast-plate-ocr/releases/download/arg-plates/cct_s_v1_global.onnx',
    sha256: '5c95b3231fff415b05cb48a3a39fab7c009364c2ee441bef092e0162ab75ea74',
    licence: 'MIT',
    source: 'https://github.com/ankandrew/fast-plate-ocr',
  },
} as const satisfies Record<string, Artifact>;

export const TAGGER_RULES = { vehicleLabels: ['car', 'truck', 'bus', 'motorcycle', 'bicycle'], weaponLabels: ['knife', 'scissors', 'baseball bat'], crowdMinPersons: 8, minTrackDetections: 1 };
const rulesSha = createHash('sha256').update(JSON.stringify(TAGGER_RULES)).digest('hex');

const POLICING_LABELS = ['person', 'bicycle', 'car', 'motorcycle', 'bus', 'truck', 'backpack', 'handbag', 'suitcase', 'umbrella', 'knife', 'scissors', 'baseball bat', 'cell phone', 'laptop', 'bottle'];

export interface ModelSpec {
  code: string;
  name: string;
  task: AiTask;
  version: string;
  runtime: string;
  artifactUri: string;
  artifactSha256: string;
  labels: string[];
  defaultThreshold: number;
  config: ModelConfig;
  metrics: Record<string, unknown>;
  artifacts: Artifact[];
}

const uri = (a: Artifact) => `models://${a.file}`;

export const MODEL_SPECS: ModelSpec[] = [
  {
    code: 'yolox-s-coco', name: 'YOLOX-S (COCO objects & vehicles)', task: 'OBJECT_DETECTION', version: '0.1.1rc0', runtime: 'onnxruntime',
    artifactUri: uri(ARTIFACTS.yoloxS), artifactSha256: ARTIFACTS.yoloxS.sha256, labels: POLICING_LABELS, defaultThreshold: 0.4,
    config: { architecture: 'yolox', inputWidth: 640, inputHeight: 640, nmsIou: 0.45, emitLabels: POLICING_LABELS, colorLabels: ['person', 'car', 'truck', 'bus', 'motorcycle', 'bicycle'], preprocess: 'BGR 0-255, top-left letterbox pad 114', licence: ARTIFACTS.yoloxS.licence, sourceUrl: ARTIFACTS.yoloxS.url },
    metrics: { source: 'upstream', cocoValMAP50_95: 0.405, note: 'Upstream COCO val2017 figure; not re-evaluated on KSP footage' }, artifacts: [ARTIFACTS.yoloxS],
  },
  {
    code: 'yolox-s-person', name: 'YOLOX-S (person)', task: 'PERSON_DETECTION', version: '0.1.1rc0', runtime: 'onnxruntime',
    artifactUri: uri(ARTIFACTS.yoloxS), artifactSha256: ARTIFACTS.yoloxS.sha256, labels: ['person'], defaultThreshold: 0.45,
    config: { architecture: 'yolox', inputWidth: 640, inputHeight: 640, nmsIou: 0.45, emitLabels: ['person'], colorLabels: ['person'], licence: ARTIFACTS.yoloxS.licence, sourceUrl: ARTIFACTS.yoloxS.url },
    metrics: { source: 'upstream', note: 'COCO person class of YOLOX-S' }, artifacts: [ARTIFACTS.yoloxS],
  },
  {
    code: 'yunet-face', name: 'YuNet face detector', task: 'FACE_DETECTION', version: '2023mar', runtime: 'onnxruntime',
    artifactUri: uri(ARTIFACTS.yunet), artifactSha256: ARTIFACTS.yunet.sha256, labels: ['face'], defaultThreshold: 0.7,
    config: { architecture: 'yunet', inputWidth: 640, inputHeight: 640, nmsIou: 0.3, preprocess: 'BGR 0-255, top-left pad 0', licence: ARTIFACTS.yunet.licence, sourceUrl: ARTIFACTS.yunet.url },
    metrics: { source: 'upstream (WIDER FACE, see opencv_zoo)', note: 'Not re-evaluated on KSP footage' }, artifacts: [ARTIFACTS.yunet],
  },
  {
    code: 'sface-recognition', name: 'SFace face recognition (watchlist matching)', task: 'FACE_RECOGNITION', version: '2021dec', runtime: 'onnxruntime',
    artifactUri: uri(ARTIFACTS.sface), artifactSha256: ARTIFACTS.sface.sha256, labels: [], defaultThreshold: 0.363,
    config: { architecture: 'sface', inputWidth: 112, inputHeight: 112, alignment: 'ArcFace 5-point similarity', embeddingDim: 128, similarity: 'cosine', licence: ARTIFACTS.sface.licence, sourceUrl: ARTIFACTS.sface.url },
    metrics: { source: 'upstream', lfwAccuracy: 0.9940, cosineThreshold: 0.363 }, artifacts: [ARTIFACTS.sface],
  },
  {
    code: 'anpr-yolov9t-cct', name: 'ANPR (plate detector + CCT OCR)', task: 'ANPR', version: 'oim-assets-384+cct-s-v1', runtime: 'onnxruntime',
    artifactUri: uri(ARTIFACTS.plateDet), artifactSha256: ARTIFACTS.plateDet.sha256, labels: ['plate'], defaultThreshold: 0.5,
    config: {
      architecture: 'yolov9-plate+cct-ocr', inputWidth: 384, inputHeight: 384, preprocess: 'RGB /255, centred letterbox pad 114',
      ocr: { artifactUri: uri(ARTIFACTS.plateOcr), sha256: ARTIFACTS.plateOcr.sha256, inputWidth: 128, inputHeight: 64, alphabet: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_', padChar: '_', slots: 9 },
      licence: 'MIT (see notes)', sourceUrl: ARTIFACTS.plateDet.url, ocrSourceUrl: ARTIFACTS.plateOcr.url,
    },
    metrics: { source: 'upstream README (open-image-models)', precision: 0.942, recall: 0.863, mAP50: 0.92, mAP50_95: 0.687, note: 'OCR trained on global plates; Indian plate accuracy UNVERIFIED' }, artifacts: [ARTIFACTS.plateDet, ARTIFACTS.plateOcr],
  },
  {
    code: 'ksp-evidence-tagger', name: 'Evidence tagger (rules over detections)', task: 'CLASSIFICATION', version: '1.0.0', runtime: 'rules',
    artifactUri: 'builtin:evidence-tagger/v1', artifactSha256: rulesSha, labels: ['person', 'vehicle', 'weapon:knife', 'weapon:scissors', 'weapon:baseball-bat', 'crowd'], defaultThreshold: 0.5,
    config: { architecture: 'rules', rules: TAGGER_RULES, licence: 'Proprietary (KSP)', sourceUrl: 'apps/ai-worker/src/pipeline.ts' },
    metrics: { note: 'Deterministic rules over detector output; confidence = supporting detection confidence' }, artifacts: [],
  },
];

async function download(a: Artifact, dir: string, log: (m: string) => void): Promise<void> {
  const target = join(dir, a.file);
  if (existsSync(target) && (await fileSha256(target)) === a.sha256) return;
  log(`downloading ${a.file} from ${a.url}`);
  const res = await fetch(a.url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download failed for ${a.file}: HTTP ${res.status}`);
  const tmp = `${target}.part`;
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp));
  const got = await fileSha256(tmp);
  if (got !== a.sha256) {
    await rm(tmp, { force: true });
    throw new Error(`SHA-256 mismatch for ${a.file}: expected ${a.sha256}, got ${got}`);
  }
  await rename(tmp, target);
}

export interface FetchResult {
  code: string;
  task: AiTask;
  ok: boolean;
  error?: string;
  modelId?: string;
  status?: string;
}

/**
 * Download + verify every artefact; register each model (code, version) and ACTIVATE it when no other version of
 * the same code is ACTIVE. Models whose artefacts cannot be obtained are NOT registered (task stays unavailable).
 */
export async function fetchAndRegisterModels(db: Database | null, opts: { dir?: string; activate?: boolean; log?: (m: string) => void } = {}): Promise<FetchResult[]> {
  const dir = resolve(opts.dir ?? loadConfig().AI_MODELS_DIR);
  const log = opts.log ?? (() => undefined);
  await mkdir(dir, { recursive: true });
  const out: FetchResult[] = [];
  for (const spec of MODEL_SPECS) {
    try {
      for (const a of spec.artifacts) await download(a, dir, log);
    } catch (err) {
      out.push({ code: spec.code, task: spec.task, ok: false, error: (err as Error).message });
      continue;
    }
    if (!db) {
      out.push({ code: spec.code, task: spec.task, ok: true });
      continue;
    }
    const res = await db.transaction().execute(async (tx) => {
      const existing = await tx.selectFrom('ai_models').select(['id', 'status']).where('code', '=', spec.code).where('version', '=', spec.version).executeTakeFirst();
      const actor = systemActor('fetch-models');
      let id = existing?.id;
      if (!id) {
        const row = await tx.insertInto('ai_models').values({
          code: spec.code, name: spec.name, task: spec.task, version: spec.version, runtime: spec.runtime, artifact_uri: spec.artifactUri,
          artifact_sha256: spec.artifactSha256, labels: spec.labels, default_threshold: spec.defaultThreshold,
          config: JSON.stringify(spec.config), metrics: JSON.stringify(spec.metrics), status: 'STAGED', notes: `Registered by fetch-models (${spec.artifacts.map((a) => a.licence).join('; ') || 'builtin'})`,
        }).returning('id').executeTakeFirstOrThrow();
        id = row.id;
        await appendAudit(tx, actor, { action: 'AI_MODEL_REGISTERED', resourceType: 'ai_model', resourceId: id, details: { code: spec.code, version: spec.version, task: spec.task, sha256: spec.artifactSha256 } });
      }
      let status = existing?.status ?? 'STAGED';
      if (opts.activate !== false && status === 'STAGED') {
        const active = await tx.selectFrom('ai_models').select('id').where('task', '=', spec.task).where('code', '=', spec.code).where('status', '=', 'ACTIVE').executeTakeFirst();
        if (!active) {
          await sql`UPDATE ai_models SET status = 'ACTIVE', activated_at = now() WHERE id = ${id}::uuid`.execute(tx);
          await appendAudit(tx, actor, { action: 'AI_MODEL_ACTIVATED', resourceType: 'ai_model', resourceId: id, details: { code: spec.code, version: spec.version, task: spec.task } });
          status = 'ACTIVE';
        }
      }
      return { id, status };
    });
    out.push({ code: spec.code, task: spec.task, ok: true, modelId: res.id, status: res.status });
  }
  return out;
}
