/** Tender §16 — accuracy evaluation harness: metric maths (synthetic) and a real-inference run on the pinned test images. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateDetector, iou, levenshtein, loadDataset, matchImage, plateMetrics, reportSummary, summarise, sweep, verificationMetrics, MIN_THRESHOLD, type Dataset } from '../src/evaluate.js';
import { baseDetector, FilteredDetector, type ModelRow, type RawDetection } from '../src/models/index.js';
import { fetchAndRegisterModels } from '../src/models/manifest.js';
import { appDb, closeAll } from './helpers.js';
import { tryEnsureImages } from './media.js';

const det = (label: string, confidence: number, box: [number, number, number, number]): RawDetection => ({ label, confidence, box: { x1: box[0], y1: box[1], x2: box[2], y2: box[3] }, attributes: {} });
const gt = (label: string, box?: [number, number, number, number]) => ({ label, box: box ? { x1: box[0], y1: box[1], x2: box[2], y2: box[3] } : null });

describe('evaluation metrics', () => {
  it('computes IoU', () => {
    expect(iou({ x1: 0, y1: 0, x2: 10, y2: 10 }, { x1: 0, y1: 0, x2: 10, y2: 10 })).toBe(1);
    expect(iou({ x1: 0, y1: 0, x2: 10, y2: 10 }, { x1: 5, y1: 0, x2: 15, y2: 10 })).toBeCloseTo(1 / 3);
    expect(iou({ x1: 0, y1: 0, x2: 10, y2: 10 }, { x1: 20, y1: 20, x2: 30, y2: 30 })).toBe(0);
  });

  it('matches boxes greedily by confidence, counts FP/FN, and ignores labels outside the dataset', () => {
    const truth = [gt('person', [0, 0, 100, 200]), gt('person', [300, 0, 400, 200])];
    const preds = [det('person', 0.9, [2, 2, 98, 198]), det('person', 0.8, [5, 5, 95, 190]) /* duplicate → FP */, det('car', 0.95, [0, 0, 500, 500]) /* not evaluated */];
    const m = matchImage(preds, truth, new Set(['person']), 0.5);
    expect(m.perLabel.get('person')).toEqual({ tp: 1, fp: 1, fn: 1 });
    expect(m.positiveImage).toBe(true);
    expect(m.hit).toBe(true);
    expect(m.falsePositiveImage).toBe(false);
  });

  it('treats image-level labels as presence and flags predictions on negative images', () => {
    const present = matchImage([det('face', 0.7, [0, 0, 10, 10]), det('face', 0.6, [20, 20, 30, 30])], [gt('face')], new Set(['face']), 0.5);
    expect(present.perLabel.get('face')).toEqual({ tp: 1, fp: 0, fn: 0 });
    const missed = matchImage([], [gt('face')], new Set(['face']), 0.5);
    expect(missed.perLabel.get('face')).toEqual({ tp: 0, fp: 0, fn: 1 });
    expect(missed.hit).toBe(false);
    const negative = matchImage([det('face', 0.9, [0, 0, 10, 10])], [], new Set(['face']), 0.5);
    expect(negative.falsePositiveImage).toBe(true);
    expect(negative.perLabel.get('face')).toEqual({ tp: 0, fp: 1, fn: 0 });
  });

  it('summarises precision / recall / FPR / FNR across images and sweeps thresholds', () => {
    const img = (id: string, truth: ReturnType<typeof gt>[]) => ({ id, file: `${id}.jpg`, truth });
    const results = [
      { image: img('a', [gt('person', [0, 0, 100, 100])]), preds: [det('person', 0.9, [0, 0, 100, 100])] },
      { image: img('b', [gt('person', [0, 0, 100, 100])]), preds: [det('person', 0.3, [0, 0, 100, 100])] }, // only found at low threshold
      { image: img('c', []), preds: [det('person', 0.6, [0, 0, 50, 50])] }, // false positive on a negative image
      { image: img('d', []), preds: [] },
    ];
    const high = summarise(results, ['person'], 0.5, 0.5);
    expect(high).toMatchObject({ tp: 1, fp: 1, fn: 1, precision: 0.5, recall: 0.5, falsePositiveRate: 0.5, falseNegativeRate: 0.5, missedImageRate: 0.5 });
    const low = summarise(results, ['person'], 0.5, 0.25);
    expect(low).toMatchObject({ tp: 2, fp: 1, fn: 0, recall: 1, falseNegativeRate: 0 });
    const strict = summarise(results, ['person'], 0.5, 0.95);
    expect(strict).toMatchObject({ tp: 0, fp: 0, fn: 2, precision: null, recall: 0, falsePositiveRate: 0 });
    const sw = sweep(results, ['person'], 0.5, [0.25, 0.5, 0.95]);
    expect(sw.map((s) => s.threshold)).toEqual([0.25, 0.5, 0.95]);
  });

  it('scores face verification pairs (accuracy, FAR/FRR, TAR@FAR, EER)', () => {
    const sims = [
      ...[0.9, 0.85, 0.7, 0.65, 0.5].map((s) => ({ similarity: s, same: true })),
      ...[0.4, 0.3, 0.2, 0.1, 0.55].map((s) => ({ similarity: s, same: false })),
    ];
    const m = verificationMetrics(sims, 0.6);
    expect(m).toMatchObject({ pairs: 10, genuine: 5, impostor: 5, threshold: 0.6, falseAcceptRate: 0, falseRejectRate: 0.2, accuracyAtThreshold: 0.9 });
    expect(m.bestAccuracy).toBeGreaterThanOrEqual(0.9);
    expect(m.equalErrorRate).not.toBeNull();
    expect(m.tarAtFar1pct).toBe(0.8); // highest TAR with zero false accepts (impostor max 0.55 → threshold 0.65 keeps 4/5 genuine)
  });

  it('scores plate reads (exact match, CER, detection and false-positive rates)', () => {
    expect(levenshtein('KA01AB1234', 'KA01AB1284')).toBe(1);
    const m = plateMetrics([
      { expected: 'KA 01 AB 1234', read: 'KA01AB1234' },
      { expected: 'KA02CD5678', read: 'KA02CD5679' },
      { expected: 'KA03EF9999', read: null },
      { expected: null, read: null },
      { expected: null, read: 'XX00YY0000' },
    ]);
    expect(m).toMatchObject({ items: 5, withPlate: 3, negatives: 2, detectionRate: 2 / 3, exactMatchRate: 1 / 3, falsePositiveRate: 0.5 });
    expect(m.characterErrorRate).toBeCloseTo(1 / 20);
  });

  it('loads COCO and labels.json datasets (full-frame COCO boxes become presence labels)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ksp-eval-'));
    await writeFile(join(dir, 'annotations.json'), JSON.stringify({
      images: [{ id: 1, file_name: 'a.jpg', width: 100, height: 100 }, { id: 2, file_name: 'b.jpg', width: 100, height: 100 }, { id: 3, file_name: 'n.jpg', width: 100, height: 100 }],
      annotations: [{ image_id: 1, category_id: 1, bbox: [10, 10, 20, 30] }, { image_id: 2, category_id: 1, bbox: [0, 0, 100, 100] }],
      categories: [{ id: 1, name: 'pedestrian' }],
    }));
    const ds = await loadDataset(dir, { pedestrian: 'person' });
    expect(ds.labels).toEqual(['person']);
    expect(ds.images.map((i) => i.truth)).toEqual([[{ label: 'person', box: { x1: 10, y1: 10, x2: 30, y2: 40 } }], [{ label: 'person', box: null }], []]);
    const dir2 = await mkdtemp(join(tmpdir(), 'ksp-eval-'));
    await writeFile(join(dir2, 'labels.json'), JSON.stringify({ name: 'simple', images: [{ file: 'x.jpg', labels: ['face', { label: 'car', box: { x1: 1, y1: 2, x2: 3, y2: 4 } }] }, { file: 'y.jpg' }] }));
    const ds2 = await loadDataset(dir2);
    expect(ds2.name).toBe('simple');
    expect(ds2.labels).toEqual(['car', 'face']);
    expect(ds2.images[1]!.truth).toEqual([]);
  });
});

