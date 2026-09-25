/**
 * ANPR = licence-plate detector (open-image-models YOLOv9-t end2end ONNX, MIT) + plate OCR (fast-plate-ocr CCT, MIT).
 * Detector: centred letterbox (pad 114), RGB /255, NCHW; output rows (batch, x1, y1, x2, y2, class, score) after NMS.
 * OCR: plate crop stretched to 128x64 RGB uint8 NHWC; output [1, slots, |alphabet|] per-slot probabilities.
 */
import { normalizePlate, type AiTask } from '@ksp/shared';
import { crop, resize, toTensor, type RgbImage } from '../image.js';
import { getSession, ort } from './runtime.js';
import type { Detector, ModelRow, RawDetection } from './types.js';

export interface PlateWatch {
  entryId: string;
  watchlistId: string;
  label: string;
  plate: string;
}

export class AnprDetector implements Detector {
  readonly task: AiTask;
  readonly modelId: string;
  readonly code: string;
  readonly version: string;
  private det?: ort.InferenceSession;
  private ocr?: ort.InferenceSession;
  private readonly size: number;

  constructor(private readonly m: ModelRow, private readonly watch: PlateWatch[] = []) {
    this.task = m.task;
    this.modelId = m.id;
    this.code = m.code;
    this.version = m.version;
    this.size = m.config.inputWidth ?? 384;
    if (!m.config.ocr) throw new Error(`ANPR model ${m.code} has no OCR sub-model configured`);
  }

  async load(): Promise<void> {
    const o = this.m.config.ocr!;
    [this.det, this.ocr] = await Promise.all([getSession(this.m.artifact_uri, this.m.artifact_sha256), getSession(o.artifactUri, o.sha256)]);
  }

  async readPlate(plate: RgbImage): Promise<{ text: string; confidence: number; slots: number[] }> {
    if (!this.ocr) await this.load();
    const o = this.m.config.ocr!;
    const img = resize(plate, o.inputWidth, o.inputHeight);
    const input = new ort.Tensor('uint8', img.data, [1, o.inputHeight, o.inputWidth, 3]);
    const out = await this.ocr!.run({ [this.ocr!.inputNames[0]!]: input });
    const probs = out[this.ocr!.outputNames[0]!]!.data as Float32Array;
    const A = o.alphabet.length;
    let text = '';
    const slotConf: number[] = [];
    for (let s = 0; s < o.slots; s++) {
      let best = 0, bi = 0;
      for (let a = 0; a < A; a++) {
        const p = probs[s * A + a]!;
        if (p > best) { best = p; bi = a; }
      }
      const ch = o.alphabet[bi]!;
      if (ch !== o.padChar) {
        text += ch;
        slotConf.push(best);
      }
    }
    const confidence = slotConf.length ? Math.min(...slotConf) : 0;
    return { text: normalizePlate(text), confidence, slots: slotConf.map((c) => Math.round(c * 1000) / 1000) };
  }

  async detect(frame: RgbImage, threshold: number): Promise<RawDetection[]> {
    if (!this.det) await this.load();
    const S = this.size;
    const t = toTensor(frame, { width: S, height: S, mode: 'letterbox-center', padValue: 114, channelOrder: 'RGB', layout: 'NCHW', scale: 1 / 255 });
    const out = await this.det!.run({ [this.det!.inputNames[0]!]: new ort.Tensor('float32', t.data as Float32Array, [1, 3, S, S]) });
    const rows = out[this.det!.outputNames[0]!]!;
    const d = rows.data as Float32Array;
    const n = rows.dims[0] ?? 0;
    const res: RawDetection[] = [];
    for (let i = 0; i < n; i++) {
      const score = d[i * 7 + 6]!;
      if (score < threshold) continue;
      const box = {
        x1: Math.max(0, (d[i * 7 + 1]! - t.padX) / t.sx),
        y1: Math.max(0, (d[i * 7 + 2]! - t.padY) / t.sy),
        x2: Math.min(frame.width, (d[i * 7 + 3]! - t.padX) / t.sx),
        y2: Math.min(frame.height, (d[i * 7 + 4]! - t.padY) / t.sy),
      };
      if (box.x2 - box.x1 < 8 || box.y2 - box.y1 < 4) continue;
      const read = await this.readPlate(crop(frame, box, 0.04));
      const hit = read.text ? this.watch.find((w) => w.plate === read.text) : undefined;
      res.push({
        label: read.text || 'plate',
        confidence: Math.min(1, score),
        box,
        trackClass: 'plate',
        attributes: {
          plateText: read.text || null,
          plateConfidence: Math.round(read.confidence * 1000) / 1000,
          plateSlotConfidence: read.slots,
          ...(hit ? { watchlistHit: true, watchlistEntryId: hit.entryId, watchlistId: hit.watchlistId, watchlistLabel: hit.label } : {}),
        },
      });
    }
    return res;
  }
}
