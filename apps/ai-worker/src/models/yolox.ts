/**
 * YOLOX (Megvii, Apache-2.0) COCO detector. Official ONNX exports output undecoded grid predictions
 * [1, N, 85] = (cx, cy, logw, logh, obj, 80 class probs); preprocessing = BGR, 0..255, top-left letterbox pad 114.
 */
import type { AiTask } from '@ksp/shared';
import { nms, toTensor, type RgbImage } from '../image.js';
import { dominantColor } from '../color.js';
import { getSession, ort } from './runtime.js';
import type { Detector, ModelRow, RawDetection } from './types.js';

export const COCO_LABELS = [
  'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat', 'traffic light', 'fire hydrant',
  'stop sign', 'parking meter', 'bench', 'bird', 'cat', 'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra',
  'giraffe', 'backpack', 'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee', 'skis', 'snowboard', 'sports ball', 'kite',
  'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket', 'bottle', 'wine glass', 'cup', 'fork',
  'knife', 'spoon', 'bowl', 'banana', 'apple', 'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut',
  'cake', 'chair', 'couch', 'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse', 'remote',
  'keyboard', 'cell phone', 'microwave', 'oven', 'toaster', 'sink', 'refrigerator', 'book', 'clock', 'vase', 'scissors',
  'teddy bear', 'hair drier', 'toothbrush',
];

export class YoloxDetector implements Detector {
  readonly task: AiTask;
  readonly modelId: string;
  readonly code: string;
  readonly version: string;
  private session?: ort.InferenceSession;
  private readonly size: number;
  private readonly emit: Set<string> | null;
  private readonly colorLabels: Set<string>;
  private grid?: { gx: Int32Array; gy: Int32Array; stride: Int32Array };

  constructor(private readonly m: ModelRow) {
    this.task = m.task;
    this.modelId = m.id;
    this.code = m.code;
    this.version = m.version;
    this.size = m.config.inputWidth ?? 640;
    this.emit = m.config.emitLabels?.length ? new Set(m.config.emitLabels) : m.labels.length ? new Set(m.labels) : null;
    this.colorLabels = new Set(m.config.colorLabels ?? []);
  }

  async load(): Promise<void> {
    this.session = await getSession(this.m.artifact_uri, this.m.artifact_sha256);
    const n = [8, 16, 32].reduce((acc, s) => acc + (this.size / s) ** 2, 0);
    const gx = new Int32Array(n), gy = new Int32Array(n), stride = new Int32Array(n);
    let i = 0;
    for (const s of [8, 16, 32]) {
      const g = this.size / s;
      for (let y = 0; y < g; y++) for (let x = 0; x < g; x++, i++) { gx[i] = x; gy[i] = y; stride[i] = s; }
    }
    this.grid = { gx, gy, stride };
  }

  async detect(frame: RgbImage, threshold: number): Promise<RawDetection[]> {
    if (!this.session || !this.grid) await this.load();
    const S = this.size;
    const t = toTensor(frame, { width: S, height: S, mode: 'letterbox-tl', padValue: 114, channelOrder: 'BGR', layout: 'NCHW' });
    const input = new ort.Tensor('float32', t.data as Float32Array, [1, 3, S, S]);
    const out = await this.session!.run({ [this.session!.inputNames[0]!]: input });
    const o = out[this.session!.outputNames[0]!]!.data as Float32Array;
    const { gx, gy, stride } = this.grid!;
    const n = gx.length;
    const C = 85;
    const cands: RawDetection[] = [];
    for (let i = 0; i < n; i++) {
      const base = i * C;
      const obj = o[base + 4]!;
      if (obj < threshold) continue;
      let best = 0;
      let bestC = -1;
      for (let c = 0; c < 80; c++) {
        const p = o[base + 5 + c]!;
        if (p > best) { best = p; bestC = c; }
      }
      const score = obj * best;
      if (score < threshold || bestC < 0) continue;
      const label = COCO_LABELS[bestC]!;
      if (this.emit && !this.emit.has(label)) continue;      const s = stride[i]!;
      const cx = (o[base]! + gx[i]!) * s;
      const cy = (o[base + 1]! + gy[i]!) * s;
      const w = Math.exp(o[base + 2]!) * s;
      const h = Math.exp(o[base + 3]!) * s;
      const box = {
        x1: Math.max(0, (cx - w / 2 - t.padX) / t.sx),
        y1: Math.max(0, (cy - h / 2 - t.padY) / t.sy),
        x2: Math.min(frame.width, (cx + w / 2 - t.padX) / t.sx),
        y2: Math.min(frame.height, (cy + h / 2 - t.padY) / t.sy),
      };
      if (box.x2 - box.x1 < 2 || box.y2 - box.y1 < 2) continue;
      cands.push({ label, confidence: Math.min(1, score), box, attributes: { cocoClass: bestC } });
    }
    // class-wise NMS
    const byLabel = new Map<string, RawDetection[]>();
    for (const d of cands) byLabel.set(d.label, [...(byLabel.get(d.label) ?? []), d]);
    const kept: RawDetection[] = [];
    for (const list of byLabel.values()) kept.push(...nms(list, this.m.config.nmsIou ?? 0.45));
    for (const d of kept) {
      if (this.colorLabels.has(d.label)) Object.assign(d.attributes, dominantColor(frame, d.box, d.label === 'person' ? 'person' : 'object'));
    }
    return kept;
  }
}
