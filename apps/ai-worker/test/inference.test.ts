/** Real ONNX inference on public-domain / CC0 imagery (no mocks), colour on synthetic patches, tracker dedupe. */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { decodeJpeg, resize, type RgbImage } from '../src/image.js';
import { dominantColor } from '../src/color.js';
import { IouTracker } from '../src/tracker.js';
import { YoloxDetector } from '../src/models/yolox.js';
import { YunetDetector } from '../src/models/yunet.js';
import { AnprDetector } from '../src/models/anpr.js';
import { SfaceEmbedder, cosine } from '../src/models/sface.js';
import { MODEL_SPECS, fetchAndRegisterModels } from '../src/models/manifest.js';
import type { ModelRow } from '../src/models/types.js';
import { tryEnsureImages } from './media.js';

const MEDIA = await tryEnsureImages();
const MODELS = await fetchAndRegisterModels(null).catch((e: Error) => [{ ok: false, error: e.message, code: 'all', task: 'OBJECT_DETECTION' as const }]);
const modelsOk = (code: string) => MODELS.some((m) => m.code === code && m.ok);
if (!MEDIA.images) console.warn(`[ai-worker tests] SKIPPING image-based inference tests: ${MEDIA.reason}`);

const row = (code: string): ModelRow => {
  const s = MODEL_SPECS.find((m) => m.code === code)!;
  return { id: code, code, name: s.name, task: s.task, version: s.version, runtime: s.runtime, artifact_uri: s.artifactUri, artifact_sha256: s.artifactSha256, labels: s.labels, default_threshold: s.defaultThreshold, config: s.config, status: 'ACTIVE' };
};
const fit = (img: RgbImage, max = 1280) => {
  const r = Math.min(1, max / Math.max(img.width, img.height));
  return resize(img, Math.round(img.width * r), Math.round(img.height * r));
};
const load = async (path: string) => fit(decodeJpeg(await readFile(path)));

describe.skipIf(!MEDIA.images)('real inference on public-domain imagery', () => {
  const imgs = {} as Record<'street' | 'crowd' | 'portrait' | 'plate', RgbImage>;
  beforeAll(async () => {
    for (const k of ['street', 'crowd', 'portrait', 'plate'] as const) imgs[k] = await load(MEDIA.images![k]);
  });

  it.skipIf(!modelsOk('yolox-s-coco'))('YOLOX-S finds people and vehicles in a street scene; persons in a crowd', async () => {
    const d = new YoloxDetector(row('yolox-s-coco'));
    await d.load();
    const street = await d.detect(imgs.street, 0.4);
    const labels = street.map((x) => x.label);
    expect(labels.filter((l) => l === 'person').length).toBeGreaterThanOrEqual(3);
    expect(labels.some((l) => ['car', 'truck', 'motorcycle', 'bus'].includes(l))).toBe(true);
    for (const x of street) {
      expect(x.confidence).toBeGreaterThanOrEqual(0.4);
      expect(x.box.x1).toBeGreaterThanOrEqual(0);
      expect(x.box.x2).toBeLessThanOrEqual(imgs.street.width);
      expect(x.box.x2).toBeGreaterThan(x.box.x1);
    }
    const crowd = await d.detect(imgs.crowd, 0.4);
    expect(crowd.filter((x) => x.label === 'person').length).toBeGreaterThanOrEqual(8);
    const t = Date.now();
    for (let i = 0; i < 3; i++) await d.detect(imgs.street, 0.4);
    console.log(`[throughput] YOLOX-S 640 on 1280px frame: ${Math.round((Date.now() - t) / 3)} ms/frame`);
  });

  it.skipIf(!modelsOk('yunet-face'))('YuNet detects exactly one confident face in a portrait, with 5 landmarks inside the box', async () => {
    const d = new YunetDetector(row('yunet-face'));
    const faces = await d.detect(imgs.portrait, 0.7);
    expect(faces).toHaveLength(1);
    const f = faces[0]!;
    expect(f.confidence).toBeGreaterThan(0.85);
    expect(f.landmarks).toHaveLength(10);
    for (let k = 0; k < 5; k++) {
      expect(f.landmarks![2 * k]!).toBeGreaterThan(f.box.x1);
      expect(f.landmarks![2 * k]!).toBeLessThan(f.box.x2);
    }
    // no faces in a plate close-up
    expect(await d.detect(imgs.plate, 0.7)).toHaveLength(0);
  });

  it.skipIf(!modelsOk('sface-recognition') || !modelsOk('yunet-face'))('SFace: same face at another scale is similar, a different face is not', async () => {
    const det = new YunetDetector(row('yunet-face'));
    const emb = new SfaceEmbedder(row('sface-recognition'));
    const a = (await det.detect(imgs.portrait, 0.7))[0]!;
    const small = resize(imgs.portrait, Math.round(imgs.portrait.width * 0.6), Math.round(imgs.portrait.height * 0.6));
    const b = (await det.detect(small, 0.7))[0]!;
    const ea = await emb.embed(imgs.portrait, a.landmarks!);
    const eb = await emb.embed(small, b.landmarks!);
    expect(ea).toHaveLength(128);
    expect(cosine(ea, eb)).toBeGreaterThan(0.6);
    const others = await det.detect(imgs.street, 0.6);
    for (const o of others.filter((x) => x.box.x2 - x.box.x1 >= 20)) {
      expect(cosine(ea, await emb.embed(imgs.street, o.landmarks!))).toBeLessThan(0.363);
    }
  });

  it.skipIf(!modelsOk('anpr-yolov9t-cct'))('ANPR detects and reads the plate IJZ8992', async () => {
    const d = new AnprDetector(row('anpr-yolov9t-cct'), [{ entryId: 'e1', watchlistId: 'w1', label: 'Stolen Fiesta', plate: 'IJZ8992' }]);
    const plates = await d.detect(imgs.plate, 0.5);
    expect(plates.length).toBeGreaterThanOrEqual(1);
    const best = plates.sort((a, b) => b.confidence - a.confidence)[0]!;
    expect(best.attributes.plateText).toBe('IJZ8992');
    expect(best.label).toBe('IJZ8992');
    expect(best.attributes.watchlistHit).toBe(true);
    expect(best.attributes.watchlistEntryId).toBe('e1');
    expect(Number(best.attributes.plateConfidence)).toBeGreaterThan(0.5);
  });
});

