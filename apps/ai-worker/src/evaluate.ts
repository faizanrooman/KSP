/**
 * AI accuracy evaluation (tender Appendix 1 §16: measurable precision / recall / false-positive / false-negative rates
 * per analytic, declared on the model version that is in service).
 *
 * The metric functions are pure and unit-tested; the runners drive the SAME detector classes the worker uses, so a
 * number recorded on a model version was produced by the exact inference path that analyses evidence. Upstream figures
 * (COCO, WIDER FACE, LFW…) stay in `metrics.source = 'upstream'`; a KSP evaluation is recorded under
 * `metrics.kspEvaluation` by `scripts/evaluate-model.ts --register` (audited as AI_MODEL_UPDATED).
 *
 * Datasets:
 *   detection  — a directory with `annotations.json` in COCO format (what the training-dataset export produces, and
 *                what every labelling tool can emit) or `labels.json`:
 *                { "name": "...", "images": [{ "file": "a.jpg", "labels": ["person", {"label":"car","box":{"x1":..,"y1":..,"x2":..,"y2":..}}] }] }
 *                A label without a box (or a COCO box covering the whole image, as in exported crops) is an
 *                image-level "present" label; an image with no labels is a negative.
 *   face pairs — `pairs.json`: { "pairs": [{ "a": "x.jpg", "b": "y.jpg", "same": true }] }
 *   plates     — `plates.json`: { "items": [{ "file": "p.jpg", "plate": "KA01AB1234" }, { "file": "none.jpg", "plate": null }] }
 */
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Box, RgbImage } from './image.js';
import type { Detector, RawDetection } from './models/types.js';
import type { SfaceEmbedder } from './models/sface.js';
import { loadStill } from './watchlist.js';

export interface GroundTruth { label: string; box: Box | null }
export interface EvalImage { id: string; file: string; width?: number; height?: number; truth: GroundTruth[] }
export interface Dataset { name: string; dir: string; images: EvalImage[]; labels: string[] }

export interface Counts { tp: number; fp: number; fn: number }
export interface Rates extends Counts { precision: number | null; recall: number | null; f1: number | null }
export interface ThresholdMetrics extends Rates {
  threshold: number;
  /** Share of negative images (no ground truth) on which the model reported at least one object of an evaluated label. */
  falsePositiveRate: number | null;
  /** Share of ground-truth objects the model missed (1 − recall). */
  falseNegativeRate: number | null;
  /** Share of positive images on which nothing was found at all. */
  missedImageRate: number | null;
  perLabel: Record<string, Rates>;
}

export const DEFAULT_SWEEP = Array.from({ length: 18 }, (_, i) => Math.round((0.1 + i * 0.05) * 100) / 100);
/** Detectors are run once at this confidence; every sweep threshold is applied to that output. */
export const MIN_THRESHOLD = 0.05;

// ── pure metric functions ────────────────────────────────────────────────────────────────────────────────────────────

export function iou(a: Box, b: Box): number {
  const w = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
  const h = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  const union = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter;
  return union > 0 ? inter / union : 0;
}

export interface ImageMatch { perLabel: Map<string, Counts>; falsePositiveImage: boolean; positiveImage: boolean; hit: boolean }

/**
 * Greedy matching of one image: predictions (highest confidence first) claim the best unmatched ground-truth box of the
 * same label with IoU ≥ iouMin. Image-level labels (box null) are satisfied by any prediction of that label and never
 * produce false positives for it (crop datasets have no localisation). Only `labels` are evaluated — a person
 * detector is not penalised for the cars it also sees.
 */
export function matchImage(preds: RawDetection[], truth: GroundTruth[], labels: Set<string>, iouMin: number): ImageMatch {
  const perLabel = new Map<string, Counts>();
  const bump = (l: string, k: keyof Counts) => {
    const c = perLabel.get(l) ?? { tp: 0, fp: 0, fn: 0 };
    c[k]++;
    perLabel.set(l, c);
  };
  const used = new Set<GroundTruth>();
  const presence = new Set(truth.filter((t) => t.box === null).map((t) => t.label));
  for (const p of [...preds].filter((d) => labels.has(d.label)).sort((a, b) => b.confidence - a.confidence)) {
    if (presence.has(p.label)) {
      const g = truth.find((t) => t.label === p.label && t.box === null && !used.has(t));
      if (g) { used.add(g); bump(p.label, 'tp'); }
      continue; // further predictions of a present label are neither TP nor FP
    }
    let best: GroundTruth | null = null;
    let bestIou = iouMin;
    for (const g of truth) {
      if (g.label !== p.label || g.box === null || used.has(g)) continue;
      const v = iou(p.box, g.box);
      if (v >= bestIou) { best = g; bestIou = v; }
    }
    if (best) { used.add(best); bump(p.label, 'tp'); } else bump(p.label, 'fp');
  }
  for (const g of truth) if (labels.has(g.label) && !used.has(g)) bump(g.label, 'fn');
  const anyPred = preds.some((d) => labels.has(d.label));
  const positiveImage = truth.some((t) => labels.has(t.label));
  let tp = 0;
  for (const c of perLabel.values()) tp += c.tp;
  return { perLabel, falsePositiveImage: !positiveImage && anyPred, positiveImage, hit: positiveImage && tp > 0 };
}

