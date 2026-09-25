/**
 * SFace face recognition (OpenCV Zoo, Apache-2.0): 5-point similarity alignment to the ArcFace 112x112 template
 * (as cv::FaceRecognizerSF::alignCrop), RGB 0..255 input, 128-d embedding, L2-normalised; cosine similarity.
 */
import type { AiTask } from '@ksp/shared';
import { similarityTransform, toTensor, warpAffine, type RgbImage } from '../image.js';
import { getSession, ort } from './runtime.js';
import type { Detector, ModelRow, RawDetection } from './types.js';

const ARCFACE_TEMPLATE: Array<[number, number]> = [
  [38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041],
];

export interface GalleryEntry {
  entryId: string;
  watchlistId: string;
  label: string;
  embedding: Float32Array;
}

export function l2normalize(v: ArrayLike<number>): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!;
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / n;
  return out;
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

export class SfaceEmbedder {
  private session?: ort.InferenceSession;
  constructor(private readonly m: ModelRow) {}

  async load(): Promise<void> {
    this.session = await getSession(this.m.artifact_uri, this.m.artifact_sha256);
  }

  alignedFace(frame: RgbImage, landmarks: number[]): RgbImage {
    const src: Array<[number, number]> = [];
    for (let k = 0; k < 5; k++) src.push([landmarks[2 * k]!, landmarks[2 * k + 1]!]);
    return warpAffine(frame, similarityTransform(src, ARCFACE_TEMPLATE), 112, 112);
  }

  async embed(frame: RgbImage, landmarks: number[]): Promise<Float32Array> {
    if (!this.session) await this.load();
    const face = this.alignedFace(frame, landmarks);
    const t = toTensor(face, { width: 112, height: 112, mode: 'stretch', channelOrder: 'RGB', layout: 'NCHW' });
    const out = await this.session!.run({ [this.session!.inputNames[0]!]: new ort.Tensor('float32', t.data as Float32Array, [1, 3, 112, 112]) });
    return l2normalize(out[this.session!.outputNames[0]!]!.data as Float32Array);
  }
}

/** Detects faces with the face-detection model, embeds each and reports ONLY watchlist matches (no identity otherwise). */
export class FaceRecognitionDetector implements Detector {
  readonly task: AiTask;
  readonly modelId: string;
  readonly code: string;
  readonly version: string;
  readonly embedder: SfaceEmbedder;

  constructor(
    m: ModelRow,
    private readonly faceDetector: Detector,
    private readonly gallery: GalleryEntry[],
    private readonly faceThreshold: number,
  ) {
    this.task = m.task;
    this.modelId = m.id;
    this.code = m.code;
    this.version = m.version;
    this.embedder = new SfaceEmbedder(m);
  }

  async load(): Promise<void> {
    await Promise.all([this.embedder.load(), this.faceDetector.load()]);
  }

  async detect(frame: RgbImage, threshold: number): Promise<RawDetection[]> {
    if (!this.gallery.length) return [];
    const faces = await this.faceDetector.detect(frame, this.faceThreshold);
    const out: RawDetection[] = [];
    for (const f of faces) {
      if (!f.landmarks || f.box.x2 - f.box.x1 < 20) continue; // too small for a meaningful comparison
      const emb = await this.embedder.embed(frame, f.landmarks);
      let best: GalleryEntry | null = null;
      let bestSim = -1;
      for (const g of this.gallery) {
        const sim = cosine(emb, g.embedding);
        if (sim > bestSim) { bestSim = sim; best = g; }
      }
      if (!best || bestSim < threshold) continue;
      out.push({
        label: best.label,
        confidence: Math.max(0, Math.min(1, bestSim)),
        box: f.box,
        landmarks: f.landmarks,
        embedding: Array.from(emb),
        trackClass: `entry:${best.entryId}`,
        attributes: { watchlistEntryId: best.entryId, watchlistId: best.watchlistId, similarity: Math.round(bestSim * 10000) / 10000, faceConfidence: Math.round(f.confidence * 10000) / 10000 },
      });
    }
    return out;
  }
}