describe('evaluation with the production detectors (real inference)', () => {
  let images: Record<string, string> | null = null;
  let reason: string | null = null;
  beforeAll(async () => {
    await fetchAndRegisterModels(appDb()).catch(() => undefined);
    const r = await tryEnsureImages();
    images = r.images;
    reason = r.reason;
  });
  afterAll(closeAll);

  const activeModel = async (task: string) => (await appDb().selectFrom('ai_models').selectAll().where('task', '=', task).where('status', '=', 'ACTIVE').executeTakeFirst()) as unknown as ModelRow | undefined;

  it('measures the face detector on a labelled positive + negative image', async (ctx) => {
    if (!images) return ctx.skip(reason ?? 'no test imagery');
    const m = await activeModel('FACE_DETECTION');
    if (!m) return ctx.skip('face model not registered');
    const ds: Dataset = { name: 'faces-smoke', dir: '', labels: ['face'], images: [{ id: '1', file: images.portrait!, truth: [{ label: 'face', box: null }] }, { id: '2', file: images.plate!, truth: [] }] };
    const report = await evaluateDetector(new FilteredDetector(m, baseDetector(m), () => MIN_THRESHOLD), ds, { defaultThreshold: m.default_threshold });
    expect(report.dataset).toMatchObject({ images: 2, positiveImages: 1, negativeImages: 1, annotations: 1 });
    expect(report.atDefaultThreshold).toMatchObject({ threshold: m.default_threshold, tp: 1, fn: 0, recall: 1, falsePositiveRate: 0, falseNegativeRate: 0 });
    expect(report.latencyMs.p95).toBeGreaterThan(0);
    const summary = reportSummary(report);
    expect(summary).toMatchObject({ kind: 'detection', dataset: 'faces-smoke', recall: 1 });
  });

  it('measures the person detector on a street scene against a negative image', async (ctx) => {
    if (!images) return ctx.skip(reason ?? 'no test imagery');
    const m = await activeModel('PERSON_DETECTION');
    if (!m) return ctx.skip('person model not registered');
    const ds: Dataset = { name: 'persons-smoke', dir: '', labels: ['person'], images: [{ id: '1', file: images.street!, truth: [{ label: 'person', box: null }] }, { id: '2', file: images.plate!, truth: [] }] };
    const report = await evaluateDetector(new FilteredDetector(m, baseDetector(m), () => MIN_THRESHOLD), ds, { defaultThreshold: m.default_threshold });
    expect(report.atDefaultThreshold.recall).toBe(1);
    expect(report.atDefaultThreshold.falsePositiveRate).toBe(0);
    expect(report.bestF1.f1).toBe(1);
  });
});