export function rates(c: Counts): Rates {
  const precision = c.tp + c.fp ? c.tp / (c.tp + c.fp) : null;
  const recall = c.tp + c.fn ? c.tp / (c.tp + c.fn) : null;
  const f1 = precision !== null && recall !== null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : null;
  return { ...c, precision, recall, f1 };
}

export interface ImageResult { image: EvalImage; preds: RawDetection[] }

export function summarise(results: ImageResult[], labels: string[], iouMin: number, threshold: number): ThresholdMetrics {
  const set = new Set(labels);
  const total: Counts = { tp: 0, fp: 0, fn: 0 };
  const perLabel = new Map<string, Counts>(labels.map((l) => [l, { tp: 0, fp: 0, fn: 0 }]));
  let negatives = 0, falsePositiveImages = 0, positives = 0, hits = 0;
  for (const r of results) {
    const m = matchImage(r.preds.filter((p) => p.confidence >= threshold), r.image.truth, set, iouMin);
    for (const [l, c] of m.perLabel) {
      const agg = perLabel.get(l)!;
      agg.tp += c.tp; agg.fp += c.fp; agg.fn += c.fn;
      total.tp += c.tp; total.fp += c.fp; total.fn += c.fn;
    }
    if (m.positiveImage) { positives++; if (m.hit) hits++; } else { negatives++; if (m.falsePositiveImage) falsePositiveImages++; }
  }
  const r = rates(total);
  return {
    threshold, ...r,
    falsePositiveRate: negatives ? falsePositiveImages / negatives : null,
    falseNegativeRate: r.recall === null ? null : 1 - r.recall,
    missedImageRate: positives ? 1 - hits / positives : null,
    perLabel: Object.fromEntries([...perLabel].map(([l, c]) => [l, rates(c)])),
  };
}

export function sweep(results: ImageResult[], labels: string[], iouMin: number, thresholds = DEFAULT_SWEEP): ThresholdMetrics[] {
  return thresholds.map((t) => summarise(results, labels, iouMin, t));
}

export function bestByF1(metrics: ThresholdMetrics[]): ThresholdMetrics {
  return metrics.reduce((best, m) => ((m.f1 ?? -1) > (best.f1 ?? -1) ? m : best), metrics[0]!);
}

export interface VerificationMetrics {
  pairs: number; genuine: number; impostor: number;
  accuracyAtThreshold: number; threshold: number;
  bestThreshold: number; bestAccuracy: number;
  /** True accept rate at 1 % / 0.1 % false accept rate. */
  tarAtFar1pct: number | null; tarAtFar01pct: number | null;
  equalErrorRate: number | null;
  falseAcceptRate: number; falseRejectRate: number;
}

/** Threshold metrics over cosine similarities of labelled pairs (same person or not). */
export function verificationMetrics(sims: Array<{ similarity: number; same: boolean }>, threshold: number): VerificationMetrics {
  const genuine = sims.filter((s) => s.same).map((s) => s.similarity).sort((a, b) => a - b);
  const impostor = sims.filter((s) => !s.same).map((s) => s.similarity).sort((a, b) => a - b);
  const at = (t: number) => {
    const fa = impostor.filter((s) => s >= t).length;
    const fr = genuine.filter((s) => s < t).length;
    return { far: impostor.length ? fa / impostor.length : 0, frr: genuine.length ? fr / genuine.length : 0, acc: sims.length ? (sims.length - fa - fr) / sims.length : 0 };
  };
  const cur = at(threshold);
  const candidates = [...new Set([...genuine, ...impostor, threshold])].sort((a, b) => a - b);
  let bestThreshold = threshold, bestAccuracy = cur.acc, eer: number | null = null, eerGap = Infinity;
  for (const t of candidates) {
    const m = at(t);
    if (m.acc > bestAccuracy) { bestAccuracy = m.acc; bestThreshold = t; }
    const gap = Math.abs(m.far - m.frr);
    if (gap < eerGap) { eerGap = gap; eer = (m.far + m.frr) / 2; }
  }
  const tarAt = (far: number) => {
    if (!impostor.length || !genuine.length) return null;
    // smallest threshold whose FAR ≤ far
    const t = candidates.find((c) => at(c).far <= far);
    return t === undefined ? 0 : 1 - at(t).frr;
  };
  return {
    pairs: sims.length, genuine: genuine.length, impostor: impostor.length,
    accuracyAtThreshold: cur.acc, threshold, bestThreshold, bestAccuracy,
    tarAtFar1pct: tarAt(0.01), tarAtFar01pct: tarAt(0.001), equalErrorRate: genuine.length && impostor.length ? eer : null,
    falseAcceptRate: cur.far, falseRejectRate: cur.frr,
  };
}

