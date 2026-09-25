/** Detector factory: ai_models.config.architecture -> implementation. Unknown architectures are rejected (never faked). */
import type { RgbImage } from '../image.js';
import { AnprDetector, type PlateWatch } from './anpr.js';
import { FaceRecognitionDetector, type GalleryEntry } from './sface.js';
import type { Detector, ModelRow, RawDetection } from './types.js';
import { YoloxDetector } from './yolox.js';
import { YunetDetector } from './yunet.js';

export * from './types.js';

/** Memoises detect() per frame image + threshold so dependent tasks share one inference. */
export class MemoDetector implements Detector {
  private cache = new WeakMap<RgbImage, Map<number, Promise<RawDetection[]>>>();
  constructor(readonly inner: Detector) {}
  get task() { return this.inner.task; }
  get modelId() { return this.inner.modelId; }
  get code() { return this.inner.code; }
  get version() { return this.inner.version; }
  load() { return this.inner.load(); }
  detect(frame: RgbImage, threshold: number): Promise<RawDetection[]> {
    let m = this.cache.get(frame);
    if (!m) this.cache.set(frame, (m = new Map()));
    let p = m.get(threshold);
    if (!p) m.set(threshold, (p = this.inner.detect(frame, threshold)));
    return p;
  }
}

/** Filters a shared base detector's output to this model's labels/threshold (e.g. PERSON_DETECTION on the COCO model). */
export class FilteredDetector implements Detector {
  readonly task; readonly modelId; readonly code; readonly version;
  private readonly labels: Set<string> | null;
  constructor(m: ModelRow, private readonly base: Detector, private readonly baseThreshold: () => number) {
    this.task = m.task; this.modelId = m.id; this.code = m.code; this.version = m.version;
    const l = m.config.emitLabels?.length ? m.config.emitLabels : null;
    this.labels = l ? new Set(l) : null;
  }
  load() { return this.base.load(); }
  async detect(frame: RgbImage, threshold: number): Promise<RawDetection[]> {
    const all = await this.base.detect(frame, Math.min(threshold, this.baseThreshold()));
    return all.filter((d) => d.confidence >= threshold && (!this.labels || this.labels.has(d.label)));
  }
}

export function baseDetector(m: ModelRow): Detector {
  switch (m.config.architecture) {
    case 'yolox':
      return new YoloxDetector({ ...m, labels: [], config: { ...m.config, emitLabels: undefined } });
    case 'yunet':
      return new YunetDetector(m);
    default:
      throw new Error(`model ${m.code}@${m.version}: architecture '${m.config.architecture}' cannot be used as a base detector`);
  }
}

export function anprDetector(m: ModelRow, watch: PlateWatch[]): Detector {
  if (m.config.architecture !== 'yolov9-plate+cct-ocr') throw new Error(`model ${m.code}: unsupported ANPR architecture ${m.config.architecture}`);
  return new AnprDetector(m, watch);
}

export function faceRecognitionDetector(m: ModelRow, faceDetector: Detector, gallery: GalleryEntry[], faceThreshold: number): FaceRecognitionDetector {
  if (m.config.architecture !== 'sface') throw new Error(`model ${m.code}: unsupported recognition architecture ${m.config.architecture}`);
  return new FaceRecognitionDetector(m, faceDetector, gallery, faceThreshold);
}
