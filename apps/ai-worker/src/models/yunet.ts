/**
 * YuNet face detector (OpenCV Zoo, MIT). 2023mar export: fixed 640x640 BGR 0..255 input; per-stride outputs
 * cls/obj/bbox/kps decoded exactly as cv::FaceDetectorYN (score = sqrt(cls*obj), bbox exp-encoded, 5 landmarks).
 */
import type { AiTask } from '@ksp/shared';
import { nms, toTensor, type RgbImage } from '../image.js';
import { getSession, ort } from './runtime.js';
import type { Detector, ModelRow, RawDetection } from './types.js';

export class YunetDetector implements Detector {
  readonly task: AiTask;
  readonly modelId: string;
  readonly code: string;
  readonly version: string;
  private session?: ort.InferenceSession;
  private readonly size: number;

  constructor(private readonly m: ModelRow) {
    this.task = m.task;
    this.modelId = m.id;
    this.code = m.code;
    this.version = m.version;
    this.size = m.config.inputWidth ?? 640;
  }

  async load(): Promise<void> {
    this.session = await getSession(this.m.artifact_uri, this.m.artifact_sha256);
  }

  async detect(frame: RgbImage, threshold: number): Promise<RawDetection[]> {
    if (!this.session) await this.load();
    const S = this.size;
    const t = toTensor(frame, { width: S, height: S, mode: 'letterbox-tl', padValue: 0, channelOrder: 'BGR', layout: 'NCHW' });
    const out = await this.session!.run({ [this.session!.inputNames[0]!]: new ort.Tensor('float32', t.data as Float32Array, [1, 3, S, S]) });
    const cands: RawDetection[] = [];
    for (const s of [8, 16, 32]) {
      const cls = out[`cls_${s}`]!.data as Float32Array;
      const obj = out[`obj_${s}`]!.data as Float32Array;
      const bb = out[`bbox_${s}`]!.data as Float32Array;
      const kps = out[`kps_${s}`]!.data as Float32Array;
      const cols = S / s;
      const n = cls.length;
      for (let i = 0; i < n; i++) {
        const c = Math.min(1, Math.max(0, cls[i]!));
        const o = Math.min(1, Math.max(0, obj[i]!));
        const score = Math.sqrt(c * o);
        if (score < threshold) continue;
        const r = Math.floor(i / cols);
        const col = i % cols;
        const cx = (col + bb[i * 4]!) * s;
        const cy = (r + bb[i * 4 + 1]!) * s;
        const w = Math.exp(bb[i * 4 + 2]!) * s;
        const h = Math.exp(bb[i * 4 + 3]!) * s;
        const lm: number[] = [];
        for (let k = 0; k < 5; k++) {
          lm.push(((kps[i * 10 + 2 * k]! + col) * s - t.padX) / t.sx, ((kps[i * 10 + 2 * k + 1]! + r) * s - t.padY) / t.sy);
        }
        const box = {
          x1: Math.max(0, (cx - w / 2 - t.padX) / t.sx),
          y1: Math.max(0, (cy - h / 2 - t.padY) / t.sy),
          x2: Math.min(frame.width, (cx + w / 2 - t.padX) / t.sx),
          y2: Math.min(frame.height, (cy + h / 2 - t.padY) / t.sy),
        };
        if (box.x2 - box.x1 < 4 || box.y2 - box.y1 < 4) continue;
        cands.push({ label: 'face', confidence: score, box, landmarks: lm, attributes: {} });
      }
    }
    return nms(cands, this.m.config.nmsIou ?? 0.3);
  }
}