export const normalisePlate = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

export function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

export interface PlateMetrics {
  items: number; withPlate: number; negatives: number;
  /** Plate images where a plate was found at all. */
  detectionRate: number | null;
  /** Plate images read exactly right (after normalisation). */
  exactMatchRate: number | null;
  /** Character error rate over detected plates. */
  characterErrorRate: number | null;
  /** Negative images on which a plate was reported. */
  falsePositiveRate: number | null;
}

export function plateMetrics(rows: Array<{ expected: string | null; read: string | null }>): PlateMetrics {
  const pos = rows.filter((r) => r.expected !== null);
  const neg = rows.filter((r) => r.expected === null);
  const detected = pos.filter((r) => r.read !== null);
  const exact = detected.filter((r) => normalisePlate(r.read!) === normalisePlate(r.expected!));
  let errs = 0, chars = 0;
  for (const r of detected) { const e = normalisePlate(r.expected!); errs += levenshtein(normalisePlate(r.read!), e); chars += e.length; }
  return {
    items: rows.length, withPlate: pos.length, negatives: neg.length,
    detectionRate: pos.length ? detected.length / pos.length : null,
    exactMatchRate: pos.length ? exact.length / pos.length : null,
    characterErrorRate: chars ? errs / chars : null,
    falsePositiveRate: neg.length ? neg.filter((r) => r.read !== null).length / neg.length : null,
  };
}

// ── dataset loading ──────────────────────────────────────────────────────────────────────────────────────────────────

interface CocoFile {
  images: Array<{ id: number; file_name: string; width?: number; height?: number }>;
  annotations: Array<{ image_id: number; category_id: number; bbox: [number, number, number, number] }>;
  categories: Array<{ id: number; name: string }>;
}
interface SimpleFile { name?: string; images: Array<{ file: string; labels?: Array<string | { label: string; box?: Box | null }> }> }

export async function loadDataset(path: string, labelMap: Record<string, string> = {}): Promise<Dataset> {
  const abs = resolve(path);
  const file = abs.endsWith('.json') ? abs : await firstExisting([join(abs, 'annotations.json'), join(abs, 'labels.json')]);
  const dir = dirname(file);
  const raw = JSON.parse(await readFile(file, 'utf8')) as CocoFile | SimpleFile;
  const map = (l: string) => labelMap[l] ?? l;
  const images: EvalImage[] = [];
  if ('annotations' in raw && 'categories' in raw) {
    const cats = new Map(raw.categories.map((c) => [c.id, map(c.name)]));
    const byImage = new Map<number, GroundTruth[]>();
    for (const im of raw.images) byImage.set(im.id, []);
    for (const a of raw.annotations) {
      const im = raw.images.find((i) => i.id === a.image_id);
      const label = cats.get(a.category_id);
      if (!im || !label) continue;
      const [x, y, w, h] = a.bbox;
      const full = im.width && im.height && w * h >= 0.98 * im.width * im.height;
      byImage.get(a.image_id)!.push({ label, box: full ? null : { x1: x, y1: y, x2: x + w, y2: y + h } });
    }
    for (const im of raw.images) images.push({ id: String(im.id), file: isAbsolute(im.file_name) ? im.file_name : join(dir, im.file_name), width: im.width, height: im.height, truth: byImage.get(im.id)! });
  } else if ('images' in raw) {
    raw.images.forEach((im, i) =>
      images.push({
        id: String(i + 1), file: isAbsolute(im.file) ? im.file : join(dir, im.file),
        truth: (im.labels ?? []).map((l) => (typeof l === 'string' ? { label: map(l), box: null } : { label: map(l.label), box: l.box ?? null })),
      }));
  } else throw new Error(`${file}: not a COCO annotations file or a labels.json`);
  const labels = [...new Set(images.flatMap((i) => i.truth.map((t) => t.label)))].sort();
  if (!images.length) throw new Error(`${file}: dataset has no images`);
  if (!labels.length) throw new Error(`${file}: dataset has no labelled objects (nothing to measure recall against)`);
  return { name: ('name' in raw && raw.name) || dir.split('/').pop() || 'dataset', dir, images, labels };
}