describe('dominant colour', () => {
  const patch = (w: number, h: number, rgb: [number, number, number], noise = 0): RgbImage => {
    const data = new Uint8Array(w * h * 3);
    let seed = 1;
    for (let i = 0; i < w * h; i++) {
      for (let c = 0; c < 3; c++) {
        seed = (seed * 16807) % 2147483647;
        data[i * 3 + c] = Math.max(0, Math.min(255, rgb[c]! + Math.round(((seed / 2147483647) - 0.5) * noise)));
      }
    }
    return { width: w, height: h, data };
  };
  it('names solid synthetic patches and returns their hex colour', () => {
    const red = dominantColor(patch(100, 80, [200, 30, 30], 10), { x1: 0, y1: 0, x2: 100, y2: 80 }, 'whole');
    expect(red.colorName).toBe('red');
    expect(parseInt(red.dominantColor.slice(1, 3), 16)).toBeGreaterThan(185);
    expect(dominantColor(patch(60, 60, [20, 40, 200]), { x1: 0, y1: 0, x2: 60, y2: 60 }, 'whole').colorName).toBe('blue');
    expect(dominantColor(patch(60, 60, [245, 245, 245]), { x1: 0, y1: 0, x2: 60, y2: 60 }, 'whole').colorName).toBe('white');
    expect(dominantColor(patch(60, 60, [10, 10, 10]), { x1: 0, y1: 0, x2: 60, y2: 60 }, 'whole').colorName).toBe('black');
    expect(dominantColor(patch(60, 60, [30, 160, 40]), { x1: 0, y1: 0, x2: 60, y2: 60 }, 'whole')).toMatchObject({ colorName: 'green', dominantColor: '#1ea028' });
  });
  it('uses the majority cluster (70% yellow, 30% black)', () => {
    const img = patch(100, 100, [230, 210, 20]);
    for (let y = 70; y < 100; y++) for (let x = 0; x < 100; x++) img.data.set([0, 0, 0], (y * 100 + x) * 3);
    const c = dominantColor(img, { x1: 0, y1: 0, x2: 100, y2: 100 }, 'whole');
    expect(c.colorName).toBe('yellow');
    expect(c.colorShare).toBeGreaterThan(0.6);
  });
});

describe('IoU tracker dedupe', () => {
  it('keeps one best detection per track per window, splits separate objects and gaps', () => {
    const out: Array<{ trackId: string; conf: number; t: number; n: number }> = [];
    const tr = new IouTracker<null>({ minIou: 0.3, maxGapFrames: 1, keepEveryMs: 5000 }, (e) => out.push({ trackId: e.trackId, conf: e.item.confidence, t: e.item.timeMs, n: e.observations }));
    // object A moves slowly for 12 frames (1 fps) -> windows [0,5s), [5,10s), [10,12s)
    for (let f = 0; f < 12; f++) {
      const items = [{ trackClass: 'person', box: { x1: 10 + f * 2, y1: 10, x2: 60 + f * 2, y2: 110 }, confidence: f === 3 ? 0.95 : 0.6, frameIndex: f, timeMs: f * 1000, payload: null }];
      // object B (different class, overlapping) only in frames 0-2
      if (f < 3) items.push({ trackClass: 'car', box: { x1: 10, y1: 10, x2: 60, y2: 110 }, confidence: 0.7, frameIndex: f, timeMs: f * 1000, payload: null });
      tr.update(f, items);
    }
    // object C reappears after a long gap -> new track
    tr.update(20, [{ trackClass: 'car', box: { x1: 10, y1: 10, x2: 60, y2: 110 }, confidence: 0.8, frameIndex: 20, timeMs: 20000, payload: null }]);
    tr.finish();
    const a = out.filter((o) => o.trackId === out.find((x) => x.conf === 0.95)!.trackId);
    expect(a.map((x) => x.t)).toEqual([3000, 5000, 10000]);
    expect(a[0]!.conf).toBe(0.95);
    expect(a.reduce((s, x) => s + x.n, 0)).toBe(12);
    const cars = out.filter((o) => !a.includes(o));
    expect(cars).toHaveLength(2);
    expect(new Set(cars.map((c) => c.trackId)).size).toBe(2);
    expect(tr.tracksStarted).toBe(3);
  });
});