async function firstExisting(paths: string[]): Promise<string> {
  for (const p of paths) {
    try { await readFile(p, { encoding: 'utf8', flag: 'r' }); return p; } catch { /* next */ }
  }
  throw new Error(`no annotations.json or labels.json under ${dirname(paths[0]!)}`);
}

// ── runners (production detectors on labelled data) ──────────────────────────────────────────────────────────────────

export interface DetectionReport {
  kind: 'detection';
  task: string; model: { code: string; version: string; id: string };
  dataset: { name: string; images: number; positiveImages: number; negativeImages: number; annotations: number; labels: string[] };
  iouMin: number; evaluatedAt: string;
  latencyMs: { mean: number; p95: number };
  atDefaultThreshold: ThresholdMetrics; bestF1: ThresholdMetrics; sweep: ThresholdMetrics[];
  skipped: Array<{ file: string; error: string }>;
}

export async function evaluateDetector(
  detector: Detector, ds: Dataset,
  opts: { defaultThreshold: number; iouMin?: number; labelMap?: Record<string, string>; thresholds?: number[]; onImage?: (done: number, total: number) => void },
): Promise<DetectionReport> {
  const iouMin = opts.iouMin ?? 0.5;
  const map = (l: string) => opts.labelMap?.[l] ?? l;
  const results: ImageResult[] = [];
  const skipped: DetectionReport['skipped'] = [];
  const lat: number[] = [];
  await detector.load();
  for (const [i, image] of ds.images.entries()) {
    let img: RgbImage;
    try { img = await loadStill(image.file); } catch (e) { skipped.push({ file: image.file, error: (e as Error).message }); continue; }
    const t0 = performance.now();
    const preds = (await detector.detect(img, MIN_THRESHOLD)).map((p) => ({ ...p, label: map(p.label) }));
    lat.push(performance.now() - t0);
    results.push({ image, preds });
    opts.onImage?.(i + 1, ds.images.length);
  }
  const thresholds = [...new Set([...(opts.thresholds ?? DEFAULT_SWEEP), opts.defaultThreshold])].sort((a, b) => a - b);
  const sw = sweep(results, ds.labels, iouMin, thresholds);
  const sorted = [...lat].sort((a, b) => a - b);
  return {
    kind: 'detection', task: detector.task, model: { code: detector.code, version: detector.version, id: detector.modelId },
    dataset: {
      name: ds.name, images: results.length, positiveImages: results.filter((r) => r.image.truth.length).length,
      negativeImages: results.filter((r) => !r.image.truth.length).length, annotations: results.reduce((n, r) => n + r.image.truth.length, 0), labels: ds.labels,
    },
    iouMin, evaluatedAt: new Date().toISOString(),
    latencyMs: { mean: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : 0, p95: sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!) : 0 },
    atDefaultThreshold: sw.find((m) => m.threshold === opts.defaultThreshold)!, bestF1: bestByF1(sw), sweep: sw, skipped,
  };
}

export interface FacePair { a: string; b: string; same: boolean }
export interface VerificationReport {
  kind: 'face-verification';
  model: { code: string; version: string; id: string }; faceDetector: { code: string; version: string };
  dataset: { name: string; pairs: number; skippedPairs: number; skipped: Array<{ file: string; error: string }> };
  evaluatedAt: string; metrics: VerificationMetrics;
}

/** Embed the largest face of each image once, then score every labelled pair. */
export async function evaluateFaceVerification(
  faceDetector: Detector, embedder: SfaceEmbedder & { modelId: string; code: string; version: string }, pairs: FacePair[], dir: string,
  opts: { threshold: number; faceThreshold?: number; name?: string },
): Promise<VerificationReport> {
  await Promise.all([faceDetector.load(), embedder.load()]);
  const cache = new Map<string, Float32Array | Error>();
  const embed = async (file: string) => {
    const abs = isAbsolute(file) ? file : join(dir, file);
    let v = cache.get(abs);
    if (!v) {
      try {
        const img = await loadStill(abs);
        const faces = (await faceDetector.detect(img, opts.faceThreshold ?? 0.6)).filter((f) => f.landmarks).sort((a, b) => (b.box.x2 - b.box.x1) * (b.box.y2 - b.box.y1) - (a.box.x2 - a.box.x1) * (a.box.y2 - a.box.y1));
        v = faces[0] ? await embedder.embed(img, faces[0].landmarks!) : new Error('NO_FACE_FOUND');
      } catch (e) { v = e as Error; }
      cache.set(abs, v);
    }
    return v;
  };
  const sims: Array<{ similarity: number; same: boolean }> = [];
  let skippedPairs = 0;
  for (const p of pairs) {
    const [a, b] = [await embed(p.a), await embed(p.b)];
    if (a instanceof Error || b instanceof Error) { skippedPairs++; continue; }
    sims.push({ similarity: cosine(a, b), same: p.same });
  }
  return {
    kind: 'face-verification', model: { code: embedder.code, version: embedder.version, id: embedder.modelId }, faceDetector: { code: faceDetector.code, version: faceDetector.version },
    dataset: { name: opts.name ?? dir.split('/').pop() ?? 'pairs', pairs: sims.length, skippedPairs, skipped: [...cache].filter(([, v]) => v instanceof Error).map(([file, v]) => ({ file, error: (v as Error).message })) },
    evaluatedAt: new Date().toISOString(), metrics: verificationMetrics(sims, opts.threshold),
  };
}

export interface PlateItem { file: string; plate: string | null }
export interface PlateReport {
  kind: 'anpr';
  model: { code: string; version: string; id: string };
  dataset: { name: string; items: number; skipped: Array<{ file: string; error: string }> };
  threshold: number; evaluatedAt: string; metrics: PlateMetrics;
  rows: Array<{ file: string; expected: string | null; read: string | null; confidence: number | null }>;
}

export async function evaluatePlates(detector: Detector, items: PlateItem[], dir: string, opts: { threshold: number; name?: string }): Promise<PlateReport> {
  await detector.load();
  const rows: PlateReport['rows'] = [];
  const skipped: PlateReport['dataset']['skipped'] = [];
  for (const it of items) {
    const abs = isAbsolute(it.file) ? it.file : join(dir, it.file);
    try {
      const img = await loadStill(abs);
      const best = (await detector.detect(img, opts.threshold)).sort((a, b) => b.confidence - a.confidence)[0];
      const read = best ? (typeof best.attributes.plateText === 'string' ? best.attributes.plateText : null) : null;
      rows.push({ file: it.file, expected: it.plate, read, confidence: best?.confidence ?? null });
    } catch (e) { skipped.push({ file: it.file, error: (e as Error).message }); }
  }
  return {
    kind: 'anpr', model: { code: detector.code, version: detector.version, id: detector.modelId },
    dataset: { name: opts.name ?? dir.split('/').pop() ?? 'plates', items: rows.length, skipped }, threshold: opts.threshold,
    evaluatedAt: new Date().toISOString(), metrics: plateMetrics(rows), rows,
  };
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Compact summary stored on the model version (ai_models.metrics.kspEvaluation) and shown on the AI models page. */
export function reportSummary(r: DetectionReport | VerificationReport | PlateReport): Record<string, unknown> {
  if (r.kind === 'detection') {
    const d = r.atDefaultThreshold;
    return {
      kind: r.kind, dataset: r.dataset.name, images: r.dataset.images, annotations: r.dataset.annotations, iouMin: r.iouMin, evaluatedAt: r.evaluatedAt,
      threshold: d.threshold, precision: d.precision, recall: d.recall, f1: d.f1, falsePositiveRate: d.falsePositiveRate, falseNegativeRate: d.falseNegativeRate,
      bestF1Threshold: r.bestF1.threshold, bestF1: r.bestF1.f1, latencyMsP95: r.latencyMs.p95,
    };
  }
  if (r.kind === 'face-verification') {
    const m = r.metrics;
    return { kind: r.kind, dataset: r.dataset.name, pairs: m.pairs, evaluatedAt: r.evaluatedAt, threshold: m.threshold, accuracy: m.accuracyAtThreshold, falseAcceptRate: m.falseAcceptRate, falseRejectRate: m.falseRejectRate, tarAtFar1pct: m.tarAtFar1pct, equalErrorRate: m.equalErrorRate, bestThreshold: m.bestThreshold };
  }
  const m = r.metrics;
  return { kind: r.kind, dataset: r.dataset.name, items: m.items, evaluatedAt: r.evaluatedAt, threshold: r.threshold, detectionRate: m.detectionRate, exactMatchRate: m.exactMatchRate, characterErrorRate: m.characterErrorRate, falsePositiveRate: m.falsePositiveRate };
}
